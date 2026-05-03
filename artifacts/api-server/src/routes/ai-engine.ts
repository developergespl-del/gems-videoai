/**
 * AI Core Engine Routes — 3-Step Workflow
 *
 * Step 1  POST /videos/:id/analysis/trigger   — Deep AI analysis
 * Step 2  POST /videos/:id/screenplay         — Screenplay generation (requires Step 1)
 * Step 3  POST /videos/:id/generate           — Start rendering  (requires Step 2)
 *
 * Read endpoints:
 *   GET /videos/:id/analysis                  — Full analysis + screenplay
 *   POST /ai/analyze                          — On-demand analysis
 *   POST /ai/analyze/stream                   — Streaming analysis
 *   POST /ai/thinking                         — Human-like thinking narration
 *   POST /ai/cultural-analysis                — Deep Indian cultural analysis
 *   POST /ai/age-progression                  — Character age transformation
 */
import { Router, type IRouter } from "express";
import { db, videosTable, videoAnalysesTable, renderScenesTable, paranormalProfilesTable, marketingAssetsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  analyzeVideoInput,
  analyzeVideoInputStream,
  generateThinkingNarrative,
  deepCulturalAnalysis,
  analyzeAgeProgression,
  type FullAnalysis,
} from "../lib/ai-core-engine";
import { generateScreenplay, type ParanormalContext, type CinemaSpec } from "../lib/screenplay-engine";
import { generateAudioRealismProfile } from "../lib/audio-engine";
import { analyzeParanormalElements } from "../lib/paranormal-engine";
import {
  planAssets,
  generateTrailerContent,
  generatePosterImageBuffer,
  generateThumbnailImageBuffer,
  type VideoContext,
} from "../lib/marketing-assets-engine";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Scene title banks per priority tier
// ---------------------------------------------------------------------------
const SCENE_TITLES_ENTERPRISE = [
  "Opening Shot", "Character Introduction", "Rising Action",
  "First Conflict", "Midpoint Turn", "Climax Build", "Resolution", "End Credits",
];
const SCENE_TITLES_PAID = [
  "Establishing Shot", "Rising Action", "Climax Scene", "Resolution", "End Credits",
];
const SCENE_TITLES_FREE = ["Opening Scene", "Main Sequence", "Closing Scene"];

// ---------------------------------------------------------------------------
// GET /videos/:id/analysis
// ---------------------------------------------------------------------------
router.get("/videos/:id/analysis", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const [analysis] = await db
    .select()
    .from(videoAnalysesTable)
    .where(eq(videoAnalysesTable.videoId, id));

  if (!analysis) {
    res.status(404).json({ error: "Analysis not yet available", status: "pending" });
    return;
  }

  // Merge generationStage from the video into the response for easy frontend use
  res.json({
    ...analysis,
    generationStage: video.generationStage,
    // Explicit audio + realism fields (already in analysis, but ensure they're visible)
    audioStatus: analysis.audioStatus,
    audioProfile: analysis.audioProfile,
    realismProfile: analysis.realismProfile,
  });
});

// ---------------------------------------------------------------------------
// POST /videos/:id/analysis/trigger — manually re-trigger analysis
// ---------------------------------------------------------------------------
router.post("/videos/:id/analysis/trigger", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  let analysisId: string;
  const [existing] = await db
    .select()
    .from(videoAnalysesTable)
    .where(eq(videoAnalysesTable.videoId, id));

  if (existing) {
    await db.update(videoAnalysesTable)
      .set({ status: "analyzing", screenplayStatus: "pending", screenplay: null })
      .where(eq(videoAnalysesTable.videoId, id));
    analysisId = existing.id;
  } else {
    const [created] = await db.insert(videoAnalysesTable).values({
      videoId: id,
      status: "analyzing",
    }).returning();
    analysisId = created.id;
  }

  // Reset stage
  await db.update(videosTable)
    .set({ generationStage: "analyzing" })
    .where(eq(videosTable.id, id));

  res.json({ message: "Analysis started", analysisId, status: "analyzing" });

  runAnalysisAsync(id, analysisId, video).catch((err) => {
    logger.error({ err, videoId: id }, "Background re-analysis failed");
  });
});

// ---------------------------------------------------------------------------
// POST /videos/:id/screenplay — Step 2: generate screenplay from analysis
// ---------------------------------------------------------------------------
router.post("/videos/:id/screenplay", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  if (video.generationStage !== "analyzed") {
    res.status(400).json({
      error: "Analysis must be completed before generating screenplay",
      currentStage: video.generationStage,
    });
    return;
  }

  const [analysis] = await db
    .select()
    .from(videoAnalysesTable)
    .where(eq(videoAnalysesTable.videoId, id));

  if (!analysis || analysis.status !== "completed") {
    res.status(400).json({ error: "Analysis not complete" });
    return;
  }

  // Mark screenplay as generating
  await db.update(videoAnalysesTable)
    .set({ screenplayStatus: "generating" })
    .where(eq(videoAnalysesTable.videoId, id));

  res.json({ message: "Screenplay generation started", status: "generating" });

  // Run screenplay + auto-audio generation async
  generateScreenplayAsync(id, video, analysis).catch((err) => {
    logger.error({ err, videoId: id }, "Background screenplay generation failed");
  });
});

// ---------------------------------------------------------------------------
// POST /videos/:id/generate — Step 3: start video rendering
// ---------------------------------------------------------------------------
router.post("/videos/:id/generate", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  if (video.generationStage !== "screenwrote") {
    res.status(400).json({
      error: "Screenplay must be approved before rendering",
      currentStage: video.generationStage,
    });
    return;
  }

  // Priority config
  const PRIORITY_CONFIG = {
    enterprise: { scenes: SCENE_TITLES_ENTERPRISE, parallelWorkers: 5, msPerTick: 600, workerType: "gpu" as const, queueWaitMs: 0,    estimatedSeconds: 8  },
    paid:       { scenes: SCENE_TITLES_PAID,       parallelWorkers: 3, msPerTick: 1200, workerType: "gpu" as const, queueWaitMs: 2000,  estimatedSeconds: 15 },
    free:       { scenes: SCENE_TITLES_FREE,        parallelWorkers: 1, msPerTick: 2800, workerType: "cpu" as const, queueWaitMs: 5000,  estimatedSeconds: 40 },
  };
  const cfg = PRIORITY_CONFIG[video.priority as keyof typeof PRIORITY_CONFIG] ?? PRIORITY_CONFIG.free;

  // Create scene records — delete first to prevent duplicates if worker already inserted scenes
  await db.delete(renderScenesTable).where(eq(renderScenesTable.videoId, id));
  const sceneInserts = cfg.scenes.map((title, idx) => ({
    videoId: id,
    sceneIndex: idx,
    sceneTitle: title,
    status: "queued" as const,
    progress: 0,
    workerId: null,
  }));
  await db.insert(renderScenesTable).values(sceneInserts);

  // Update video with scene count + queue position
  const queuePos = video.priority === "enterprise" ? 0 : video.priority === "paid" ? Math.floor(Math.random() * 3) + 1 : Math.floor(Math.random() * 10) + 5;
  await db.update(videosTable).set({
    generationStage: "rendering",
    status: "processing",
    progress: 0,
    sceneCount: cfg.scenes.length,
    scenesCompleted: 0,
    workerType: cfg.workerType,
    estimatedSeconds: cfg.estimatedSeconds,
    queuePosition: queuePos,
    processingStartedAt: new Date(),
  }).where(eq(videosTable.id, id));

  res.json({ message: "Video rendering started", status: "rendering", priority: video.priority, estimatedSeconds: cfg.estimatedSeconds });

  // Run parallel scene rendering
  simulateParallelRendering(id, video.priority, cfg).catch((err) => {
    logger.error({ err, videoId: id }, "Rendering simulation failed");
  });
});

// ---------------------------------------------------------------------------
// POST /videos/:id/audio-profile — manually trigger / re-trigger audio+realism
// ---------------------------------------------------------------------------
router.post("/videos/:id/audio-profile", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const [analysis] = await db
    .select()
    .from(videoAnalysesTable)
    .where(eq(videoAnalysesTable.videoId, id));

  if (!analysis || analysis.screenplayStatus !== "completed") {
    res.status(400).json({ error: "Screenplay must be completed before generating audio profile" });
    return;
  }

  res.json({ message: "Audio profile generation started", status: "generating" });

  generateAudioRealismAsync(id, video, analysis, analysis.screenplay).catch((err) => {
    logger.error({ err, videoId: id }, "Manual audio profile generation failed");
  });
});

// ---------------------------------------------------------------------------
// GET /videos/:id/scenes — scene-wise render progress
// ---------------------------------------------------------------------------
router.get("/videos/:id/scenes", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)));

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  const scenes = await db
    .select()
    .from(renderScenesTable)
    .where(eq(renderScenesTable.videoId, id));

  res.json(scenes.sort((a, b) => a.sceneIndex - b.sceneIndex));
});

// ---------------------------------------------------------------------------
// POST /ai/analyze — on-demand analysis
// ---------------------------------------------------------------------------
router.post("/ai/analyze", requireAuth, async (req, res): Promise<void> => {
  const { inputType, inputContent, style, durationSeconds, title } = req.body as {
    inputType: "story" | "script" | "image";
    inputContent: string;
    style: string;
    durationSeconds: number;
    title: string;
  };

  if (!inputType || !inputContent || !style || !durationSeconds || !title) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const analysis = await analyzeVideoInput({ inputType, inputContent, style, durationSeconds, title });
    res.json({ analysis });
  } catch (err) {
    req.log.error({ err }, "AI analysis failed");
    res.status(500).json({ error: "AI analysis failed", message: String(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/analyze/stream — streaming SSE analysis
// ---------------------------------------------------------------------------
router.post("/ai/analyze/stream", requireAuth, async (req, res): Promise<void> => {
  const { inputType, inputContent, style, durationSeconds, title } = req.body as {
    inputType: "story" | "script" | "image";
    inputContent: string;
    style: string;
    durationSeconds: number;
    title: string;
  };

  if (!inputType || !inputContent || !style || !durationSeconds || !title) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullText = "";
  try {
    const stream = analyzeVideoInputStream({ inputType, inputContent, style, durationSeconds, title });
    for await (const chunk of stream) {
      fullText += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }
    let analysis: FullAnalysis | null = null;
    try { analysis = JSON.parse(fullText); } catch { /* partial */ }
    res.write(`data: ${JSON.stringify({ done: true, analysis })}\n\n`);
  } catch (err) {
    req.log.error({ err }, "Streaming AI analysis failed");
    res.write(`data: ${JSON.stringify({ error: String(err) })}\n\n`);
  }
  res.end();
});

// ---------------------------------------------------------------------------
// POST /ai/thinking — human-like thinking narration
// ---------------------------------------------------------------------------
router.post("/ai/thinking", requireAuth, async (req, res): Promise<void> => {
  const { inputType, inputContent, style } = req.body as {
    inputType: "story" | "script" | "image";
    inputContent: string;
    style: string;
  };

  if (!inputType || !inputContent || !style) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const thoughts = await generateThinkingNarrative({ inputType, inputContent, style });
    res.json({ thoughts });
  } catch (err) {
    req.log.error({ err }, "Thinking narrative failed");
    res.status(500).json({ error: "Failed to generate thinking narrative" });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/cultural-analysis — deep Indian cultural intelligence
// ---------------------------------------------------------------------------
router.post("/ai/cultural-analysis", requireAuth, async (req, res): Promise<void> => {
  const { inputContent, region, horrorMode } = req.body as {
    inputContent: string;
    region: string;
    horrorMode: boolean;
  };

  if (!inputContent || !region) {
    res.status(400).json({ error: "Missing required fields: inputContent, region" });
    return;
  }

  try {
    const culturalContext = await deepCulturalAnalysis({ inputContent, region, horrorMode: Boolean(horrorMode) });
    res.json({ culturalContext });
  } catch (err) {
    req.log.error({ err }, "Cultural analysis failed");
    res.status(500).json({ error: "Cultural analysis failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /ai/age-progression — character age transformation
// ---------------------------------------------------------------------------
router.post("/ai/age-progression", requireAuth, async (req, res): Promise<void> => {
  const { characterName, fromAge, toAge, gender, ethnicity } = req.body as {
    characterName: string;
    fromAge: number;
    toAge: number;
    gender: string;
    ethnicity: string;
  };

  if (!characterName || !fromAge || !toAge || !gender) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const progression = await analyzeAgeProgression({
      characterName,
      fromAge,
      toAge,
      gender,
      ethnicity: ethnicity || "Indian",
    });
    res.json({ progression });
  } catch (err) {
    req.log.error({ err }, "Age progression analysis failed");
    res.status(500).json({ error: "Age progression analysis failed" });
  }
});

// ---------------------------------------------------------------------------
// Background async helpers
// ---------------------------------------------------------------------------

export async function runAnalysisAsync(
  videoId: string,
  analysisId: string,
  video: { title: string; inputType: string; inputContent: string; style: string; durationSeconds: number }
) {
  try {
    const analysis = await analyzeVideoInput({
      inputType: video.inputType as "story" | "script" | "image",
      inputContent: video.inputContent,
      style: video.style,
      durationSeconds: video.durationSeconds,
      title: video.title,
    });

    await db.update(videoAnalysesTable).set({
      status: "completed",
      contextAnalysis: analysis.contextAnalysis as any,
      emotionalProfile: analysis.emotionalProfile as any,
      characterProfiles: analysis.characterProfiles as any,
      culturalContext: analysis.culturalContext as any,
      sceneBreakdown: analysis.sceneBreakdown as any,
      dialogueStyle: analysis.dialogueStyle as any,
      productionPlan: analysis.productionPlan as any,
      voiceDirections: analysis.voiceDirections as any,
      primaryEmotion: analysis.primaryEmotion,
      culturalSetting: analysis.culturalSetting,
      regionLanguage: analysis.regionLanguage,
      narrativeTone: analysis.narrativeTone,
      estimatedSceneCount: analysis.estimatedSceneCount,
    }).where(eq(videoAnalysesTable.id, analysisId));

    // Advance the video to Step 2 ready state — ONLY if still in "analyzing".
    // The background worker may have already progressed to screenwrote/rendering/completed;
    // overwriting it would regress the UI and break the generation flow.
    const [currentVideo] = await db
      .select({ generationStage: videosTable.generationStage })
      .from(videosTable)
      .where(eq(videosTable.id, videoId))
      .limit(1);

    if (currentVideo?.generationStage === "analyzing") {
      await db.update(videosTable)
        .set({ generationStage: "analyzed" })
        .where(eq(videosTable.id, videoId));
      logger.info({ videoId, analysisId }, "AI Core Engine: analysis stored, stage → analyzed");
    } else {
      logger.info(
        { videoId, analysisId, currentStage: currentVideo?.generationStage },
        "AI Core Engine: analysis stored — stage preserved (worker already progressed)"
      );
    }

    // Auto-trigger paranormal / supernatural / VFX intelligence (fire-and-forget)
    runParanormalAnalysisAsync(videoId, video, {
      characterProfiles: analysis.characterProfiles,
      sceneBreakdown: analysis.sceneBreakdown,
      narrativeTone: analysis.narrativeTone,
      primaryEmotion: analysis.primaryEmotion,
    }).catch((err) =>
      logger.error({ err, videoId }, "Paranormal Engine: background auto-analysis failed")
    );
  } catch (err) {
    logger.error({ err, videoId, analysisId }, "AI Core Engine: analysis failed");
    // Only mark the analysis record as failed — never touch video.generationStage.
    // The worker owns generationStage exclusively; overwriting it here would
    // cause the frontend to show "Failed" and stop polling even while the
    // Gemini worker is still running and will complete the video successfully.
    await db.update(videoAnalysesTable)
      .set({ status: "failed" })
      .where(eq(videoAnalysesTable.id, analysisId));
  }
}

async function generateScreenplayAsync(
  videoId: string,
  video: { title: string; style: string; durationSeconds: number; inputType: string; inputContent: string },
  analysis: { contextAnalysis: unknown; emotionalProfile: unknown; characterProfiles: unknown;
               culturalContext: unknown; sceneBreakdown: unknown; dialogueStyle: unknown;
               productionPlan: unknown; voiceDirections: unknown;
               primaryEmotion: string | null; regionLanguage: string | null; narrativeTone: string | null }
) {
  try {
    const fullAnalysis = {
      contextAnalysis: analysis.contextAnalysis,
      emotionalProfile: analysis.emotionalProfile,
      characterProfiles: analysis.characterProfiles,
      culturalContext: analysis.culturalContext,
      sceneBreakdown: analysis.sceneBreakdown,
      dialogueStyle: analysis.dialogueStyle,
      productionPlan: analysis.productionPlan,
      voiceDirections: analysis.voiceDirections,
    } as FullAnalysis;

    // Fetch video's cinema-grade output settings for prompt injection
    let cinemaSpec: CinemaSpec | null = null;
    try {
      const [vRow] = await db
        .select({
          aspectRatio: videosTable.aspectRatio,
          resolution: videosTable.resolution,
          cinemaMode: videosTable.cinemaMode,
          colorGrade: videosTable.colorGrade,
          filmGrain: videosTable.filmGrain,
          depthOfField: videosTable.depthOfField,
          audioMastering: videosTable.audioMastering,
          exportFormats: videosTable.exportFormats,
        })
        .from(videosTable)
        .where(eq(videosTable.id, videoId))
        .limit(1);
      if (vRow) cinemaSpec = {
        aspectRatio: vRow.aspectRatio,
        resolution: vRow.resolution,
        cinemaMode: vRow.cinemaMode,
        colorGrade: vRow.colorGrade,
        filmGrain: vRow.filmGrain,
        depthOfField: vRow.depthOfField,
        audioMastering: vRow.audioMastering,
        exportFormats: vRow.exportFormats as string[],
      };
    } catch {
      logger.warn({ videoId }, "Screenplay Engine: could not fetch cinema spec — continuing without it");
    }

    // Fetch auto-generated paranormal profile if available
    let paranormalContext: ParanormalContext | null = null;
    try {
      const [paranormalRow] = await db
        .select()
        .from(paranormalProfilesTable)
        .where(eq(paranormalProfilesTable.videoId, videoId))
        .limit(1);
      if (paranormalRow && paranormalRow.status === "completed") {
        paranormalContext = {
          hasParanormalElements: paranormalRow.hasParanormalElements,
          contentTypes: paranormalRow.contentTypes,
          characterAbilities: paranormalRow.characterAbilities as unknown[],
          vfxRequirements: paranormalRow.vfxRequirements as unknown[],
          atmosphereProfile: paranormalRow.atmosphereProfile,
          physicsRules: paranormalRow.physicsRules as unknown[],
          styleDirectives: paranormalRow.styleDirectives,
          culturalBlend: paranormalRow.culturalBlend,
          realismDirectives: paranormalRow.realismDirectives,
          sceneVfxMap: paranormalRow.sceneVfxMap as unknown[],
        };
        logger.info({ videoId, contentTypes: paranormalContext.contentTypes },
          "Screenplay Engine: paranormal VFX profile injected");
      }
    } catch (pErr) {
      logger.warn({ pErr, videoId }, "Screenplay Engine: failed to fetch paranormal profile — continuing without it");
    }

    const screenplay = await generateScreenplay({
      analysis: fullAnalysis,
      title: video.title,
      style: video.style,
      durationSeconds: video.durationSeconds,
      inputType: video.inputType,
      paranormalContext,
      cinemaSpec,
    });

    await db.update(videoAnalysesTable).set({
      screenplayStatus: "completed",
      screenplay: screenplay as any,
    }).where(eq(videoAnalysesTable.videoId, videoId));

    // ── Long-video metadata extraction ──────────────────────────────────────
    const longVideoUpdate: Record<string, unknown> = { generationStage: "screenwrote" };
    try {
      const scenes = (screenplay as any).scenes as Array<Record<string, unknown>> ?? [];
      // Accumulate timing by walking scenes in order
      let accSeconds = 0;
      let intermissionAtSecond: number | null = null;
      let splitAtSecond: number | null = null;
      let hasIntermission = false;
      let isSplit = false;

      for (const scene of scenes) {
        const dur = typeof scene.duration === "number" ? scene.duration : 0;
        if (scene.isIntermissionScene === true) {
          intermissionAtSecond = accSeconds;
          hasIntermission = true;
        }
        if (scene.isPartBreak === "part1_end") {
          splitAtSecond = accSeconds;
          isSplit = true;
        }
        accSeconds += dur;
      }

      const screenplayTop = screenplay as any;
      if (hasIntermission) {
        longVideoUpdate.hasIntermission = true;
        longVideoUpdate.intermissionAtSecond = intermissionAtSecond;
        longVideoUpdate.intermissionLabel = screenplayTop.intermissionLabel ?? "INTERMISSION";
      }
      if (isSplit) {
        longVideoUpdate.isSplit = true;
        longVideoUpdate.splitAtSecond = splitAtSecond;
        longVideoUpdate.part1Title = screenplayTop.part1ClosingSlate
          ? `${video.title} — Part 1`
          : `${video.title} — Part 1`;
        longVideoUpdate.part2Title = screenplayTop.part2OpeningSlate
          ? `${video.title} — Part 2`
          : `${video.title} — Part 2`;
      }
    } catch (longErr) {
      logger.warn({ longErr, videoId }, "Long-video metadata extraction failed — continuing without it");
    }

    await db.update(videosTable)
      .set(longVideoUpdate as any)
      .where(eq(videosTable.id, videoId));

    logger.info({ videoId, hasIntermission: !!longVideoUpdate.hasIntermission, isSplit: !!longVideoUpdate.isSplit },
      "Screenplay Engine: screenplay stored, stage → screenwrote");

    // Auto-trigger Audio + Realism Profile generation
    generateAudioRealismAsync(videoId, video, analysis, screenplay).catch((err) => {
      logger.error({ err, videoId }, "Audio Engine: auto-trigger failed");
    });
  } catch (err) {
    logger.error({ err, videoId }, "Screenplay Engine: generation failed");
    await db.update(videoAnalysesTable)
      .set({ screenplayStatus: "failed" })
      .where(eq(videoAnalysesTable.videoId, videoId));
  }
}

async function generateAudioRealismAsync(
  videoId: string,
  video: { title: string; style: string; durationSeconds: number; inputContent: string },
  analysis: { contextAnalysis: unknown; emotionalProfile: unknown; characterProfiles: unknown;
               culturalContext: unknown; primaryEmotion: string | null; regionLanguage: string | null; narrativeTone: string | null },
  screenplay: unknown
) {
  try {
    await db.update(videoAnalysesTable)
      .set({ audioStatus: "generating" })
      .where(eq(videoAnalysesTable.videoId, videoId));

    const result = await generateAudioRealismProfile({
      title: video.title,
      inputContent: video.inputContent,
      style: video.style,
      durationSeconds: video.durationSeconds,
      analysis: {
        contextAnalysis: analysis.contextAnalysis,
        emotionalProfile: analysis.emotionalProfile,
        characterProfiles: analysis.characterProfiles,
        culturalContext: analysis.culturalContext,
        primaryEmotion: analysis.primaryEmotion ?? undefined,
        regionLanguage: analysis.regionLanguage ?? undefined,
        narrativeTone: analysis.narrativeTone ?? undefined,
      },
      screenplay,
    });

    await db.update(videoAnalysesTable).set({
      audioStatus: "completed",
      audioProfile: result.audioProfile as any,
      realismProfile: result.realismProfile as any,
    }).where(eq(videoAnalysesTable.videoId, videoId));

    logger.info({ videoId }, "Audio Engine: audio + realism profile stored");
  } catch (err) {
    logger.error({ err, videoId }, "Audio Engine: generation failed");
    await db.update(videoAnalysesTable)
      .set({ audioStatus: "failed" })
      .where(eq(videoAnalysesTable.videoId, videoId));
  }
}

// ---------------------------------------------------------------------------
// Paranormal / Supernatural / Superpower Auto-Analysis
// Runs automatically after deep analysis — completely transparent to the user.
// Results are stored in paranormal_profiles and injected into screenplay generation.
// ---------------------------------------------------------------------------

async function runParanormalAnalysisAsync(
  videoId: string,
  video: { title: string; style: string; inputContent: string; durationSeconds: number },
  analysisContext: {
    characterProfiles: unknown;
    sceneBreakdown: unknown;
    narrativeTone: string | undefined;
    primaryEmotion: string | undefined;
  }
): Promise<void> {
  // Fetch userId from video record
  const [videoRow] = await db
    .select({ userId: videosTable.userId })
    .from(videosTable)
    .where(eq(videosTable.id, videoId))
    .limit(1);

  if (!videoRow) {
    logger.warn({ videoId }, "Paranormal Engine: video not found — skipping");
    return;
  }

  const userId = videoRow.userId;

  // Upsert a paranormal_profiles row with "analyzing" status
  const [existingRow] = await db
    .select({ id: paranormalProfilesTable.id })
    .from(paranormalProfilesTable)
    .where(eq(paranormalProfilesTable.videoId, videoId))
    .limit(1);

  let profileId: string;
  if (existingRow) {
    profileId = existingRow.id;
    await db
      .update(paranormalProfilesTable)
      .set({ status: "analyzing", errorMessage: null, updatedAt: new Date() })
      .where(eq(paranormalProfilesTable.id, profileId));
  } else {
    const [inserted] = await db
      .insert(paranormalProfilesTable)
      .values({ videoId, userId, status: "analyzing" })
      .returning({ id: paranormalProfilesTable.id });
    profileId = inserted.id;
  }

  logger.info({ videoId, profileId }, "Paranormal Engine: auto-analysis started");

  try {
    const profile = await analyzeParanormalElements({
      title: video.title,
      style: video.style,
      inputContent: video.inputContent,
      durationSeconds: video.durationSeconds,
      existingAnalysis: {
        characterProfiles: analysisContext.characterProfiles,
        sceneBreakdown: analysisContext.sceneBreakdown,
        narrativeTone: analysisContext.narrativeTone,
        primaryEmotion: analysisContext.primaryEmotion,
      },
    });

    await db
      .update(paranormalProfilesTable)
      .set({
        status: "completed",
        hasParanormalElements: profile.hasParanormalElements,
        contentTypes: profile.contentTypes,
        characterAbilities: profile.characterAbilities as any,
        vfxRequirements: profile.vfxRequirements as any,
        atmosphereProfile: profile.atmosphereProfile as any,
        physicsRules: profile.physicsRules as any,
        styleDirectives: profile.styleDirectives as any,
        culturalBlend: profile.culturalBlend as any,
        realismDirectives: profile.realismDirectives,
        sceneVfxMap: profile.sceneVfxMap as any,
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(paranormalProfilesTable.id, profileId));

    logger.info(
      { videoId, profileId, contentTypes: profile.contentTypes, hasParanormal: profile.hasParanormalElements },
      "Paranormal Engine: auto-analysis complete and stored"
    );
  } catch (err) {
    logger.error({ err, videoId, profileId }, "Paranormal Engine: auto-analysis failed");
    await db
      .update(paranormalProfilesTable)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        updatedAt: new Date(),
      })
      .where(eq(paranormalProfilesTable.id, profileId));
  }
}

// ---------------------------------------------------------------------------
// GPU-Accelerated Parallel Scene Rendering Simulation
// ---------------------------------------------------------------------------

type RenderConfig = {
  scenes: string[];
  parallelWorkers: number;
  msPerTick: number;
  workerType: "gpu" | "cpu";
  queueWaitMs: number;
  estimatedSeconds: number;
};

const GPU_WORKER_IDS = {
  enterprise: ["GPU-H100-01", "GPU-H100-02", "GPU-H100-03", "GPU-H100-04", "GPU-H100-05"],
  paid:       ["GPU-A100-01", "GPU-A100-02", "GPU-A100-03"],
  free:       ["CPU-Core-01"],
};

async function simulateParallelRendering(videoId: string, priority: string, cfg: RenderConfig) {
  const workerIds = GPU_WORKER_IDS[priority as keyof typeof GPU_WORKER_IDS] ?? GPU_WORKER_IDS.free;

  // Queue wait: simulate enterprise skips queue, others wait
  if (cfg.queueWaitMs > 0) {
    await sleep(cfg.queueWaitMs);
    // Clear queue position once rendering starts
    await db.update(videosTable).set({ queuePosition: 0 }).where(eq(videosTable.id, videoId));
  }

  // Fetch the scene IDs we created
  const scenes = await db
    .select()
    .from(renderScenesTable)
    .where(eq(renderScenesTable.videoId, videoId));
  scenes.sort((a, b) => a.sceneIndex - b.sceneIndex);

  let completedCount = 0;
  const totalScenes = scenes.length;

  // Process scenes in parallel batches
  const renderScene = async (scene: typeof scenes[number], workerIdx: number) => {
    const workerId = workerIds[workerIdx % workerIds.length];
    // Mark scene as rendering
    await db.update(renderScenesTable).set({
      status: "rendering",
      workerId,
      startedAt: new Date(),
      progress: 0,
    }).where(eq(renderScenesTable.id, scene.id));

    // Tick progress 25% → 50% → 75% → 100%
    for (const pct of [25, 50, 75, 100]) {
      await sleep(cfg.msPerTick + Math.random() * (cfg.msPerTick * 0.3));
      await db.update(renderScenesTable).set({ progress: pct }).where(eq(renderScenesTable.id, scene.id));
    }

    // Mark scene completed
    await db.update(renderScenesTable).set({
      status: "completed",
      progress: 100,
      completedAt: new Date(),
    }).where(eq(renderScenesTable.id, scene.id));

    completedCount++;
    const overallProgress = Math.round((completedCount / totalScenes) * 90);
    await db.update(videosTable).set({
      scenesCompleted: completedCount,
      progress: overallProgress,
    }).where(eq(videosTable.id, videoId));

    logger.info({ videoId, scene: scene.sceneTitle, completedCount, totalScenes, workerId }, "Scene rendered");
  };

  // Batch scenes by parallelWorkers
  for (let i = 0; i < scenes.length; i += cfg.parallelWorkers) {
    const batch = scenes.slice(i, i + cfg.parallelWorkers);
    await Promise.all(batch.map((scene, idx) => renderScene(scene, i + idx)));
  }

  // Final compositing step
  await sleep(cfg.msPerTick);
  await db.update(videosTable).set({
    generationStage: "completed",
    status: "completed",
    progress: 100,
    completedAt: new Date(),
    thumbnailUrl: `https://picsum.photos/seed/${videoId}/800/450`,
  }).where(eq(videosTable.id, videoId));

  logger.info({ videoId, priority }, "Parallel rendering complete");

  // Auto-trigger marketing assets generation now that the video is complete
  const [completedVideo] = await db.select().from(videosTable).where(eq(videosTable.id, videoId));
  if (completedVideo) {
    autoTriggerMarketingAssets(completedVideo).catch((err) => {
      logger.warn({ err: String(err), videoId }, "Auto marketing assets: trigger failed (non-blocking)");
    });
  }
}

// ============================================================
// Auto marketing assets — triggered when a video completes
// ============================================================

async function autoTriggerMarketingAssets(
  video: typeof videosTable.$inferSelect,
): Promise<void> {
  // Skip if assets already exist for this video
  const existing = await db
    .select({ id: marketingAssetsTable.id })
    .from(marketingAssetsTable)
    .where(eq(marketingAssetsTable.videoId, video.id));
  if (existing.length > 0) return;

  const language = video.language ?? "hi";
  const assetTypes = planAssets(video.durationSeconds);
  if (assetTypes.length === 0) return;

  const inserted = await db
    .insert(marketingAssetsTable)
    .values(
      assetTypes.map((t) => ({
        videoId: video.id,
        userId: video.userId,
        assetType: t,
        status: "generating" as const,
        language,
        title: video.title,
      })),
    )
    .returning();

  logger.info({ videoId: video.id, assetTypes, language }, "Auto marketing assets: generation started");

  const ctx: VideoContext = {
    id: video.id,
    title: video.title,
    description: video.description,
    inputContent: video.inputContent,
    style: video.style,
    durationSeconds: video.durationSeconds,
    language,
  };

  for (const asset of inserted) {
    generateMarketingAsset(ctx, asset.id, asset.assetType).catch((err) => {
      logger.warn({ err: String(err), assetId: asset.id }, "Auto marketing assets: asset failed");
      db.update(marketingAssetsTable)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          updatedAt: new Date(),
        })
        .where(eq(marketingAssetsTable.id, asset.id))
        .catch(() => {});
    });
  }
}

async function generateMarketingAsset(ctx: VideoContext, assetId: string, assetType: string): Promise<void> {
  if (assetType === "trailer") {
    const content = await generateTrailerContent(ctx);
    await db.update(marketingAssetsTable).set({
      status: "completed",
      trailerContent: content as any,
      title: ctx.title,
      tagline: content.closingTagline || null,
      updatedAt: new Date(),
    }).where(eq(marketingAssetsTable.id, assetId));
  } else if (assetType === "poster") {
    const { buffer, prompt } = await generatePosterImageBuffer(ctx);
    await db.update(marketingAssetsTable).set({
      status: "completed",
      imageData: `data:image/png;base64,${buffer.toString("base64")}`,
      generationPrompt: prompt,
      title: ctx.title,
      updatedAt: new Date(),
    }).where(eq(marketingAssetsTable.id, assetId));
  } else if (assetType === "thumbnail") {
    const { buffer, prompt } = await generateThumbnailImageBuffer(ctx);
    await db.update(marketingAssetsTable).set({
      status: "completed",
      imageData: `data:image/png;base64,${buffer.toString("base64")}`,
      generationPrompt: prompt,
      title: ctx.title,
      updatedAt: new Date(),
    }).where(eq(marketingAssetsTable.id, assetId));
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default router;
