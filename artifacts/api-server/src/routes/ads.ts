import { Router } from "express";
import { db } from "@workspace/db";
import { adsTable, adEventsTable, platformSettingsTable, specialAccessTable } from "@workspace/db/schema";
import { eq, and, lte, gte, or, isNull, desc, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { AdminCreateAdBody } from "@workspace/api-zod";

const router = Router();

async function isAdSystemEnabled(): Promise<boolean> {
  const [row] = await db
    .select()
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, "ads_enabled"));
  return row?.value === "true";
}

async function isUserAdExempt(userId: string, userRole: string): Promise<boolean> {
  if (userRole === "admin" || userRole === "super_admin") return true;

  const [access] = await db
    .select()
    .from(specialAccessTable)
    .where(
      and(
        eq(specialAccessTable.userId, userId),
        eq(specialAccessTable.isActive, true),
        or(
          eq(specialAccessTable.premiumFeaturesUnlock, true),
          eq(specialAccessTable.unlimitedUsage, true)
        )
      )
    );
  return !!access;
}

// GET /api/ads?placement=...
router.get("/ads", requireAuth, async (req, res): Promise<void> => {
  try {
    const adsOn = await isAdSystemEnabled();
    if (!adsOn) {
      res.json([]);
      return;
    }

    const userId = req.user!.userId;
    const userRole = req.user!.role;
    const exempt = await isUserAdExempt(userId, userRole);
    if (exempt) {
      res.json([]);
      return;
    }

    const { placement } = req.query as { placement?: string };
    const now = new Date();

    const conditions = [
      or(eq(adsTable.status, "active"), and(eq(adsTable.status, "scheduled"), lte(adsTable.scheduledAt, now))),
      or(isNull(adsTable.expiresAt), gte(adsTable.expiresAt, now)),
    ] as const;

    const rows = placement && ["sidebar", "gallery", "dashboard", "top_banner"].includes(placement)
      ? await db
          .select()
          .from(adsTable)
          .where(and(...conditions, eq(adsTable.placement, placement as "sidebar" | "gallery" | "dashboard" | "top_banner")))
          .orderBy(desc(adsTable.createdAt))
      : await db
          .select()
          .from(adsTable)
          .where(and(...conditions))
          .orderBy(desc(adsTable.createdAt));

    res.json(rows);
  } catch (err) {
    req.log.error(err, "Failed to list ads");
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/ads/:id/impression
router.post("/ads/:id/impression", requireAuth, async (req, res): Promise<void> => {
  try {
    const id = req.params.id as string;
    await db
      .update(adsTable)
      .set({ impressions: sql`${adsTable.impressions} + 1` })
      .where(eq(adsTable.id, id));

    await db.insert(adEventsTable).values({
      adId: id,
      eventType: "impression",
      userId: req.user!.userId,
    });

    res.json({ message: "recorded" });
  } catch (err) {
    req.log.error(err, "Failed to record impression");
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/ads/:id/click
router.post("/ads/:id/click", requireAuth, async (req, res): Promise<void> => {
  try {
    const id = req.params.id as string;
    await db
      .update(adsTable)
      .set({ clicks: sql`${adsTable.clicks} + 1` })
      .where(eq(adsTable.id, id));

    await db.insert(adEventsTable).values({
      adId: id,
      eventType: "click",
      userId: req.user!.userId,
    });

    res.json({ message: "recorded" });
  } catch (err) {
    req.log.error(err, "Failed to record click");
    res.status(500).json({ error: "internal_error" });
  }
});

// ADMIN ROUTES

// GET /api/admin/ads
router.get("/admin/ads", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    const ads = await db.select().from(adsTable).orderBy(desc(adsTable.createdAt));
    res.json(ads);
  } catch (err) {
    req.log.error(err, "Failed to list admin ads");
    res.status(500).json({ error: "internal_error" });
  }
});

// POST /api/admin/ads
router.post("/admin/ads", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    const data = AdminCreateAdBody.parse(req.body);
    const [ad] = await db
      .insert(adsTable)
      .values({
        ...data,
        ctaText: data.ctaText ?? "Learn More",
        status: data.status ?? "draft",
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        createdByUserId: req.user!.userId,
      })
      .returning();
    res.status(201).json(ad);
  } catch (err) {
    req.log.error(err, "Failed to create ad");
    res.status(400).json({ error: "invalid_request" });
  }
});

// PUT /api/admin/ads/:id
router.put("/admin/ads/:id", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    const id = req.params.id as string;
    const data = AdminCreateAdBody.parse(req.body);
    const [ad] = await db
      .update(adsTable)
      .set({
        ...data,
        ctaText: data.ctaText ?? "Learn More",
        status: data.status ?? "draft",
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        updatedAt: new Date(),
      })
      .where(eq(adsTable.id, id))
      .returning();

    if (!ad) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(ad);
  } catch (err) {
    req.log.error(err, "Failed to update ad");
    res.status(400).json({ error: "invalid_request" });
  }
});

// DELETE /api/admin/ads/:id
router.delete("/admin/ads/:id", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    const id = req.params.id as string;
    await db.delete(adsTable).where(eq(adsTable.id, id));
    res.json({ message: "deleted" });
  } catch (err) {
    req.log.error(err, "Failed to delete ad");
    res.status(500).json({ error: "internal_error" });
  }
});

// GET /api/admin/ads/:id/analytics
router.get("/admin/ads/:id/analytics", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  try {
    const id = req.params.id as string;
    const [ad] = await db.select().from(adsTable).where(eq(adsTable.id, id));
    if (!ad) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const dailyStats = await db
      .select({
        date: sql<string>`date_trunc('day', ${adEventsTable.createdAt})::date::text`,
        impressions: sql<number>`count(*) filter (where ${adEventsTable.eventType} = 'impression')::int`,
        clicks: sql<number>`count(*) filter (where ${adEventsTable.eventType} = 'click')::int`,
      })
      .from(adEventsTable)
      .where(
        and(
          eq(adEventsTable.adId, id),
          gte(adEventsTable.createdAt, sql`now() - interval '14 days'`)
        )
      )
      .groupBy(sql`date_trunc('day', ${adEventsTable.createdAt})`)
      .orderBy(sql`date_trunc('day', ${adEventsTable.createdAt})`);

    const ctr = ad.impressions > 0 ? ad.clicks / ad.impressions : 0;

    res.json({
      adId: ad.id,
      title: ad.title,
      impressions: ad.impressions,
      clicks: ad.clicks,
      ctr,
      dailyStats,
    });
  } catch (err) {
    req.log.error(err, "Failed to get ad analytics");
    res.status(500).json({ error: "internal_error" });
  }
});

export default router;
