import { Router, type IRouter } from "express";
import {
  db,
  soundLibraryTable,
  soundAnalysesTable,
  soundDecisionsTable,
  type SoundLibraryEntry,
} from "@workspace/db";
import { eq, and, desc, ilike, or, inArray, count, sql } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import {
  analyzeScriptSounds,
  scoreLibraryMatch,
  MIN_LIBRARY_MATCH_SCORE,
  type DetectedSoundCue,
  type MatchableSound,
  type SoundIntensity,
} from "../lib/sound-design-engine";

const router: IRouter = Router();

function param(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

function isStr(v: unknown, max = 500): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}
function isNonEmpty(v: unknown, max = 500): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

const VALID_INTENSITIES = ["low", "medium", "high"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function pickIntensity(v: unknown, def: SoundIntensity = "medium"): SoundIntensity {
  return typeof v === "string" && (VALID_INTENSITIES as readonly string[]).includes(v)
    ? (v as SoundIntensity)
    : def;
}
function strArr(v: unknown, max = 32): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim().length > 0 && item.length <= 100) {
      out.push(item.trim());
    }
    if (out.length >= max) break;
  }
  return out;
}

function buildEntry(s: SoundLibraryEntry) {
  return {
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description ?? null,
    tags: Array.isArray(s.tags) ? s.tags : [],
    emotions: Array.isArray(s.emotions) ? s.emotions : [],
    environments: Array.isArray(s.environments) ? s.environments : [],
    intensity: s.intensity,
    audioUrl: s.audioUrl,
    previewUrl: s.previewUrl ?? null,
    durationMs: s.durationMs,
    isCopyrightFree: s.isCopyrightFree,
    license: s.license,
    attribution: s.attribution ?? null,
    isActive: s.isActive,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// =========================================================
// USER: LIST PUBLIC SOUND LIBRARY
// =========================================================
router.get("/sound-design/library", requireAuth, async (req, res): Promise<void> => {
  const category = req.query.category ? param(req.query.category as string | string[]) : null;
  const search = req.query.search ? param(req.query.search as string | string[]) : null;
  const conditions = [eq(soundLibraryTable.isActive, true)];
  if (category && category.trim().length > 0) {
    conditions.push(eq(soundLibraryTable.category, category.trim().toLowerCase()));
  }
  if (search && search.trim().length > 0) {
    const term = `%${search.trim()}%`;
    const orCond = or(
      ilike(soundLibraryTable.name, term),
      ilike(soundLibraryTable.description, term),
    );
    if (orCond) conditions.push(orCond);
  }
  const rows = await db
    .select()
    .from(soundLibraryTable)
    .where(and(...conditions))
    .orderBy(desc(soundLibraryTable.createdAt))
    .limit(500);
  res.json(rows.map(buildEntry));
});

// =========================================================
// USER: ANALYZE SCRIPT FOR SOUND CUES
// =========================================================
router.post("/sound-design/analyze", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const scriptText = body.scriptText;
  if (!isNonEmpty(scriptText, 20000)) {
    res.status(400).json({ error: "scriptText is required (1-20000 chars)" });
    return;
  }
  const videoIdRaw = body.videoId;
  let videoId: string | null = null;
  if (typeof videoIdRaw === "string" && videoIdRaw.length > 0) {
    if (!UUID_RE.test(videoIdRaw)) {
      res.status(400).json({ error: "videoId must be a valid UUID" });
      return;
    }
    videoId = videoIdRaw;
  }
  const persistResults = body.persistResults !== false;

  let analysis;
  try {
    analysis = await analyzeScriptSounds(scriptText);
  } catch (err) {
    req.log.error({ err: String(err) }, "sound-design analyze failed");
    // Persist a failed analysis record so the user has a trace if they enabled persistence.
    if (persistResults) {
      try {
        await db.insert(soundAnalysesTable).values({
          userId,
          videoId,
          scriptText: scriptText.slice(0, 20000),
          totalDetected: 0,
          totalKept: 0,
          totalReplaced: 0,
          totalAdded: 0,
          summary: "AI sound analysis failed.",
          status: "failed",
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        });
      } catch (persistErr) {
        req.log.error({ err: String(persistErr) }, "failed to persist failed analysis");
      }
    }
    res.status(503).json({ error: err instanceof Error ? err.message : "Sound analysis failed" });
    return;
  }

  // Load active library to match replacements/additions
  const library = await db
    .select()
    .from(soundLibraryTable)
    .where(eq(soundLibraryTable.isActive, true))
    .limit(2000);

  const matchable: (MatchableSound & SoundLibraryEntry)[] = library.map((s) => ({
    ...s,
    tags: Array.isArray(s.tags) ? s.tags : [],
    emotions: Array.isArray(s.emotions) ? s.emotions : [],
    environments: Array.isArray(s.environments) ? s.environments : [],
  }));

  type DecisionWithMatch = DetectedSoundCue & { matchedSound: SoundLibraryEntry | null };

  // Strict rule: "no mismatched/generic audio".
  //   - "added" with no library match  → DROP (don't fabricate a missing sound)
  //   - "replaced" with no library match → DOWNGRADE to "kept" (retain user's prompt with a note)
  const finalized: DecisionWithMatch[] = [];
  for (const cue of analysis.decisions) {
    if (cue.decision === "kept") {
      finalized.push({ ...cue, matchedSound: null });
      continue;
    }
    let best: { score: number; sound: SoundLibraryEntry } | null = null;
    for (const s of matchable) {
      const score = scoreLibraryMatch(cue, s);
      if (score >= MIN_LIBRARY_MATCH_SCORE && (!best || score > best.score)) best = { score, sound: s };
    }
    if (best) {
      finalized.push({ ...cue, matchedSound: best.sound });
    } else if (cue.decision === "replaced" && cue.originalPrompt) {
      finalized.push({
        ...cue,
        decision: "kept",
        matchedSound: null,
        reason: `No suitable cinematic library match available — keeping user's original prompt. ${cue.reason}`.slice(0, 500),
      });
    }
    // else: cue.decision === "added" with no match → drop entirely
  }

  // Recompute totals from the finalized list.
  let kept = 0, replaced = 0, added = 0;
  for (const d of finalized) {
    if (d.decision === "kept") kept++;
    else if (d.decision === "replaced") replaced++;
    else if (d.decision === "added") added++;
  }
  const totalDetected = kept + replaced;

  // Persist atomically
  let analysisId: string | null = null;
  let createdAt = new Date();
  if (persistResults) {
    try {
      const inserted = await db.transaction(async (tx) => {
        const [a] = await tx
          .insert(soundAnalysesTable)
          .values({
            userId,
            videoId,
            scriptText: scriptText.slice(0, 20000),
            totalDetected,
            totalKept: kept,
            totalReplaced: replaced,
            totalAdded: added,
            summary: analysis.summary,
            status: "completed",
          })
          .returning({ id: soundAnalysesTable.id, createdAt: soundAnalysesTable.createdAt });
        if (!a) throw new Error("Failed to insert analysis row");
        if (finalized.length > 0) {
          await tx.insert(soundDecisionsTable).values(
            finalized.map((d) => ({
              analysisId: a.id,
              originalPrompt: d.originalPrompt,
              detectedCategory: d.detectedCategory,
              sceneIndex: d.sceneIndex,
              sceneEmotion: d.sceneEmotion,
              sceneEnvironment: d.sceneEnvironment,
              sceneIntensity: d.sceneIntensity,
              decision: d.decision,
              reason: d.reason,
              replacementSoundId: d.matchedSound?.id ?? null,
              suggestedDescription: d.suggestedDescription,
              confidence: d.confidence,
            })),
          );
        }
        return a;
      });
      analysisId = inserted.id;
      createdAt = inserted.createdAt;
    } catch (err) {
      req.log.error({ err: String(err) }, "sound-design persist failed");
      res.status(500).json({ error: "Failed to save analysis" });
      return;
    }
  }

  res.json({
    id: analysisId,
    userId,
    videoId,
    scriptText,
    totalDetected,
    totalKept: kept,
    totalReplaced: replaced,
    totalAdded: added,
    summary: analysis.summary,
    status: "completed",
    errorMessage: null,
    decisions: finalized.map((d) => ({
      id: null,
      originalPrompt: d.originalPrompt,
      detectedCategory: d.detectedCategory,
      sceneIndex: d.sceneIndex,
      sceneEmotion: d.sceneEmotion,
      sceneEnvironment: d.sceneEnvironment,
      sceneIntensity: d.sceneIntensity,
      decision: d.decision,
      reason: d.reason,
      replacementSound: d.matchedSound ? buildEntry(d.matchedSound) : null,
      suggestedDescription: d.suggestedDescription,
      confidence: d.confidence,
    })),
    createdAt: createdAt.toISOString(),
  });
});

// =========================================================
// USER: LIST MY ANALYSES
// =========================================================
router.get("/sound-design/analyses", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rows = await db
    .select({
      id: soundAnalysesTable.id,
      videoId: soundAnalysesTable.videoId,
      totalDetected: soundAnalysesTable.totalDetected,
      totalKept: soundAnalysesTable.totalKept,
      totalReplaced: soundAnalysesTable.totalReplaced,
      totalAdded: soundAnalysesTable.totalAdded,
      status: soundAnalysesTable.status,
      summary: soundAnalysesTable.summary,
      createdAt: soundAnalysesTable.createdAt,
    })
    .from(soundAnalysesTable)
    .where(eq(soundAnalysesTable.userId, userId))
    .orderBy(desc(soundAnalysesTable.createdAt))
    .limit(100);
  res.json(
    rows.map((r) => ({
      id: r.id,
      videoId: r.videoId ?? null,
      totalDetected: r.totalDetected,
      totalKept: r.totalKept,
      totalReplaced: r.totalReplaced,
      totalAdded: r.totalAdded,
      status: r.status,
      summary: r.summary ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});

// =========================================================
// USER: GET ONE ANALYSIS WITH DECISIONS
// =========================================================
router.get("/sound-design/analyses/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const id = param(req.params.id as string | string[]);
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }

  const [analysis] = await db
    .select()
    .from(soundAnalysesTable)
    .where(and(eq(soundAnalysesTable.id, id), eq(soundAnalysesTable.userId, userId)))
    .limit(1);
  if (!analysis) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const decisions = await db
    .select()
    .from(soundDecisionsTable)
    .where(eq(soundDecisionsTable.analysisId, analysis.id))
    .orderBy(soundDecisionsTable.sceneIndex);

  // Fetch matched sounds in one go via inArray
  const soundIds = decisions
    .map((d) => d.replacementSoundId)
    .filter((x): x is string => typeof x === "string");
  const soundMap = new Map<string, SoundLibraryEntry>();
  if (soundIds.length > 0) {
    const sounds = await db
      .select()
      .from(soundLibraryTable)
      .where(inArray(soundLibraryTable.id, soundIds));
    for (const s of sounds) soundMap.set(s.id, s);
  }

  res.json({
    id: analysis.id,
    userId: analysis.userId,
    videoId: analysis.videoId ?? null,
    scriptText: analysis.scriptText,
    totalDetected: analysis.totalDetected,
    totalKept: analysis.totalKept,
    totalReplaced: analysis.totalReplaced,
    totalAdded: analysis.totalAdded,
    summary: analysis.summary ?? null,
    status: analysis.status,
    errorMessage: analysis.errorMessage ?? null,
    decisions: decisions.map((d) => {
      const matched = d.replacementSoundId ? soundMap.get(d.replacementSoundId) ?? null : null;
      return {
        id: d.id,
        originalPrompt: d.originalPrompt ?? null,
        detectedCategory: d.detectedCategory ?? null,
        sceneIndex: d.sceneIndex,
        sceneEmotion: d.sceneEmotion ?? null,
        sceneEnvironment: d.sceneEnvironment ?? null,
        sceneIntensity: d.sceneIntensity ?? null,
        decision: d.decision,
        reason: d.reason,
        replacementSound: matched ? buildEntry(matched) : null,
        suggestedDescription: d.suggestedDescription ?? null,
        confidence: d.confidence,
      };
    }),
    createdAt: analysis.createdAt.toISOString(),
  });
});

// =========================================================
// ADMIN: LIST ALL LIBRARY ENTRIES
// =========================================================
router.get(
  "/admin/sound-design/library",
  requireAuth,
  requireRole("super_admin"),
  async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(soundLibraryTable)
      .orderBy(desc(soundLibraryTable.createdAt))
      .limit(2000);
    res.json(rows.map(buildEntry));
  },
);

// =========================================================
// ADMIN: CREATE LIBRARY ENTRY
// =========================================================
router.post(
  "/admin/sound-design/library",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const userId = req.user?.userId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!isNonEmpty(body.name, 200)) {
      res.status(400).json({ error: "name required" });
      return;
    }
    if (!isNonEmpty(body.category, 100)) {
      res.status(400).json({ error: "category required" });
      return;
    }
    if (!isNonEmpty(body.audioUrl, 2000)) {
      res.status(400).json({ error: "audioUrl required" });
      return;
    }

    const [created] = await db
      .insert(soundLibraryTable)
      .values({
        name: (body.name as string).trim(),
        category: (body.category as string).trim().toLowerCase(),
        description: isStr(body.description, 1000) ? (body.description as string) : null,
        tags: strArr(body.tags),
        emotions: strArr(body.emotions),
        environments: strArr(body.environments),
        intensity: pickIntensity(body.intensity),
        audioUrl: (body.audioUrl as string).trim(),
        previewUrl: isStr(body.previewUrl, 2000) ? (body.previewUrl as string) : null,
        durationMs: typeof body.durationMs === "number" && body.durationMs >= 0 ? Math.round(body.durationMs) : 0,
        isCopyrightFree: typeof body.isCopyrightFree === "boolean" ? body.isCopyrightFree : true,
        license: isStr(body.license, 200) ? (body.license as string) : "CC0",
        attribution: isStr(body.attribution, 500) ? (body.attribution as string) : null,
        isActive: typeof body.isActive === "boolean" ? body.isActive : true,
        createdByUserId: userId ?? null,
      })
      .returning();
    if (!created) {
      res.status(500).json({ error: "Failed to create" });
      return;
    }
    res.status(201).json(buildEntry(created));
  },
);

// =========================================================
// ADMIN: UPDATE LIBRARY ENTRY
// =========================================================
router.patch(
  "/admin/sound-design/library/:id",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = param(req.params.id as string | string[]);
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<typeof soundLibraryTable.$inferInsert> = {};
    if (isNonEmpty(body.name, 200)) patch.name = (body.name as string).trim();
    if (isNonEmpty(body.category, 100)) patch.category = (body.category as string).trim().toLowerCase();
    if (typeof body.description === "string") patch.description = (body.description as string).slice(0, 1000) || null;
    if (Array.isArray(body.tags)) patch.tags = strArr(body.tags);
    if (Array.isArray(body.emotions)) patch.emotions = strArr(body.emotions);
    if (Array.isArray(body.environments)) patch.environments = strArr(body.environments);
    if (typeof body.intensity === "string") patch.intensity = pickIntensity(body.intensity);
    if (isNonEmpty(body.audioUrl, 2000)) patch.audioUrl = (body.audioUrl as string).trim();
    if (typeof body.previewUrl === "string") patch.previewUrl = (body.previewUrl as string).slice(0, 2000) || null;
    if (typeof body.durationMs === "number" && body.durationMs >= 0) patch.durationMs = Math.round(body.durationMs);
    if (typeof body.isCopyrightFree === "boolean") patch.isCopyrightFree = body.isCopyrightFree;
    if (isNonEmpty(body.license, 200)) patch.license = (body.license as string).trim();
    if (typeof body.attribution === "string") patch.attribution = (body.attribution as string).slice(0, 500) || null;
    if (typeof body.isActive === "boolean") patch.isActive = body.isActive;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No changes provided" });
      return;
    }

    const [updated] = await db
      .update(soundLibraryTable)
      .set(patch)
      .where(eq(soundLibraryTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(buildEntry(updated));
  },
);

// =========================================================
// ADMIN: DELETE LIBRARY ENTRY
// =========================================================
router.delete(
  "/admin/sound-design/library/:id",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const id = param(req.params.id as string | string[]);
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    const result = await db
      .delete(soundLibraryTable)
      .where(eq(soundLibraryTable.id, id))
      .returning({ id: soundLibraryTable.id });
    if (result.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(204).send();
  },
);

// =========================================================
// ADMIN: STATS DASHBOARD
// =========================================================
router.get(
  "/admin/sound-design/stats",
  requireAuth,
  requireRole("super_admin"),
  async (_req, res): Promise<void> => {
    const totalLibRows = await db.select({ value: count() }).from(soundLibraryTable);
    const activeLibRows = await db
      .select({ value: count() })
      .from(soundLibraryTable)
      .where(eq(soundLibraryTable.isActive, true));
    const totalAnalysesRows = await db.select({ value: count() }).from(soundAnalysesTable);
    const aggRows = await db
      .select({
        totalDecisions: count(),
        totalKept: sql<number>`SUM(CASE WHEN ${soundDecisionsTable.decision} = 'kept' THEN 1 ELSE 0 END)`,
        totalReplaced: sql<number>`SUM(CASE WHEN ${soundDecisionsTable.decision} = 'replaced' THEN 1 ELSE 0 END)`,
        totalAdded: sql<number>`SUM(CASE WHEN ${soundDecisionsTable.decision} = 'added' THEN 1 ELSE 0 END)`,
      })
      .from(soundDecisionsTable);

    const byCategory = await db
      .select({
        category: soundLibraryTable.category,
        value: count(),
      })
      .from(soundLibraryTable)
      .groupBy(soundLibraryTable.category)
      .orderBy(desc(count()))
      .limit(20);

    const topReplaced = await db
      .select({
        soundId: soundLibraryTable.id,
        soundName: soundLibraryTable.name,
        usageCount: count(soundDecisionsTable.id),
      })
      .from(soundDecisionsTable)
      .leftJoin(soundLibraryTable, eq(soundLibraryTable.id, soundDecisionsTable.replacementSoundId))
      .where(eq(soundDecisionsTable.decision, "replaced"))
      .groupBy(soundLibraryTable.id, soundLibraryTable.name)
      .orderBy(desc(count(soundDecisionsTable.id)))
      .limit(10);

    res.json({
      totalLibraryEntries: Number(totalLibRows[0]?.value ?? 0),
      activeLibraryEntries: Number(activeLibRows[0]?.value ?? 0),
      totalAnalyses: Number(totalAnalysesRows[0]?.value ?? 0),
      totalDecisions: Number(aggRows[0]?.totalDecisions ?? 0),
      totalKept: Number(aggRows[0]?.totalKept ?? 0),
      totalReplaced: Number(aggRows[0]?.totalReplaced ?? 0),
      totalAdded: Number(aggRows[0]?.totalAdded ?? 0),
      byCategory: byCategory.map((c) => ({ category: c.category, count: Number(c.value) })),
      topReplacedSounds: topReplaced.map((t) => ({
        soundId: t.soundId ?? null,
        soundName: t.soundName ?? null,
        usageCount: Number(t.usageCount),
      })),
    });
  },
);

export default router;
