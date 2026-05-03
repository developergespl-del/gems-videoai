import { Router, type IRouter } from "express";
import { db, languagesTable, userLanguagesTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { AdminUpdateLanguageBody } from "@workspace/api-zod";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Seed default languages on first call (idempotent)
// ---------------------------------------------------------------------------
const SEED_LANGUAGES = [
  // Indian languages (isDefault=true for Hindi)
  { code: "hi", name: "Hindi", nativeName: "हिन्दी", flag: "🇮🇳", dialects: 13, region: "indian" as const, priceUsd: 0, isDefault: true, sortOrder: 1 },
  { code: "ta", name: "Tamil", nativeName: "தமிழ்", flag: "🇮🇳", dialects: 7, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 2 },
  { code: "te", name: "Telugu", nativeName: "తెలుగు", flag: "🇮🇳", dialects: 5, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 3 },
  { code: "bn", name: "Bengali", nativeName: "বাংলা", flag: "🇧🇩", dialects: 6, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 4 },
  { code: "mr", name: "Marathi", nativeName: "मराठी", flag: "🇮🇳", dialects: 5, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 5 },
  { code: "pa", name: "Punjabi", nativeName: "ਪੰਜਾਬੀ", flag: "🇮🇳", dialects: 4, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 6 },
  { code: "kn", name: "Kannada", nativeName: "ಕನ್ನಡ", flag: "🇮🇳", dialects: 4, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 7 },
  { code: "ml", name: "Malayalam", nativeName: "മലയാളം", flag: "🇮🇳", dialects: 3, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 8 },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી", flag: "🇮🇳", dialects: 3, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 9 },
  { code: "or", name: "Odia", nativeName: "ଓଡ଼ିଆ", flag: "🇮🇳", dialects: 2, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 10 },
  { code: "ur", name: "Urdu", nativeName: "اردو", flag: "🇵🇰", dialects: 4, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 11 },
  { code: "as", name: "Assamese", nativeName: "অসমীয়া", flag: "🇮🇳", dialects: 2, region: "indian" as const, priceUsd: 9.99, isDefault: false, sortOrder: 12 },
  // Global languages
  { code: "en", name: "English", nativeName: "English", flag: "🇺🇸", dialects: 8, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 20 },
  { code: "ar", name: "Arabic", nativeName: "العربية", flag: "🇸🇦", dialects: 6, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 21 },
  { code: "zh", name: "Mandarin", nativeName: "普通话", flag: "🇨🇳", dialects: 3, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 22 },
  { code: "es", name: "Spanish", nativeName: "Español", flag: "🇪🇸", dialects: 4, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 23 },
  { code: "fr", name: "French", nativeName: "Français", flag: "🇫🇷", dialects: 3, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 24 },
  { code: "pt", name: "Portuguese", nativeName: "Português", flag: "🇧🇷", dialects: 2, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 25 },
  { code: "de", name: "German", nativeName: "Deutsch", flag: "🇩🇪", dialects: 3, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 26 },
  { code: "ja", name: "Japanese", nativeName: "日本語", flag: "🇯🇵", dialects: 2, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 27 },
  { code: "ko", name: "Korean", nativeName: "한국어", flag: "🇰🇷", dialects: 2, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 28 },
  { code: "ru", name: "Russian", nativeName: "Русский", flag: "🇷🇺", dialects: 2, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 29 },
  { code: "it", name: "Italian", nativeName: "Italiano", flag: "🇮🇹", dialects: 3, region: "global" as const, priceUsd: 14.99, isDefault: false, sortOrder: 30 },
  { code: "sw", name: "Swahili", nativeName: "Kiswahili", flag: "🇰🇪", dialects: 2, region: "global" as const, priceUsd: 9.99, isDefault: false, sortOrder: 31 },
];

async function ensureSeeded() {
  const existing = await db.select({ id: languagesTable.id }).from(languagesTable).limit(1);
  if (existing.length === 0) {
    await db.insert(languagesTable).values(SEED_LANGUAGES).onConflictDoNothing();
  }
}

// ---------------------------------------------------------------------------
// GET /languages — public list with user purchase status
// ---------------------------------------------------------------------------
router.get("/languages", requireAuth, async (req, res): Promise<void> => {
  await ensureSeeded();

  const userId = req.user!.userId;

  const allLangs = await db
    .select()
    .from(languagesTable)
    .where(eq(languagesTable.enabled, true))
    .orderBy(asc(languagesTable.sortOrder));

  const purchases = await db
    .select({ languageId: userLanguagesTable.languageId })
    .from(userLanguagesTable)
    .where(eq(userLanguagesTable.userId, userId));

  const purchasedIds = new Set(purchases.map((p) => p.languageId));
  const isSuperAdmin = req.user!.role === "super_admin";

  const result = allLangs.map((lang) => ({
    ...lang,
    // Super admin has all languages unlocked by default — no purchase required
    purchased: isSuperAdmin || lang.isDefault || purchasedIds.has(lang.id),
  }));

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /languages/:id/purchase — purchase a language (payment placeholder)
// ---------------------------------------------------------------------------
router.post("/languages/:id/purchase", requireAuth, async (req, res): Promise<void> => {
  await ensureSeeded();

  const langId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const userId = req.user!.userId;

  const [lang] = await db.select().from(languagesTable).where(eq(languagesTable.id, langId));
  if (!lang) {
    res.status(404).json({ error: "Language not found" });
    return;
  }

  // Super admin bypasses all language purchase restrictions
  const isSuperAdmin = req.user!.role === "super_admin";

  if (!isSuperAdmin) {
    if (!lang.enabled) {
      res.status(400).json({ error: "Language is not available" });
      return;
    }
    if (lang.isDefault) {
      res.status(400).json({ error: "This language is free by default" });
      return;
    }

    // Check already purchased
    const [existing] = await db
      .select()
      .from(userLanguagesTable)
      .where(and(eq(userLanguagesTable.userId, userId), eq(userLanguagesTable.languageId, langId)));

    if (existing) {
      res.status(400).json({ error: "Already purchased" });
      return;
    }
  }

  // Super admin already has all languages — no DB record needed
  if (isSuperAdmin) {
    res.status(201).json({ success: true, purchaseId: null, language: lang.name });
    return;
  }

  const [purchase] = await db
    .insert(userLanguagesTable)
    .values({ userId, languageId: langId, paymentRef: `mock_${Date.now()}` })
    .returning();

  res.status(201).json({ success: true, purchaseId: purchase.id, language: lang.name });
});

// ---------------------------------------------------------------------------
// GET /admin/languages — admin: list all languages including disabled
// ---------------------------------------------------------------------------
router.get("/admin/languages", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  await ensureSeeded();

  const langs = await db
    .select()
    .from(languagesTable)
    .orderBy(asc(languagesTable.sortOrder));

  res.json(langs);
});

// ---------------------------------------------------------------------------
// PUT /admin/languages/:id — admin: update price or enabled state
// ---------------------------------------------------------------------------
router.put("/admin/languages/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const langId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = AdminUpdateLanguageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const [updated] = await db
    .update(languagesTable)
    .set(parsed.data)
    .where(eq(languagesTable.id, langId))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Language not found" });
    return;
  }

  res.json(updated);
});

export default router;
