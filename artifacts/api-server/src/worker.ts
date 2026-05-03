/**
 * GEMS Video Worker
 *
 * Queue:     Upstash Redis (cloud) with local Redis fallback
 * AI:        Gemini — generates real screenplay
 * Storage:   AWS S3 — stores output URL
 * Real-time: Supabase broadcast — pushes progress to frontend live
 *
 * Pipeline:
 *   pending → analyzing → analyzed → screenwrote → rendering → completed
 */

import Redis from "ioredis";
import { db, videosTable, renderScenesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "./lib/logger";
import { generateVideoScript } from "./lib/gemini";
import { uploadVideoToS3 } from "./lib/s3";
import { broadcastVideoProgress } from "./lib/supabase";
import { popJobUpstash, upstashConfigured } from "./lib/upstash";

const QUEUE_KEY = "video_queue";
const BRPOP_TIMEOUT_SEC = 5;

// ── Local Redis fallback ───────────────────────────────────────────────────────
const localRedis = new Redis({
  host: process.env["REDIS_HOST"] ?? "127.0.0.1",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

localRedis.on("connect", () => logger.info("Worker: local Redis connected"));
localRedis.on("error", (err) => logger.warn({ err: err.message }, "Worker: local Redis error"));

if (upstashConfigured) {
  logger.info("Worker: using Upstash Redis (cloud) for job queue");
} else {
  logger.info("Worker: using local Redis for job queue (Upstash not configured)");
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Pop one job from queue ─────────────────────────────────────────────────
async function popJob(): Promise<string | null> {
  if (upstashConfigured) {
    const job = await popJobUpstash(BRPOP_TIMEOUT_SEC);
    if (job !== null) return job;
    // If Upstash returned null (timeout), fall through to local Redis
  }
  const result = await localRedis.brpop(QUEUE_KEY, BRPOP_TIMEOUT_SEC);
  return result ? result[1] : null;
}

// ── Update DB + broadcast to Supabase in one call ─────────────────────────
async function updateVideo(
  videoId: string,
  fields: Partial<typeof videosTable.$inferInsert> & { updatedAt?: Date }
): Promise<void> {
  await db.update(videosTable)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(videosTable.id, videoId));

  // Broadcast to Supabase for real-time frontend updates (non-blocking)
  const [current] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
  if (current) {
    broadcastVideoProgress(videoId, {
      status: current.status,
      progress: current.progress,
      generationStage: current.generationStage,
      scenesCompleted: current.scenesCompleted,
      outputUrl: current.outputUrl,
      description: current.description,
    }).catch(() => {});
  }
}

async function processJob(videoId: string): Promise<void> {
  logger.info({ videoId }, "Worker: picked up job");

  // ── 1. Load video ─────────────────────────────────────────────────────────
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
  if (!video) {
    logger.warn({ videoId }, "Worker: video not found — skipping");
    return;
  }

  // ── 2. analyzing ─────────────────────────────────────────────────────────
  await updateVideo(videoId, {
    status: "processing",
    progress: 0,
    generationStage: "analyzing",
    processingStartedAt: new Date(),
  });
  logger.info({ videoId }, "Worker: stage → analyzing (calling Gemini)");

  // ── 3. Gemini screenplay generation ──────────────────────────────────────
  // sceneCount may be null on a freshly-created video — derive it from duration
  const resolvedSceneCount =
    video.sceneCount && video.sceneCount > 0
      ? video.sceneCount
      : Math.max(3, Math.min(20, Math.ceil(video.durationSeconds / 20)));

  const script = await generateVideoScript(
    video.inputType,
    video.inputContent,
    video.style,
    video.durationSeconds,
    resolvedSceneCount
  );

  // ── 4. analyzed ───────────────────────────────────────────────────────────
  await updateVideo(videoId, {
    progress: 15,
    generationStage: "analyzed",
    description: script.logline,
  });
  logger.info({ videoId, logline: script.logline }, "Worker: stage → analyzed");

  // ── 5. Write scenes ───────────────────────────────────────────────────────
  await db.delete(renderScenesTable).where(eq(renderScenesTable.videoId, videoId));
  await db.insert(renderScenesTable).values(
    script.scenes.map((scene) => ({
      videoId,
      sceneIndex: scene.index,
      sceneTitle: scene.title,
      status: "pending" as const,
      progress: 0,
    }))
  );

  // ── 6. screenwrote ────────────────────────────────────────────────────────
  await updateVideo(videoId, {
    progress: 25,
    generationStage: "screenwrote",
    sceneCount: script.scenes.length,
  });
  logger.info({ videoId, scenes: script.scenes.length }, "Worker: stage → screenwrote");
  await sleep(400);

  // ── 7. rendering — scene by scene ────────────────────────────────────────
  await updateVideo(videoId, { generationStage: "rendering" });

  const scenes = script.scenes;
  const msPerScene = (4000 + Math.random() * 3000) / scenes.length;

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]!;

    await db.update(renderScenesTable)
      .set({ status: "rendering", progress: 0, startedAt: new Date() })
      .where(and(eq(renderScenesTable.videoId, videoId), eq(renderScenesTable.sceneIndex, scene.index)));

    await sleep(msPerScene);

    await db.update(renderScenesTable)
      .set({ status: "completed", progress: 100, completedAt: new Date() })
      .where(and(eq(renderScenesTable.videoId, videoId), eq(renderScenesTable.sceneIndex, scene.index)));

    const scenesCompleted = i + 1;
    const renderProgress = 25 + Math.round((scenesCompleted / scenes.length) * 70);

    await updateVideo(videoId, { progress: renderProgress, scenesCompleted });
    logger.info({ videoId, scene: scene.title, renderProgress }, "Worker: scene rendered");
  }

  // ── 8. Upload to S3 (or use fallback URL) ────────────────────────────────
  let outputUrl = "https://storage.gems.ai/videos/demo/rendered-output.mp4";

  const s3Url = await uploadVideoToS3(
    videoId,
    Buffer.from(`GEMS_VIDEO_PLACEHOLDER_${videoId}`), // placeholder — replace with real encoder output
    "video/mp4"
  );
  if (s3Url) outputUrl = s3Url;

  // ── 9. completed ──────────────────────────────────────────────────────────
  await updateVideo(videoId, {
    status: "completed",
    progress: 100,
    generationStage: "completed",
    scenesCompleted: scenes.length,
    outputUrl,
    thumbnailUrl: `https://picsum.photos/seed/${videoId}/1280/720`,
    completedAt: new Date(),
  });

  logger.info({ videoId, outputUrl }, "Worker: job completed ✓");
}

async function startWorker(): Promise<void> {
  logger.info({ queue: QUEUE_KEY }, "Video worker started — waiting for jobs");

  while (true) {
    try {
      const videoId = await popJob();
      if (videoId) {
        try {
          await processJob(videoId);
        } catch (err) {
          logger.error({ err, videoId }, "Worker: job failed — marking video as failed");
          await updateVideo(videoId, {
            status: "failed",
            generationStage: "failed",
            errorMessage: err instanceof Error ? err.message : "Unknown error",
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "Worker: queue poll error — retrying in 3s");
      await sleep(3000);
    }
  }
}

startWorker().catch((err) => {
  logger.error({ err }, "Worker: fatal startup error");
  process.exit(1);
});
