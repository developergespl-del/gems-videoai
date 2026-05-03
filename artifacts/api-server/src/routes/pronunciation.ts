import { Router, type IRouter } from "express";
import {
  db,
  pronunciationDictionaryTable,
  voiceCorrectionsTable,
  usersTable,
} from "@workspace/db";
import { eq, and, count, sql, desc, like } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { analyzeScript } from "../lib/pronunciation-engine";

const router: IRouter = Router();

function param(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

const VALID_STATUSES = ["pending", "approved", "applied", "rejected"] as const;
type CorrectionStatus = (typeof VALID_STATUSES)[number];

function parseLimit(v: unknown, def = 100, max = 500): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

function isValidLanguageCode(v: unknown): v is string {
  return typeof v === "string" && /^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(v);
}

function isNonEmptyString(v: unknown, max = 500): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

function isValidUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function clampConfidence(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function buildEntry(e: typeof pronunciationDictionaryTable.$inferSelect) {
  return {
    id: e.id,
    languageCode: e.languageCode,
    word: e.word,
    phonetic: e.phonetic,
    context: e.context ?? null,
    region: e.region ?? null,
    audioUrl: e.audioUrl ?? null,
    source: e.source,
    confidence: e.confidence,
    createdByUserId: e.createdByUserId ?? null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function buildCorrection(
  c: typeof voiceCorrectionsTable.$inferSelect,
  userName: string | null = null,
  userEmail: string | null = null
) {
  return {
    id: c.id,
    userId: c.userId,
    videoId: c.videoId ?? null,
    word: c.word,
    languageCode: c.languageCode,
    audioUrl: c.audioUrl,
    notes: c.notes ?? null,
    status: c.status,
    reviewedByUserId: c.reviewedByUserId ?? null,
    createdAt: c.createdAt.toISOString(),
    userName,
    userEmail,
  };
}

// LIST DICTIONARY (public to authed users)
router.get("/pronunciation/dictionary", requireAuth, async (req, res): Promise<void> => {
  const language = req.query.language ? String(req.query.language) : undefined;
  const region = req.query.region ? String(req.query.region) : undefined;
  const word = req.query.word ? String(req.query.word) : undefined;
  const limit = parseLimit(req.query.limit);

  const conditions = [];
  if (language) conditions.push(eq(pronunciationDictionaryTable.languageCode, language));
  if (region) conditions.push(eq(pronunciationDictionaryTable.region, region));
  if (word) conditions.push(like(pronunciationDictionaryTable.word, `%${word}%`));

  const rows = await db
    .select()
    .from(pronunciationDictionaryTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(pronunciationDictionaryTable.createdAt))
    .limit(limit);

  res.json(rows.map(buildEntry));
});

// LOOKUP SINGLE WORD
router.get("/pronunciation/lookup", requireAuth, async (req, res): Promise<void> => {
  const word = req.query.word ? String(req.query.word) : "";
  const language = req.query.language ? String(req.query.language) : "";
  const region = req.query.region ? String(req.query.region) : undefined;

  if (!isNonEmptyString(word, 200) || !isValidLanguageCode(language)) {
    res.status(400).json({ error: "word (string) and language (e.g. en-US) are required" });
    return;
  }

  const conditions = [
    eq(pronunciationDictionaryTable.word, word),
    eq(pronunciationDictionaryTable.languageCode, language),
  ];
  if (region) conditions.push(eq(pronunciationDictionaryTable.region, region));

  const [entry] = await db
    .select()
    .from(pronunciationDictionaryTable)
    .where(and(...conditions))
    .limit(1);

  res.json({ found: !!entry, entry: entry ? buildEntry(entry) : null });
});

// AI ANALYZE SCRIPT
router.post("/pronunciation/analyze", requireAuth, async (req, res): Promise<void> => {
  const { text, languageCode, region, videoId } = req.body as {
    text: string;
    languageCode: string;
    region?: string;
    videoId?: string;
  };

  if (!isNonEmptyString(text, 20000) || !isValidLanguageCode(languageCode)) {
    res.status(400).json({ error: "text (1-20000 chars) and valid languageCode (e.g. en-US) are required" });
    return;
  }

  const userId = req.user?.userId;
  const result = await analyzeScript(text, languageCode, region ?? null);

  // Enrich each flagged word with user-correction + dictionary-entry indicators
  const enriched = await Promise.all(
    result.flaggedWords.map(async (fw) => {
      const [dictHit] = await db
        .select({ id: pronunciationDictionaryTable.id })
        .from(pronunciationDictionaryTable)
        .where(
          and(
            eq(pronunciationDictionaryTable.word, fw.word),
            eq(pronunciationDictionaryTable.languageCode, languageCode)
          )
        )
        .limit(1);

      let correctionHit: { id: string } | undefined;
      if (userId) {
        const correctionConditions = [
          eq(voiceCorrectionsTable.word, fw.word),
          eq(voiceCorrectionsTable.languageCode, languageCode),
          eq(voiceCorrectionsTable.userId, userId),
        ];
        if (videoId) correctionConditions.push(eq(voiceCorrectionsTable.videoId, videoId));
        [correctionHit] = await db
          .select({ id: voiceCorrectionsTable.id })
          .from(voiceCorrectionsTable)
          .where(and(...correctionConditions))
          .limit(1);
      }

      return {
        ...fw,
        hasUserCorrection: !!correctionHit,
        hasDictionaryEntry: !!dictHit,
      };
    })
  );

  res.json({
    languageCode: result.languageCode,
    region: result.region,
    wordCount: result.wordCount,
    flaggedCount: result.flaggedCount,
    overallConfidence: result.overallConfidence,
    flaggedWords: enriched,
    recommendation: result.recommendation,
  });
});

// LIST MY CORRECTIONS
router.get("/pronunciation/corrections", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const videoId = req.query.videoId ? String(req.query.videoId) : undefined;
  const conditions = [eq(voiceCorrectionsTable.userId, userId)];
  if (videoId) conditions.push(eq(voiceCorrectionsTable.videoId, videoId));

  const rows = await db
    .select()
    .from(voiceCorrectionsTable)
    .where(and(...conditions))
    .orderBy(desc(voiceCorrectionsTable.createdAt));

  res.json(rows.map((c) => buildCorrection(c)));
});

// SUBMIT CORRECTION
router.post("/pronunciation/corrections", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { word, languageCode, audioUrl, videoId, notes } = req.body as {
    word: string;
    languageCode: string;
    audioUrl: string;
    videoId?: string;
    notes?: string;
  };
  if (!isNonEmptyString(word, 200) || !isValidLanguageCode(languageCode) || !isValidUrl(audioUrl)) {
    res.status(400).json({ error: "word (string), languageCode (e.g. en-US), and audioUrl (http/https URL) are required" });
    return;
  }
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
    res.status(400).json({ error: "notes must be a string up to 2000 chars" });
    return;
  }
  const [created] = await db
    .insert(voiceCorrectionsTable)
    .values({
      userId,
      word,
      languageCode,
      audioUrl,
      videoId: videoId ?? null,
      notes: notes ?? null,
    })
    .returning();
  res.status(201).json(buildCorrection(created!));
});

// DELETE MY CORRECTION
router.delete("/pronunciation/corrections/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = param(req.params.id);
  const [existing] = await db
    .select()
    .from(voiceCorrectionsTable)
    .where(eq(voiceCorrectionsTable.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    res.status(404).json({ error: "Correction not found" });
    return;
  }
  await db.delete(voiceCorrectionsTable).where(eq(voiceCorrectionsTable.id, id));
  res.status(204).send();
});

// ADMIN: CREATE DICTIONARY ENTRY
router.post(
  "/admin/pronunciation/dictionary",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const { languageCode, word, phonetic, context, region, audioUrl, confidence } = req.body as {
      languageCode: string;
      word: string;
      phonetic: string;
      context?: string;
      region?: string;
      audioUrl?: string;
      confidence?: number;
    };
    if (!isValidLanguageCode(languageCode) || !isNonEmptyString(word, 200) || !isNonEmptyString(phonetic, 500)) {
      res.status(400).json({ error: "languageCode (e.g. en-US), word, and phonetic are required" });
      return;
    }
    if (audioUrl !== undefined && audioUrl !== null && audioUrl !== "" && !isValidUrl(audioUrl)) {
      res.status(400).json({ error: "audioUrl must be a valid http/https URL" });
      return;
    }
    const validConfidence = clampConfidence(confidence) ?? 100;
    const [created] = await db
      .insert(pronunciationDictionaryTable)
      .values({
        languageCode,
        word,
        phonetic,
        context: context ?? null,
        region: region ?? null,
        audioUrl: audioUrl ?? null,
        confidence: validConfidence,
        source: "admin_curated",
        createdByUserId: req.user?.userId,
      })
      .returning();
    res.status(201).json(buildEntry(created!));
  }
);

// ADMIN: UPDATE DICTIONARY ENTRY
router.put(
  "/admin/pronunciation/dictionary/:id",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = param(req.params.id);
    const { phonetic, context, region, audioUrl, confidence } = req.body as {
      phonetic?: string;
      context?: string;
      region?: string;
      audioUrl?: string;
      confidence?: number;
    };
    if (audioUrl !== undefined && audioUrl !== null && audioUrl !== "" && !isValidUrl(audioUrl)) {
      res.status(400).json({ error: "audioUrl must be a valid http/https URL" });
      return;
    }
    if (phonetic !== undefined && !isNonEmptyString(phonetic, 500)) {
      res.status(400).json({ error: "phonetic must be a non-empty string up to 500 chars" });
      return;
    }
    const updates: Partial<typeof pronunciationDictionaryTable.$inferInsert> = {};
    if (phonetic !== undefined) updates.phonetic = phonetic;
    if (context !== undefined) updates.context = context;
    if (region !== undefined) updates.region = region;
    if (audioUrl !== undefined) updates.audioUrl = audioUrl;
    if (confidence !== undefined) {
      const validConfidence = clampConfidence(confidence);
      if (validConfidence !== undefined) updates.confidence = validConfidence;
    }

    const [updated] = await db
      .update(pronunciationDictionaryTable)
      .set(updates)
      .where(eq(pronunciationDictionaryTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    res.json(buildEntry(updated));
  }
);

// ADMIN: DELETE DICTIONARY ENTRY
router.delete(
  "/admin/pronunciation/dictionary/:id",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = param(req.params.id);
    await db
      .delete(pronunciationDictionaryTable)
      .where(eq(pronunciationDictionaryTable.id, id));
    res.status(204).send();
  }
);

// ADMIN: LIST ALL CORRECTIONS (review queue)
router.get(
  "/admin/pronunciation/corrections",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const status = req.query.status ? String(req.query.status) : undefined;

    const rows = await db
      .select({
        c: voiceCorrectionsTable,
        userName: usersTable.name,
        userEmail: usersTable.email,
      })
      .from(voiceCorrectionsTable)
      .leftJoin(usersTable, eq(usersTable.id, voiceCorrectionsTable.userId))
      .where(
        status && (VALID_STATUSES as readonly string[]).includes(status)
          ? eq(voiceCorrectionsTable.status, status as CorrectionStatus)
          : undefined
      )
      .orderBy(desc(voiceCorrectionsTable.createdAt));

    res.json(rows.map((r) => buildCorrection(r.c, r.userName, r.userEmail)));
  }
);

// ADMIN: REVIEW CORRECTION
router.patch(
  "/admin/pronunciation/corrections/:id/status",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = param(req.params.id);
    const { status, notes } = req.body as {
      status: "approved" | "applied" | "rejected";
      notes?: string;
    };
    const REVIEW_STATUSES = ["approved", "applied", "rejected"] as const;
    if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${REVIEW_STATUSES.join(", ")}` });
      return;
    }
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
      res.status(400).json({ error: "notes must be a string up to 2000 chars" });
      return;
    }
    const updates: Partial<typeof voiceCorrectionsTable.$inferInsert> = {
      status,
      reviewedByUserId: req.user?.userId,
    };
    if (notes !== undefined) updates.notes = notes;

    const [updated] = await db
      .update(voiceCorrectionsTable)
      .set(updates)
      .where(eq(voiceCorrectionsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Correction not found" });
      return;
    }

    // If approved/applied, promote to a dictionary entry (user_contributed) if not already present
    if (status === "approved" || status === "applied") {
      const [existing] = await db
        .select({ id: pronunciationDictionaryTable.id })
        .from(pronunciationDictionaryTable)
        .where(
          and(
            eq(pronunciationDictionaryTable.word, updated.word),
            eq(pronunciationDictionaryTable.languageCode, updated.languageCode)
          )
        )
        .limit(1);
      if (!existing) {
        await db.insert(pronunciationDictionaryTable).values({
          languageCode: updated.languageCode,
          word: updated.word,
          phonetic: `[user: ${updated.word}]`,
          audioUrl: updated.audioUrl,
          source: "user_contributed",
          confidence: 95,
          createdByUserId: updated.userId,
        });
      }
    }

    res.json(buildCorrection(updated));
  }
);

// ADMIN: PRONUNCIATION STATS
router.get(
  "/admin/pronunciation/stats",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const [totalEntriesRow] = await db.select({ count: count() }).from(pronunciationDictionaryTable);
    const [userContribRow] = await db
      .select({ count: count() })
      .from(pronunciationDictionaryTable)
      .where(eq(pronunciationDictionaryTable.source, "user_contributed"));
    const [pendingRow] = await db
      .select({ count: count() })
      .from(voiceCorrectionsTable)
      .where(eq(voiceCorrectionsTable.status, "pending"));
    const [appliedRow] = await db
      .select({ count: count() })
      .from(voiceCorrectionsTable)
      .where(eq(voiceCorrectionsTable.status, "applied"));

    const langRows = await db
      .select({
        languageCode: pronunciationDictionaryTable.languageCode,
        count: count(),
      })
      .from(pronunciationDictionaryTable)
      .groupBy(pronunciationDictionaryTable.languageCode)
      .orderBy(desc(count()));

    const regionRows = await db
      .selectDistinct({ region: pronunciationDictionaryTable.region })
      .from(pronunciationDictionaryTable)
      .where(sql`${pronunciationDictionaryTable.region} IS NOT NULL`);

    res.json({
      totalEntries: totalEntriesRow?.count ?? 0,
      languagesCovered: langRows.length,
      regionsCovered: regionRows.length,
      userContributedEntries: userContribRow?.count ?? 0,
      pendingCorrections: pendingRow?.count ?? 0,
      appliedCorrections: appliedRow?.count ?? 0,
      topLanguages: langRows.slice(0, 10).map((r) => ({
        languageCode: r.languageCode,
        count: r.count,
      })),
    });
  }
);

export default router;
