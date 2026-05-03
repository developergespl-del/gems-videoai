import { Router, type IRouter } from "express";
import { db, videosTable, projectsTable, videoAnalysesTable, specialAccessTable, videoPlansTable, userVideoPlansTable, languagesTable } from "@workspace/db";
import { eq, and, count, desc, ilike, gte, inArray } from "drizzle-orm";
import { CreateVideoBody, UpdateVideoBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { videoCreateLimiter, moderateContent } from "../middlewares/security";
import { logger } from "../lib/logger";
import { runAnalysisAsync } from "./ai-engine";
import { enqueueVideo } from "../lib/redis";
import { enqueueVideoUpstash } from "../lib/upstash";
import { getSignedVideoUrl } from "../lib/s3";

const router: IRouter = Router();

function formatVideo(v: typeof videosTable.$inferSelect) {
  return {
    id: v.id,
    userId: v.userId,
    projectId: v.projectId ?? null,
    title: v.title,
    description: v.description ?? null,
    inputType: v.inputType,
    inputContent: v.inputContent,
    style: v.style,
    durationSeconds: v.durationSeconds,
    status: v.status,
    progress: v.progress,
    generationStage: v.generationStage,
    priority: v.priority,
    workerType: v.workerType,
    sceneCount: v.sceneCount,
    scenesCompleted: v.scenesCompleted,
    estimatedSeconds: v.estimatedSeconds ?? null,
    queuePosition: v.queuePosition ?? null,
    processingStartedAt: v.processingStartedAt ?? null,
    outputUrl: v.outputUrl ?? null,
    thumbnailUrl: v.thumbnailUrl ?? null,
    errorMessage: v.errorMessage ?? null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    completedAt: v.completedAt ?? null,
    // Cinema-grade output settings
    aspectRatio: v.aspectRatio,
    resolution: v.resolution,
    cinemaMode: v.cinemaMode,
    colorGrade: v.colorGrade,
    filmGrain: v.filmGrain,
    depthOfField: v.depthOfField,
    audioMastering: v.audioMastering,
    exportFormats: v.exportFormats,
    // Long-video split + intermission
    hasIntermission: v.hasIntermission,
    intermissionAtSecond: v.intermissionAtSecond ?? null,
    intermissionLabel: v.intermissionLabel ?? null,
    isSplit: v.isSplit,
    splitAtSecond: v.splitAtSecond ?? null,
    part1Title: v.part1Title ?? null,
    part2Title: v.part2Title ?? null,
    // Bulk generation
    language: v.language ?? null,
    bulkBatchId: v.bulkBatchId ?? null,
  };
}

function roleToPriority(role: string): "enterprise" | "paid" | "free" {
  if (role === "super_admin") return "enterprise";
  if (role === "admin") return "paid";
  return "free";
}

// ── Bulk Language Video Generation (Super Admin only) ────────────────────────
router.post("/videos/bulk-generate", requireAuth, async (req, res): Promise<void> => {
  if (req.user!.role !== "super_admin") {
    res.status(403).json({ error: "Forbidden", message: "Bulk generation is only available to Super Admin." });
    return;
  }

  const body = req.body as Record<string, unknown>;

  // Manual validation
  if (!body.title || typeof body.title !== "string" || body.title.trim().length === 0) {
    res.status(400).json({ error: "Validation error", message: "title is required" });
    return;
  }
  const VALID_INPUT_TYPES = ["story", "script", "image"];
  if (!VALID_INPUT_TYPES.includes(body.inputType as string)) {
    res.status(400).json({ error: "Validation error", message: "invalid inputType" });
    return;
  }
  if (!body.inputContent || typeof body.inputContent !== "string" || body.inputContent.trim().length === 0) {
    res.status(400).json({ error: "Validation error", message: "inputContent is required" });
    return;
  }
  const VALID_STYLES = ["cinematic", "documentary", "dramatic", "action", "romantic", "horror", "comedy"];
  if (!VALID_STYLES.includes(body.style as string)) {
    res.status(400).json({ error: "Validation error", message: "invalid style" });
    return;
  }
  const durationSeconds = Number(body.durationSeconds);
  if (!durationSeconds || durationSeconds < 10 || durationSeconds > 10800) {
    res.status(400).json({ error: "Validation error", message: "durationSeconds must be 10–10800" });
    return;
  }
  if (!Array.isArray(body.languageIds) || (body.languageIds as string[]).length === 0) {
    res.status(400).json({ error: "Validation error", message: "languageIds must be a non-empty array" });
    return;
  }

  const data = {
    title: (body.title as string).trim(),
    inputType: body.inputType as "story" | "script" | "image",
    inputContent: body.inputContent as string,
    style: body.style as "cinematic" | "documentary" | "dramatic" | "action" | "romantic" | "horror" | "comedy",
    durationSeconds,
    languageIds: body.languageIds as string[],
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    aspectRatio: (body.aspectRatio as string) ?? "16:9",
    resolution: (body.resolution as string) ?? "1080p",
    colorGrade: (body.colorGrade as string) ?? "natural",
    filmGrain: Boolean(body.filmGrain ?? false),
    depthOfField: Boolean(body.depthOfField ?? true),
    audioMastering: (body.audioMastering as string) ?? "stereo",
    exportFormats: Array.isArray(body.exportFormats) ? body.exportFormats as string[] : ["youtube"],
  };
  const batchId = crypto.randomUUID();

  // Fetch requested languages
  const langs = await db
    .select({ id: languagesTable.id, code: languagesTable.code, name: languagesTable.name, flag: languagesTable.flag, enabled: languagesTable.enabled })
    .from(languagesTable)
    .where(inArray(languagesTable.id, data.languageIds));

  if (langs.length === 0) {
    res.status(400).json({ error: "No valid languages found" });
    return;
  }

  const resolution = data.resolution ?? "1080p";
  const cinemaMode = resolution === "4K" || resolution === "8K";

  // Insert all videos simultaneously
  const insertedVideos = await Promise.all(
    langs.map(async (lang) => {
      const [video] = await db.insert(videosTable).values({
        userId: req.user!.userId,
        projectId: data.projectId ?? null,
        title: `${data.title} [${lang.name}]`,
        description: null,
        inputType: data.inputType,
        inputContent: data.inputContent,
        style: data.style,
        durationSeconds: data.durationSeconds,
        status: "pending",
        progress: 0,
        priority: "enterprise",
        workerType: "gpu",
        aspectRatio: data.aspectRatio as "16:9" | "9:16" | "21:9" | "2.39:1",
        resolution: resolution as "1080p" | "2K" | "4K" | "8K",
        cinemaMode,
        colorGrade: data.colorGrade as "natural" | "warm" | "cold" | "noir" | "vibrant" | "indian-vivid",
        filmGrain: data.filmGrain ?? false,
        depthOfField: data.depthOfField ?? true,
        audioMastering: data.audioMastering as "stereo" | "surround-ready",
        exportFormats: data.exportFormats ?? ["youtube"],
        characterMappings: [],
        language: lang.code,
        bulkBatchId: batchId,
      } as any).returning();
      return { video, lang };
    })
  );

  // Kick off analysis + queue for each video (non-blocking)
  for (const { video, lang: _lang } of insertedVideos) {
    const [analysis] = await db.insert(videoAnalysesTable).values({
      videoId: video.id,
      status: "analyzing",
    }).returning();

    runAnalysisAsync(video.id, analysis.id, {
      title: video.title,
      inputType: video.inputType,
      inputContent: video.inputContent,
      style: video.style,
      durationSeconds: video.durationSeconds,
    }).catch((err) => {
      logger.error({ err, videoId: video.id }, "Bulk: AI analysis failed");
    });

    enqueueVideoUpstash(video.id).then((ok) => {
      if (!ok) enqueueVideo(video.id).catch(() => {});
    }).catch(() => {});
  }

  res.status(201).json({
    batchId,
    videos: insertedVideos.map(({ video, lang }) => ({
      id: video.id,
      languageId: lang.id,
      languageCode: lang.code,
      languageName: lang.name,
      languageFlag: lang.flag,
      title: video.title,
      status: video.status,
    })),
  });
});

router.get("/videos", requireAuth, async (req, res): Promise<void> => {
  const page = parseInt(String(req.query.page || "1"), 10);
  const limit = parseInt(String(req.query.limit || "20"), 10);
  const status = req.query.status as string | undefined;
  const projectId = req.query.projectId as string | undefined;
  const search = req.query.search as string | undefined;
  const offset = (page - 1) * limit;

  const conditions = [eq(videosTable.userId, req.user!.userId)];
  if (status) conditions.push(eq(videosTable.status, status as any));
  if (projectId) conditions.push(eq(videosTable.projectId, projectId));
  if (search?.trim()) conditions.push(ilike(videosTable.title, `%${search.trim()}%`));

  const videos = await db
    .select()
    .from(videosTable)
    .where(and(...conditions))
    .orderBy(desc(videosTable.createdAt))
    .limit(limit)
    .offset(offset);

  const [totalResult] = await db
    .select({ count: count() })
    .from(videosTable)
    .where(and(...conditions));

  res.json({
    videos: videos.map(formatVideo),
    total: totalResult?.count ?? 0,
    page,
    limit,
  });
});

router.post("/videos", requireAuth, videoCreateLimiter, async (req, res): Promise<void> => {
  const parsed = CreateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // ── Permission gate: super_admin always allowed; others need canGenerateVideos ──
  if (req.user!.role !== "super_admin") {
    const [access] = await db
      .select()
      .from(specialAccessTable)
      .where(eq(specialAccessTable.userId, req.user!.userId))
      .limit(1);
    const now = new Date();
    const isLive = access?.isActive && (!access.expiresAt || access.expiresAt > now);
    if (!isLive || !access?.canGenerateVideos) {
      res.status(403).json({
        error: "Forbidden",
        message: "Video generation access required. Contact your Super Admin to grant permission.",
      });
      return;
    }
  }

  // ── Monthly quota check (skip for super_admin) ───────────────────────────
  if (req.user!.role !== "super_admin") {
    const userId = req.user!.userId;
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const [usageRow] = await db
      .select({ cnt: count() })
      .from(videosTable)
      .where(and(eq(videosTable.userId, userId), gte(videosTable.createdAt, startOfMonth)));
    const videosThisMonth = Number(usageRow?.cnt ?? 0);

    // Get active paid plan or fall back to default plan
    const [activeSub] = await db
      .select({ planId: userVideoPlansTable.planId })
      .from(userVideoPlansTable)
      .where(and(eq(userVideoPlansTable.userId, userId), eq(userVideoPlansTable.status, "active")))
      .limit(1);

    let effectivePlan = null;
    if (activeSub) {
      [effectivePlan] = await db.select().from(videoPlansTable).where(eq(videoPlansTable.id, activeSub.planId));
    } else {
      [effectivePlan] = await db
        .select()
        .from(videoPlansTable)
        .where(and(eq(videoPlansTable.isDefault, true), eq(videoPlansTable.isActive, true)))
        .limit(1);
    }

    const quota = effectivePlan?.monthlyQuota ?? 3;
    if (videosThisMonth >= quota) {
      res.status(429).json({
        error: "Monthly quota exceeded",
        message: `You have used all ${quota} videos for this month. Upgrade your plan to create more videos.`,
        videosThisMonth,
        quota,
      });
      return;
    }

    // Max length check
    const maxLength = effectivePlan?.maxLengthSeconds ?? 30;
    if (data.durationSeconds > maxLength) {
      res.status(400).json({
        error: "Duration exceeds plan limit",
        message: `Your current plan allows videos up to ${maxLength}s. Requested: ${data.durationSeconds}s. Upgrade your plan for longer videos.`,
        maxAllowed: maxLength,
        requested: data.durationSeconds,
      });
      return;
    }
  }

  // ── Content moderation ────────────────────────────────────────────────────
  const moderationViolation = await moderateContent(data.inputContent);
  if (moderationViolation) {
    logger.warn({ userId: req.user!.userId, violation: moderationViolation }, "Video creation blocked by content moderation");
    res.status(422).json({
      error: "Content policy violation",
      message: "Your content was flagged by our moderation system and cannot be processed. Please revise your input.",
      detail: moderationViolation,
    });
    return;
  }

  if (data.projectId) {
    const [project] = await db.select().from(projectsTable).where(
      and(eq(projectsTable.id, data.projectId), eq(projectsTable.userId, req.user!.userId))
    );
    if (!project) {
      res.status(400).json({ error: "Invalid project" });
      return;
    }
  }

  const priority = roleToPriority(req.user!.role);

  const resolution = data.resolution ?? "1080p";
  const cinemaMode = resolution === "4K" || resolution === "8K";

  const [video] = await db.insert(videosTable).values({
    userId: req.user!.userId,
    projectId: data.projectId ?? null,
    title: data.title,
    description: data.description ?? null,
    inputType: data.inputType,
    inputContent: data.inputContent,
    style: data.style,
    durationSeconds: data.durationSeconds,
    status: "pending",
    progress: 0,
    priority,
    aspectRatio: (data.aspectRatio ?? "16:9") as "16:9" | "9:16" | "21:9" | "2.39:1",
    resolution: resolution as "1080p" | "2K" | "4K" | "8K",
    cinemaMode,
    colorGrade: (data.colorGrade ?? "natural") as "natural" | "warm" | "cold" | "noir" | "vibrant" | "indian-vivid",
    filmGrain: data.filmGrain ?? false,
    depthOfField: data.depthOfField ?? true,
    audioMastering: (data.audioMastering ?? "stereo") as "stereo" | "surround-ready",
    exportFormats: data.exportFormats ?? ["youtube"],
    characterMappings: (data as any).characterMappings ?? [],
    language: (data as any).language ?? "hi",
  }).returning();

  // Create an analysis record immediately so the frontend can poll it
  const [analysis] = await db.insert(videoAnalysesTable).values({
    videoId: video.id,
    status: "analyzing",
  }).returning();

  // Run AI analysis in the background (non-blocking)
  runAnalysisAsync(video.id, analysis.id, {
    title: video.title,
    inputType: video.inputType,
    inputContent: video.inputContent,
    style: video.style,
    durationSeconds: video.durationSeconds,
  }).catch((err) => {
    logger.error({ err, videoId: video.id }, "Auto-triggered AI analysis failed");
  });

  // Push to queue — Upstash cloud Redis preferred, local Redis fallback
  enqueueVideoUpstash(video.id).then((ok) => {
    if (!ok) {
      enqueueVideo(video.id).catch((err) => {
        logger.warn({ err, videoId: video.id }, "Local Redis enqueue failed");
      });
    }
  }).catch((err) => {
    logger.warn({ err, videoId: video.id }, "Failed to enqueue video for rendering");
  });

  res.status(201).json(formatVideo(video));
});

router.get("/videos/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.select().from(videosTable).where(
    and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId))
  );

  if (!video) {
    res.status(404).json({ error: "Not found", message: "Video not found" });
    return;
  }

  res.json(formatVideo(video));
});

router.patch("/videos/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;
  if ((parsed.data as any).cinemaMode !== undefined) updates.cinemaMode = (parsed.data as any).cinemaMode;

  const [video] = await db.update(videosTable)
    .set(updates)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)))
    .returning();

  if (!video) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(formatVideo(video));
});

router.delete("/videos/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.delete(videosTable)
    .where(and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId)))
    .returning();

  if (!video) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ message: "Video deleted successfully" });
});

router.get("/videos/:id/download", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.select().from(videosTable).where(
    and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId))
  );

  if (!video) {
    res.status(404).json({ error: "Not found", message: "Video not found" });
    return;
  }

  if (video.status !== "completed") {
    res.status(400).json({ error: "Not ready", message: "Video is still processing." });
    return;
  }

  if (!video.outputUrl) {
    res.status(404).json({ error: "No output", message: "Video output file is not available." });
    return;
  }

  // Try to generate a signed S3 URL (1 hour expiry); fall back to stored URL if S3 not configured
  const signedUrl = await getSignedVideoUrl(id, 3600);
  res.json({ url: signedUrl ?? video.outputUrl });
});

router.post("/videos/:id/retry", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [video] = await db.select().from(videosTable).where(
    and(eq(videosTable.id, id), eq(videosTable.userId, req.user!.userId))
  );

  if (!video) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (video.status !== "failed") {
    res.status(400).json({ error: "Can only retry failed videos" });
    return;
  }

  const [updated] = await db.update(videosTable)
    .set({
      status: "pending",
      progress: 0,
      generationStage: "analyzing",
      errorMessage: null,
      completedAt: null,
      processingStartedAt: null,
      outputUrl: null,
      scenesCompleted: 0,
    })
    .where(eq(videosTable.id, id))
    .returning();

  // Re-create an analysis record so the AI pipeline restarts cleanly
  await db.delete(videoAnalysesTable).where(eq(videoAnalysesTable.videoId, id));
  const [newAnalysis] = await db.insert(videoAnalysesTable).values({
    videoId: id,
    status: "analyzing",
  }).returning();

  // Re-trigger AI analysis (non-blocking)
  runAnalysisAsync(id, newAnalysis.id, {
    title: video.title,
    inputType: video.inputType,
    inputContent: video.inputContent,
    style: video.style,
    durationSeconds: video.durationSeconds,
  }).catch((err) => {
    logger.error({ err, videoId: id }, "Retry: AI analysis re-trigger failed");
  });

  // Re-enqueue to worker queue
  enqueueVideoUpstash(id).then((ok) => {
    if (!ok) {
      enqueueVideo(id).catch((err) => {
        logger.warn({ err, videoId: id }, "Retry: local Redis re-enqueue failed");
      });
    }
  }).catch((err) => {
    logger.warn({ err, videoId: id }, "Retry: failed to re-enqueue video");
  });

  res.json(formatVideo(updated!));
});

export default router;
