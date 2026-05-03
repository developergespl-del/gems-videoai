import { Router, type IRouter } from "express";
import { db, videoPlansTable, userVideoPlansTable, usersTable } from "@workspace/db";
import { eq, and, asc, gte, count } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { AdminCreateVideoPlanBody, AdminUpdateVideoPlanBody } from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Seed default plans (idempotent)
// ---------------------------------------------------------------------------
const DEFAULT_PLANS = [
  {
    name: "Free",
    description: "Get started with basic video generation",
    priceUsd: 0,
    maxLengthSeconds: 30,
    monthlyQuota: 3,
    isDefault: true,
    isActive: true,
    features: ["Up to 30s videos", "3 videos/month", "HD quality", "Hindi only"],
    sortOrder: 1,
  },
  {
    name: "Creator",
    description: "For growing content creators",
    priceUsd: 19.99,
    maxLengthSeconds: 120,
    monthlyQuota: 20,
    isDefault: false,
    isActive: true,
    features: ["Up to 2 min videos", "20 videos/month", "Full HD quality", "All Indian languages"],
    sortOrder: 2,
  },
  {
    name: "Studio",
    description: "Professional video production at scale",
    priceUsd: 49.99,
    maxLengthSeconds: 600,
    monthlyQuota: 100,
    isDefault: false,
    isActive: true,
    features: ["Up to 10 min videos", "100 videos/month", "4K quality", "All languages + Cinema mode"],
    sortOrder: 3,
  },
];

let seedPromise: Promise<void> | null = null;
async function ensureSeeded() {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const existing = await db.select({ id: videoPlansTable.id }).from(videoPlansTable).limit(1);
    if (existing.length === 0) {
      await db.insert(videoPlansTable).values(DEFAULT_PLANS).onConflictDoNothing();
    }
  })();
  return seedPromise;
}

// ---------------------------------------------------------------------------
// Helper: get user's active plan
// ---------------------------------------------------------------------------
async function getUserActivePlan(userId: string) {
  const [sub] = await db
    .select({ planId: userVideoPlansTable.planId })
    .from(userVideoPlansTable)
    .where(and(eq(userVideoPlansTable.userId, userId), eq(userVideoPlansTable.status, "active")))
    .orderBy(userVideoPlansTable.createdAt)
    .limit(1);

  if (!sub) return null;

  const [plan] = await db.select().from(videoPlansTable).where(eq(videoPlansTable.id, sub.planId));
  return plan ?? null;
}

// ---------------------------------------------------------------------------
// Helper: count videos created this calendar month
// ---------------------------------------------------------------------------
import { videosTable } from "@workspace/db";
async function getVideosThisMonth(userId: string): Promise<number> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select({ cnt: count() })
    .from(videosTable)
    .where(and(eq(videosTable.userId, userId), gte(videosTable.createdAt, startOfMonth)));
  return Number(row?.cnt ?? 0);
}

// ---------------------------------------------------------------------------
// GET /video-plans — list with subscription status
// ---------------------------------------------------------------------------
router.get("/video-plans", requireAuth, async (req, res): Promise<void> => {
  await ensureSeeded();
  const userId = req.user!.userId;
  const isSuperAdmin = req.user!.role === "super_admin";

  const plans = await db
    .select()
    .from(videoPlansTable)
    .where(eq(videoPlansTable.isActive, true))
    .orderBy(asc(videoPlansTable.sortOrder));

  const [sub] = await db
    .select({ planId: userVideoPlansTable.planId })
    .from(userVideoPlansTable)
    .where(and(eq(userVideoPlansTable.userId, userId), eq(userVideoPlansTable.status, "active")))
    .limit(1);

  const subscribedPlanId = sub?.planId ?? null;

  const result = plans.map((p) => ({
    ...p,
    features: (p.features as string[]) ?? [],
    subscribed: isSuperAdmin ? true : (p.isDefault || p.id === subscribedPlanId),
  }));

  res.json(result);
});

// ---------------------------------------------------------------------------
// GET /video-plans/my-plan — current plan + usage
// ---------------------------------------------------------------------------
router.get("/video-plans/my-plan", requireAuth, async (req, res): Promise<void> => {
  await ensureSeeded();
  const userId = req.user!.userId;
  const isSuperAdmin = req.user!.role === "super_admin";

  const activePlan = await getUserActivePlan(userId);
  const videosThisMonth = await getVideosThisMonth(userId);

  if (isSuperAdmin) {
    res.json({
      plan: null,
      videosThisMonth,
      quotaRemaining: null,
      canCreate: true,
      limitReason: null,
    });
    return;
  }

  // Default plan limits (if no paid plan)
  const defaultPlan = await db
    .select()
    .from(videoPlansTable)
    .where(and(eq(videoPlansTable.isDefault, true), eq(videoPlansTable.isActive, true)))
    .limit(1)
    .then((r) => r[0] ?? null);

  const effectivePlan = activePlan ?? defaultPlan;
  const quota = effectivePlan?.monthlyQuota ?? 3;
  const quotaRemaining = Math.max(0, quota - videosThisMonth);
  const canCreate = quotaRemaining > 0;

  res.json({
    plan: effectivePlan ? { ...effectivePlan, features: (effectivePlan.features as string[]) ?? [], subscribed: true } : null,
    videosThisMonth,
    quotaRemaining,
    canCreate,
    limitReason: canCreate ? null : `Monthly quota of ${quota} videos reached. Upgrade your plan to create more.`,
  });
});

// ---------------------------------------------------------------------------
// POST /video-plans/:id/subscribe — purchase a plan
// ---------------------------------------------------------------------------
router.post("/video-plans/:id/subscribe", requireAuth, async (req, res): Promise<void> => {
  await ensureSeeded();
  const planId = req.params.id as string;
  const userId = req.user!.userId;
  const isSuperAdmin = req.user!.role === "super_admin";

  const [plan] = await db.select().from(videoPlansTable).where(eq(videoPlansTable.id, planId));
  if (!plan || !plan.isActive) {
    res.status(404).json({ error: "Plan not found or inactive" });
    return;
  }

  if (plan.isDefault) {
    res.status(400).json({ error: "This is the free default plan" });
    return;
  }

  if (!isSuperAdmin) {
    // Cancel any existing active subscription first
    await db
      .update(userVideoPlansTable)
      .set({ status: "cancelled" })
      .where(and(eq(userVideoPlansTable.userId, userId), eq(userVideoPlansTable.status, "active")));
  }

  const [sub] = await db
    .insert(userVideoPlansTable)
    .values({
      userId,
      planId,
      status: "active",
      paymentRef: `mock_${Date.now()}`,
    })
    .returning();

  res.status(201).json({
    success: true,
    subscriptionId: sub.id,
    plan: { ...plan, features: (plan.features as string[]) ?? [], subscribed: true },
  });
});

// ---------------------------------------------------------------------------
// GET /admin/video-plans — admin list all
// ---------------------------------------------------------------------------
router.get("/admin/video-plans", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  await ensureSeeded();
  const plans = await db.select().from(videoPlansTable).orderBy(asc(videoPlansTable.sortOrder));
  res.json(plans.map((p) => ({ ...p, features: (p.features as string[]) ?? [] })));
});

// ---------------------------------------------------------------------------
// POST /admin/video-plans — create plan
// ---------------------------------------------------------------------------
router.post("/admin/video-plans", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = AdminCreateVideoPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  // If setting this as default, unset others
  if (parsed.data.isDefault) {
    await db.update(videoPlansTable).set({ isDefault: false });
  }

  const [plan] = await db.insert(videoPlansTable).values({
    ...parsed.data,
    features: parsed.data.features ?? [],
  }).returning();

  res.status(201).json({ ...plan, features: (plan.features as string[]) ?? [] });
});

// ---------------------------------------------------------------------------
// PUT /admin/video-plans/:id — update plan
// ---------------------------------------------------------------------------
router.put("/admin/video-plans/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const planId = req.params.id as string;
  const parsed = AdminUpdateVideoPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  if (parsed.data.isDefault) {
    await db.update(videoPlansTable).set({ isDefault: false });
  }

  const [plan] = await db
    .update(videoPlansTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(videoPlansTable.id, planId))
    .returning();

  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  res.json({ ...plan, features: (plan.features as string[]) ?? [] });
});

// ---------------------------------------------------------------------------
// DELETE /admin/video-plans/:id — delete plan
// ---------------------------------------------------------------------------
router.delete("/admin/video-plans/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const planId = req.params.id as string;

  const [plan] = await db.select().from(videoPlansTable).where(eq(videoPlansTable.id, planId));
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }
  if (plan.isDefault) {
    res.status(400).json({ error: "Cannot delete default plan" });
    return;
  }

  await db.delete(userVideoPlansTable).where(eq(userVideoPlansTable.planId, planId));
  await db.delete(videoPlansTable).where(eq(videoPlansTable.id, planId));

  res.status(204).send();
});

// ---------------------------------------------------------------------------
// POST /admin/video-plans/:id/grant — manually grant plan to user
// ---------------------------------------------------------------------------
router.post("/admin/video-plans/:id/grant", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const planId = req.params.id as string;
  const userId = req.body?.userId as string | undefined;
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "userId is required" });
    return;
  }

  const [plan] = await db.select().from(videoPlansTable).where(eq(videoPlansTable.id, planId));
  if (!plan) {
    res.status(404).json({ error: "Plan not found" });
    return;
  }

  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Cancel existing active subscriptions for that user
  await db
    .update(userVideoPlansTable)
    .set({ status: "cancelled" })
    .where(and(eq(userVideoPlansTable.userId, userId), eq(userVideoPlansTable.status, "active")));

  const [sub] = await db
    .insert(userVideoPlansTable)
    .values({
      userId,
      planId,
      status: "active",
      grantedByAdminId: req.user!.userId,
      paymentRef: `admin_grant_${Date.now()}`,
    })
    .returning();

  res.status(201).json({
    success: true,
    subscriptionId: sub.id,
    plan: { ...plan, features: (plan.features as string[]) ?? [], subscribed: true },
  });
});

export default router;
