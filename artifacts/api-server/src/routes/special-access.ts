import { Router, type IRouter } from "express";
import {
  db,
  specialAccessTable,
  specialAccessUsageTable,
  usersTable,
} from "@workspace/db";
import { eq, desc, count, sum } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

function param(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

const VALID_REASONS = ["influencer", "testing", "promotion", "vip", "other"] as const;
type Reason = (typeof VALID_REASONS)[number];

function isValidReason(v: unknown): v is Reason {
  return typeof v === "string" && (VALID_REASONS as readonly string[]).includes(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function parseDateOrNull(v: unknown): Date | null | "invalid" {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return "invalid";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

interface BuildExtras {
  userName?: string | null;
  userEmail?: string | null;
  usageCount?: number;
  estimatedRevenueImpactCents?: number;
}

function buildEntry(s: typeof specialAccessTable.$inferSelect, extras: BuildExtras = {}) {
  return {
    id: s.id,
    userId: s.userId,
    userName: extras.userName ?? null,
    userEmail: extras.userEmail ?? null,
    canGenerateVideos: s.canGenerateVideos,
    canCinemaMode: s.canCinemaMode,
    freeVideoGeneration: s.freeVideoGeneration,
    unlimitedUsage: s.unlimitedUsage,
    allLanguagesAccess: s.allLanguagesAccess,
    premiumFeaturesUnlock: s.premiumFeaturesUnlock,
    canUseCharacterIdentity: s.canUseCharacterIdentity,
    isActive: s.isActive,
    reason: s.reason,
    notes: s.notes ?? null,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    grantedByUserId: s.grantedByUserId ?? null,
    grantedAt: s.grantedAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    usageCount: extras.usageCount ?? 0,
    estimatedRevenueImpactCents: extras.estimatedRevenueImpactCents ?? 0,
  };
}

// =========================================================
// USER: GET MY SPECIAL ACCESS
// =========================================================
router.get("/me/special-access", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [entry] = await db
    .select()
    .from(specialAccessTable)
    .where(eq(specialAccessTable.userId, userId))
    .limit(1);

  if (!entry) {
    res.json({ hasSpecialAccess: false, entry: null });
    return;
  }
  // Honor expiry and active flag
  const now = new Date();
  const isLive = entry.isActive && (!entry.expiresAt || entry.expiresAt > now);
  res.json({
    hasSpecialAccess: isLive,
    entry: buildEntry(entry),
  });
});

// =========================================================
// ADMIN: LIST ALL SPECIAL ACCESS
// =========================================================
router.get("/admin/special-access", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "all";
  let where;
  if (status === "active") where = eq(specialAccessTable.isActive, true);
  else if (status === "inactive") where = eq(specialAccessTable.isActive, false);

  const rows = await db
    .select({
      s: specialAccessTable,
      userName: usersTable.name,
      userEmail: usersTable.email,
    })
    .from(specialAccessTable)
    .leftJoin(usersTable, eq(usersTable.id, specialAccessTable.userId))
    .where(where)
    .orderBy(desc(specialAccessTable.grantedAt));

  // Aggregate usage per user
  const usageRows = await db
    .select({
      userId: specialAccessUsageTable.userId,
      count: count(specialAccessUsageTable.id),
      total: sum(specialAccessUsageTable.estimatedValueCents),
    })
    .from(specialAccessUsageTable)
    .groupBy(specialAccessUsageTable.userId);

  const usageMap = new Map<string, { count: number; total: number }>();
  for (const u of usageRows) {
    usageMap.set(u.userId, { count: u.count, total: Number(u.total ?? 0) });
  }

  res.json(
    rows.map((r) => {
      const u = usageMap.get(r.s.userId);
      return buildEntry(r.s, {
        userName: r.userName,
        userEmail: r.userEmail,
        usageCount: u?.count ?? 0,
        estimatedRevenueImpactCents: u?.total ?? 0,
      });
    })
  );
});

// =========================================================
// ADMIN: GRANT SPECIAL ACCESS
// =========================================================
router.post("/admin/special-access", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const { userId, canGenerateVideos, canCinemaMode, freeVideoGeneration, unlimitedUsage, allLanguagesAccess, premiumFeaturesUnlock, canUseCharacterIdentity, reason, notes, expiresAt } = body;

  if (!isUuid(userId)) {
    res.status(400).json({ error: "userId must be a valid UUID" });
    return;
  }
  // Verify user exists
  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  // Check for existing entry (unique constraint)
  const [existing] = await db.select({ id: specialAccessTable.id }).from(specialAccessTable).where(eq(specialAccessTable.userId, userId)).limit(1);
  if (existing) {
    res.status(400).json({ error: "User already has a special-access entry. Use PATCH to modify." });
    return;
  }
  if (reason !== undefined && !isValidReason(reason)) {
    res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(", ")}` });
    return;
  }
  let expiresAtVal: Date | null = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    const parsed = parseDateOrNull(expiresAt);
    if (parsed === "invalid") {
      res.status(400).json({ error: "expiresAt must be a valid ISO date or null" });
      return;
    }
    expiresAtVal = parsed;
  }
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 2000)) {
    res.status(400).json({ error: "notes must be a string up to 2000 chars" });
    return;
  }

  const [created] = await db
    .insert(specialAccessTable)
    .values({
      userId,
      canGenerateVideos: typeof canGenerateVideos === "boolean" ? canGenerateVideos : false,
      canCinemaMode: typeof canCinemaMode === "boolean" ? canCinemaMode : false,
      freeVideoGeneration: typeof freeVideoGeneration === "boolean" ? freeVideoGeneration : false,
      unlimitedUsage: typeof unlimitedUsage === "boolean" ? unlimitedUsage : false,
      allLanguagesAccess: typeof allLanguagesAccess === "boolean" ? allLanguagesAccess : false,
      premiumFeaturesUnlock: typeof premiumFeaturesUnlock === "boolean" ? premiumFeaturesUnlock : false,
      canUseCharacterIdentity: typeof canUseCharacterIdentity === "boolean" ? canUseCharacterIdentity : false,
      isActive: true,
      reason: isValidReason(reason) ? reason : "vip",
      notes: typeof notes === "string" ? notes : null,
      expiresAt: expiresAtVal,
      grantedByUserId: req.user?.userId,
    })
    .returning();

  // Fetch user info for response
  const [u] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  res.status(201).json(buildEntry(created!, { userName: u?.name, userEmail: u?.email }));
});

// =========================================================
// ADMIN: UPDATE / TOGGLE SPECIAL ACCESS
// =========================================================
router.patch("/admin/special-access/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = param(req.params.id);
  const body = req.body as Record<string, unknown>;
  const updates: Partial<typeof specialAccessTable.$inferInsert> = {};

  for (const k of ["canGenerateVideos", "canCinemaMode", "freeVideoGeneration", "unlimitedUsage", "allLanguagesAccess", "premiumFeaturesUnlock", "canUseCharacterIdentity", "isActive"] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== "boolean") {
        res.status(400).json({ error: `${k} must be boolean` });
        return;
      }
      updates[k] = body[k] as boolean;
    }
  }
  if (body.reason !== undefined) {
    if (!isValidReason(body.reason)) {
      res.status(400).json({ error: `reason must be one of: ${VALID_REASONS.join(", ")}` });
      return;
    }
    updates.reason = body.reason;
  }
  if (body.notes !== undefined) {
    if (body.notes !== null && (typeof body.notes !== "string" || body.notes.length > 2000)) {
      res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      return;
    }
    updates.notes = body.notes as string | null;
  }
  if (body.expiresAt !== undefined) {
    const parsed = parseDateOrNull(body.expiresAt);
    if (parsed === "invalid") {
      res.status(400).json({ error: "expiresAt must be a valid ISO date or null" });
      return;
    }
    updates.expiresAt = parsed;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db.update(specialAccessTable).set(updates).where(eq(specialAccessTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Special access entry not found" });
    return;
  }
  const [u] = await db.select({ name: usersTable.name, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, updated.userId)).limit(1);
  res.json(buildEntry(updated, { userName: u?.name, userEmail: u?.email }));
});

// =========================================================
// ADMIN: REVOKE
// =========================================================
router.delete("/admin/special-access/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = param(req.params.id);
  await db.delete(specialAccessTable).where(eq(specialAccessTable.id, id));
  res.status(204).send();
});

// =========================================================
// ADMIN: STATS / TRACKING DASHBOARD
// =========================================================
router.get("/admin/special-access/stats", requireAuth, requireRole("super_admin"), async (_req, res): Promise<void> => {
  const [totalRow] = await db.select({ c: count() }).from(specialAccessTable);
  const [activeRow] = await db.select({ c: count() }).from(specialAccessTable).where(eq(specialAccessTable.isActive, true));
  const [inactiveRow] = await db.select({ c: count() }).from(specialAccessTable).where(eq(specialAccessTable.isActive, false));
  const [usageRow] = await db.select({ c: count() }).from(specialAccessUsageTable);
  const [revenueRow] = await db.select({ s: sum(specialAccessUsageTable.estimatedValueCents) }).from(specialAccessUsageTable);

  const reasonRows = await db
    .select({
      reason: specialAccessTable.reason,
      c: count(),
    })
    .from(specialAccessTable)
    .groupBy(specialAccessTable.reason);

  const topUsers = await db
    .select({
      userId: specialAccessUsageTable.userId,
      userName: usersTable.name,
      userEmail: usersTable.email,
      usageCount: count(specialAccessUsageTable.id),
      estimatedValueCents: sum(specialAccessUsageTable.estimatedValueCents),
    })
    .from(specialAccessUsageTable)
    .leftJoin(usersTable, eq(usersTable.id, specialAccessUsageTable.userId))
    .groupBy(specialAccessUsageTable.userId, usersTable.name, usersTable.email)
    .orderBy(desc(count(specialAccessUsageTable.id)))
    .limit(10);

  res.json({
    totalUsersWithAccess: totalRow?.c ?? 0,
    activeUsers: activeRow?.c ?? 0,
    inactiveUsers: inactiveRow?.c ?? 0,
    totalUsageActions: usageRow?.c ?? 0,
    estimatedRevenueImpactCents: Number(revenueRow?.s ?? 0),
    byReason: reasonRows.map((r) => ({ reason: r.reason, count: r.c })),
    topUsers: topUsers.map((t) => ({
      userId: t.userId,
      userName: t.userName ?? null,
      userEmail: t.userEmail ?? null,
      usageCount: t.usageCount,
      estimatedValueCents: Number(t.estimatedValueCents ?? 0),
    })),
  });
});

export default router;
