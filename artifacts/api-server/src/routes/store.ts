import { Router, type IRouter } from "express";
import { db, specialAccessTable, platformSettingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { AdminSetCinemaPriceBody } from "@workspace/api-zod";

const router: IRouter = Router();

const CINEMA_PRICE_KEY = "cinema_mode_price_usd";
const CINEMA_PRICE_DEFAULT = 29.99;

async function getCinemaPriceValue(): Promise<number> {
  const [row] = await db
    .select({ value: platformSettingsTable.value })
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, CINEMA_PRICE_KEY));
  if (!row) return CINEMA_PRICE_DEFAULT;
  return parseFloat(row.value) || CINEMA_PRICE_DEFAULT;
}

// ---------------------------------------------------------------------------
// GET /store/cinema-mode/price
// ---------------------------------------------------------------------------
router.get("/store/cinema-mode/price", requireAuth, async (req, res): Promise<void> => {
  const priceUsd = await getCinemaPriceValue();
  res.json({ priceUsd });
});

// ---------------------------------------------------------------------------
// POST /store/cinema-mode/purchase — buy cinema mode
// ---------------------------------------------------------------------------
router.post("/store/cinema-mode/purchase", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const isSuperAdmin = req.user!.role === "super_admin";

  // Check if already has cinema mode
  const [existing] = await db
    .select()
    .from(specialAccessTable)
    .where(eq(specialAccessTable.userId, userId));

  if (existing?.canCinemaMode && !isSuperAdmin) {
    res.status(400).json({ error: "Cinema mode is already enabled for your account" });
    return;
  }

  // Upsert special_access record with canCinemaMode = true
  if (existing) {
    await db
      .update(specialAccessTable)
      .set({ canCinemaMode: true, updatedAt: new Date() })
      .where(eq(specialAccessTable.userId, userId));
  } else {
    await db.insert(specialAccessTable).values({
      userId,
      canCinemaMode: true,
      canGenerateVideos: true,
      reason: "vip",
    });
  }

  res.status(201).json({
    success: true,
    message: "Cinema mode has been activated on your account. Enjoy 4K–8K cinematic video generation!",
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/cinema-mode/price — super admin sets price
// ---------------------------------------------------------------------------
router.put("/admin/cinema-mode/price", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const parsed = AdminSetCinemaPriceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const priceStr = String(parsed.data.priceUsd);

  const [existing] = await db
    .select()
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, CINEMA_PRICE_KEY));

  if (existing) {
    await db
      .update(platformSettingsTable)
      .set({ value: priceStr, updatedAt: new Date() })
      .where(eq(platformSettingsTable.key, CINEMA_PRICE_KEY));
  } else {
    await db.insert(platformSettingsTable).values({
      key: CINEMA_PRICE_KEY,
      value: priceStr,
      updatedByUserId: req.user!.userId,
    });
  }

  res.json({ priceUsd: parsed.data.priceUsd });
});

export default router;
