import { Router, type IRouter } from "express";
import {
  db,
  offersTable,
  offerRedemptionsTable,
} from "@workspace/db";
import { eq, and, sql, desc, count, lte, gte } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

function param(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

const VALID_DISCOUNT_TYPES = ["percentage", "fixed"] as const;
type DiscountType = (typeof VALID_DISCOUNT_TYPES)[number];

function isNonEmptyString(v: unknown, max = 500): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}
function isPositiveInt(v: unknown): v is number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n);
}
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isValidDiscountType(v: unknown): v is DiscountType {
  return typeof v === "string" && (VALID_DISCOUNT_TYPES as readonly string[]).includes(v);
}

function buildOffer(o: typeof offersTable.$inferSelect) {
  const now = new Date();
  return {
    id: o.id,
    code: o.code ?? null,
    name: o.name,
    description: o.description ?? null,
    discountType: o.discountType,
    discountValue: o.discountValue,
    applicablePlans: Array.isArray(o.applicablePlans) ? o.applicablePlans : [],
    startsAt: o.startsAt.toISOString(),
    endsAt: o.endsAt.toISOString(),
    maxUses: o.maxUses ?? null,
    usedCount: o.usedCount,
    isActive: o.isActive,
    isExpired: o.endsAt < now,
    isExhausted: o.maxUses !== null && o.usedCount >= o.maxUses,
    createdByUserId: o.createdByUserId ?? null,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}

// =========================================================
// USER: REDEEM CODE
// =========================================================
router.post("/offers/redeem", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { code, plan } = req.body as { code?: unknown; plan?: unknown };
  if (!isNonEmptyString(code, 100)) {
    res.status(400).json({ error: "code is required" });
    return;
  }
  const planStr = typeof plan === "string" && plan.length > 0 && plan.length <= 100 ? plan : null;
  const normalizedCode = code.trim().toUpperCase();

  // Look up the offer (preliminary check for fast 404 / friendly errors)
  const [offer] = await db
    .select()
    .from(offersTable)
    .where(eq(offersTable.code, normalizedCode))
    .limit(1);

  if (!offer) {
    res.status(404).json({ error: "Code not found" });
    return;
  }

  const now = new Date();
  if (!offer.isActive) {
    res.status(400).json({ error: "Offer is not active" });
    return;
  }
  if (offer.startsAt > now) {
    res.status(400).json({ error: "Offer has not started yet" });
    return;
  }
  if (offer.endsAt < now) {
    res.status(400).json({ error: "Offer has expired" });
    return;
  }
  if (planStr && Array.isArray(offer.applicablePlans) && offer.applicablePlans.length > 0 && !offer.applicablePlans.includes(planStr)) {
    res.status(400).json({ error: `Offer not applicable to plan "${planStr}"` });
    return;
  }

  // Atomic claim: insert redemption row first; the unique (offer_id, user_id)
  // constraint stops duplicate-user races. Then conditionally increment
  // used_count only if max_uses not yet reached. If the cap is hit, roll back.
  try {
    await db.transaction(async (tx) => {
      try {
        await tx.insert(offerRedemptionsTable).values({
          offerId: offer.id,
          userId,
          planApplied: planStr,
        });
      } catch (err: any) {
        // node-postgres surfaces unique-violation as code 23505. Drizzle may
        // wrap the original pg error; check err.code, err.cause.code, and the
        // unique index name in the message as fallbacks.
        const code = err?.code ?? err?.cause?.code ?? err?.original?.code;
        const msg = String(err?.message ?? "") + " " + String(err?.cause?.message ?? "");
        if (code === "23505" || msg.includes("offer_redemptions_offer_user_unique")) {
          throw new Error("ALREADY_REDEEMED");
        }
        throw err;
      }

      const updated = await tx
        .update(offersTable)
        .set({ usedCount: sql`${offersTable.usedCount} + 1` })
        .where(
          and(
            eq(offersTable.id, offer.id),
            sql`(${offersTable.maxUses} IS NULL OR ${offersTable.usedCount} < ${offersTable.maxUses})`,
            eq(offersTable.isActive, true),
            lte(offersTable.startsAt, now),
            gte(offersTable.endsAt, now),
          )
        )
        .returning({ id: offersTable.id });

      if (updated.length === 0) {
        throw new Error("LIMIT_OR_STATUS");
      }
    });
  } catch (err: any) {
    if (err?.message === "ALREADY_REDEEMED") {
      res.status(400).json({ error: "You have already redeemed this offer" });
      return;
    }
    if (err?.message === "LIMIT_OR_STATUS") {
      res.status(400).json({ error: "Offer no longer available (limit reached or status changed)" });
      return;
    }
    throw err;
  }

  res.json({
    success: true,
    offerId: offer.id,
    offerName: offer.name,
    discountType: offer.discountType,
    discountValue: offer.discountValue,
    message: `Code applied: ${offer.discountType === "percentage" ? `${offer.discountValue}% off` : `${offer.discountValue} off`}`,
  });
});

// =========================================================
// ADMIN: LIST OFFERS
// =========================================================
router.get("/admin/offers", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "all";
  const now = new Date();
  let where;
  if (status === "active") {
    where = and(eq(offersTable.isActive, true), gte(offersTable.endsAt, now), lte(offersTable.startsAt, now));
  } else if (status === "inactive") {
    where = eq(offersTable.isActive, false);
  } else if (status === "expired") {
    where = lte(offersTable.endsAt, now);
  }
  const rows = await db
    .select()
    .from(offersTable)
    .where(where)
    .orderBy(desc(offersTable.createdAt));
  res.json(rows.map(buildOffer));
});

// =========================================================
// ADMIN: CREATE OFFER
// =========================================================
router.post("/admin/offers", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const { code, name, description, discountType, discountValue, applicablePlans, startsAt, endsAt, maxUses, isActive } =
    req.body as Record<string, unknown>;

  if (!isNonEmptyString(name, 200)) {
    res.status(400).json({ error: "name is required (1-200 chars)" });
    return;
  }
  if (!isValidDiscountType(discountType)) {
    res.status(400).json({ error: "discountType must be 'percentage' or 'fixed'" });
    return;
  }
  if (!isPositiveInt(discountValue)) {
    res.status(400).json({ error: "discountValue must be a non-negative integer" });
    return;
  }
  if (discountType === "percentage" && (discountValue as number) > 100) {
    res.status(400).json({ error: "Percentage discount cannot exceed 100" });
    return;
  }
  const start = parseDate(startsAt);
  const end = parseDate(endsAt);
  if (!start || !end) {
    res.status(400).json({ error: "startsAt and endsAt must be valid ISO dates" });
    return;
  }
  if (end <= start) {
    res.status(400).json({ error: "endsAt must be after startsAt" });
    return;
  }
  if (!Array.isArray(applicablePlans) || !applicablePlans.every((p) => typeof p === "string")) {
    res.status(400).json({ error: "applicablePlans must be an array of strings" });
    return;
  }
  let codeStr: string | null = null;
  if (code !== undefined && code !== null && code !== "") {
    if (!isNonEmptyString(code, 100)) {
      res.status(400).json({ error: "code must be a non-empty string up to 100 chars" });
      return;
    }
    codeStr = (code as string).trim().toUpperCase();
    const [conflict] = await db.select({ id: offersTable.id }).from(offersTable).where(eq(offersTable.code, codeStr)).limit(1);
    if (conflict) {
      res.status(400).json({ error: "Code already exists" });
      return;
    }
  }
  let maxUsesVal: number | null = null;
  if (maxUses !== undefined && maxUses !== null) {
    if (!isPositiveInt(maxUses) || (maxUses as number) < 1) {
      res.status(400).json({ error: "maxUses must be a positive integer" });
      return;
    }
    maxUsesVal = maxUses as number;
  }

  const [created] = await db
    .insert(offersTable)
    .values({
      code: codeStr,
      name: (name as string).trim(),
      description: typeof description === "string" ? description : null,
      discountType: discountType as DiscountType,
      discountValue: discountValue as number,
      applicablePlans: applicablePlans as string[],
      startsAt: start,
      endsAt: end,
      maxUses: maxUsesVal,
      isActive: typeof isActive === "boolean" ? isActive : true,
      createdByUserId: req.user?.userId,
    })
    .returning();
  res.status(201).json(buildOffer(created!));
});

// =========================================================
// ADMIN: UPDATE OFFER
// =========================================================
router.patch("/admin/offers/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = param(req.params.id);
  const body = req.body as Record<string, unknown>;
  const updates: Partial<typeof offersTable.$inferInsert> = {};

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name, 200)) {
      res.status(400).json({ error: "name must be 1-200 chars" });
      return;
    }
    updates.name = (body.name as string).trim();
  }
  if (body.description !== undefined) {
    updates.description = typeof body.description === "string" ? body.description : null;
  }
  if (body.code !== undefined) {
    if (body.code === null || body.code === "") {
      updates.code = null;
    } else if (isNonEmptyString(body.code, 100)) {
      const newCode = (body.code as string).trim().toUpperCase();
      const [conflict] = await db
        .select({ id: offersTable.id })
        .from(offersTable)
        .where(and(eq(offersTable.code, newCode), sql`${offersTable.id} != ${id}`))
        .limit(1);
      if (conflict) {
        res.status(400).json({ error: "Code already exists" });
        return;
      }
      updates.code = newCode;
    } else {
      res.status(400).json({ error: "code must be a string up to 100 chars" });
      return;
    }
  }
  if (body.discountType !== undefined) {
    if (!isValidDiscountType(body.discountType)) {
      res.status(400).json({ error: "discountType must be 'percentage' or 'fixed'" });
      return;
    }
    updates.discountType = body.discountType;
  }
  if (body.discountValue !== undefined) {
    if (!isPositiveInt(body.discountValue)) {
      res.status(400).json({ error: "discountValue must be a non-negative integer" });
      return;
    }
    updates.discountValue = body.discountValue as number;
  }
  if (body.applicablePlans !== undefined) {
    if (!Array.isArray(body.applicablePlans) || !body.applicablePlans.every((p) => typeof p === "string")) {
      res.status(400).json({ error: "applicablePlans must be an array of strings" });
      return;
    }
    updates.applicablePlans = body.applicablePlans as string[];
  }
  if (body.startsAt !== undefined) {
    const d = parseDate(body.startsAt);
    if (!d) {
      res.status(400).json({ error: "startsAt must be a valid ISO date" });
      return;
    }
    updates.startsAt = d;
  }
  if (body.endsAt !== undefined) {
    const d = parseDate(body.endsAt);
    if (!d) {
      res.status(400).json({ error: "endsAt must be a valid ISO date" });
      return;
    }
    updates.endsAt = d;
  }
  if (body.maxUses !== undefined) {
    if (body.maxUses === null) {
      updates.maxUses = null;
    } else if (isPositiveInt(body.maxUses) && (body.maxUses as number) >= 1) {
      updates.maxUses = body.maxUses as number;
    } else {
      res.status(400).json({ error: "maxUses must be null or a positive integer" });
      return;
    }
  }
  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be boolean" });
      return;
    }
    updates.isActive = body.isActive;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [updated] = await db.update(offersTable).set(updates).where(eq(offersTable.id, id)).returning();
  if (!updated) {
    res.status(404).json({ error: "Offer not found" });
    return;
  }
  // Validate startsAt < endsAt after merging
  if (updated.endsAt <= updated.startsAt) {
    res.status(400).json({ error: "endsAt must be after startsAt (after merge)" });
    return;
  }
  res.json(buildOffer(updated));
});

// =========================================================
// ADMIN: DELETE OFFER
// =========================================================
router.delete("/admin/offers/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = param(req.params.id);
  await db.delete(offersTable).where(eq(offersTable.id, id));
  res.status(204).send();
});

// =========================================================
// ADMIN: STATS
// =========================================================
router.get("/admin/offers/stats", requireAuth, requireRole("super_admin"), async (_req, res): Promise<void> => {
  const now = new Date();
  const [totalRow] = await db.select({ c: count() }).from(offersTable);
  const [activeRow] = await db
    .select({ c: count() })
    .from(offersTable)
    .where(and(eq(offersTable.isActive, true), gte(offersTable.endsAt, now), lte(offersTable.startsAt, now)));
  const [expiredRow] = await db
    .select({ c: count() })
    .from(offersTable)
    .where(lte(offersTable.endsAt, now));
  const [redemptionsRow] = await db.select({ c: count() }).from(offerRedemptionsTable);

  const topOffers = await db
    .select({
      id: offersTable.id,
      name: offersTable.name,
      code: offersTable.code,
      redemptions: count(offerRedemptionsTable.id),
    })
    .from(offersTable)
    .leftJoin(offerRedemptionsTable, eq(offerRedemptionsTable.offerId, offersTable.id))
    .groupBy(offersTable.id, offersTable.name, offersTable.code)
    .orderBy(desc(count(offerRedemptionsTable.id)))
    .limit(10);

  res.json({
    totalOffers: totalRow?.c ?? 0,
    activeOffers: activeRow?.c ?? 0,
    expiredOffers: expiredRow?.c ?? 0,
    totalRedemptions: redemptionsRow?.c ?? 0,
    topOffers: topOffers.map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code ?? null,
      redemptions: t.redemptions,
    })),
  });
});

export default router;
