import { Router, type IRouter } from "express";
import {
  db,
  marketingAssetsTable,
  videosTable,
  type MarketingAsset,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import {
  planAssets,
  generateTrailerContent,
  generatePosterImageBuffer,
  generateThumbnailImageBuffer,
  type AssetType,
  type VideoContext,
} from "../lib/marketing-assets-engine";

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function param(v: string | string[]): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function buildAssetResponse(a: MarketingAsset) {
  return {
    id: a.id,
    videoId: a.videoId,
    userId: a.userId,
    assetType: a.assetType,
    status: a.status,
    language: a.language,
    title: a.title,
    tagline: a.tagline,
    imageData: a.imageData,
    trailerContent: a.trailerContent ?? null,
    errorMessage: a.errorMessage,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

// =========================================================
// Generate assets for a video (async — starts background job)
// =========================================================
router.post("/marketing-assets/generate", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const videoId = isStr(body.videoId) ? body.videoId.trim() : "";
  if (!UUID_RE.test(videoId)) {
    res.status(400).json({ error: "videoId is required and must be a valid UUID" });
    return;
  }
  const language = isStr(body.language) && body.language.trim().length > 0 ? body.language.trim().slice(0, 50) : "hi";
  const forceRegenerate = body.forceRegenerate === true;

  // Load the video (must belong to this user)
  const [video] = await db
    .select()
    .from(videosTable)
    .where(and(eq(videosTable.id, videoId), eq(videosTable.userId, userId)))
    .limit(1);

  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }

  // Determine which asset types to generate
  const assetTypes = planAssets(video.durationSeconds);

  // Check existing assets; skip completed ones unless forceRegenerate
  const existing = await db
    .select()
    .from(marketingAssetsTable)
    .where(and(eq(marketingAssetsTable.videoId, videoId), eq(marketingAssetsTable.userId, userId)));

  const existingByType: Record<string, MarketingAsset> = {};
  for (const a of existing) existingByType[a.assetType] = a;

  // Create stub rows for assets that need generation
  const toGenerate: AssetType[] = assetTypes.filter((t) => {
    if (!forceRegenerate) {
      const ex = existingByType[t];
      if (ex && (ex.status === "completed" || ex.status === "generating")) return false;
    }
    return true;
  });

  if (toGenerate.length === 0) {
    res.status(202).json({
      jobId: `noop-${Date.now()}`,
      assets: existing.map(buildAssetResponse),
    });
    return;
  }

  // When force-regenerating, remove old records for types being regenerated
  // to avoid duplicate rows in the DB
  if (forceRegenerate && existing.length > 0) {
    await db
      .delete(marketingAssetsTable)
      .where(and(eq(marketingAssetsTable.videoId, videoId), eq(marketingAssetsTable.userId, userId)));
    // Clear the existing array so the response only includes freshly-inserted stubs
    existing.length = 0;
  }

  // Insert stubs with "generating" status
  const inserted = await db
    .insert(marketingAssetsTable)
    .values(
      toGenerate.map((t) => ({
        videoId,
        userId,
        assetType: t,
        status: "generating" as const,
        language,
        title: video.title,
      })),
    )
    .returning();

  const jobId = `job-${Date.now()}`;

  // Respond immediately with stubs — generation continues in background
  res.status(202).json({
    jobId,
    assets: [
      ...existing.filter((a: MarketingAsset) => !toGenerate.includes(a.assetType as AssetType)).map(buildAssetResponse),
      ...inserted.map(buildAssetResponse),
    ],
  });

  // Background: actually generate each asset
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
    generateAsset(ctx, asset, req).catch((err) => {
      req.log.error({ err: String(err), assetId: asset.id }, "marketing-assets: background generation error");
    });
  }
});

// =========================================================
// Background generation logic
// =========================================================
async function generateAsset(ctx: VideoContext, asset: MarketingAsset, req: any): Promise<void> {
  try {
    if (asset.assetType === "trailer") {
      const content = await generateTrailerContent(ctx);
      await db
        .update(marketingAssetsTable)
        .set({
          status: "completed",
          trailerContent: content as any,
          title: ctx.title,
          tagline: content.closingTagline || null,
          updatedAt: new Date(),
        })
        .where(eq(marketingAssetsTable.id, asset.id));
    } else if (asset.assetType === "poster") {
      const { buffer, prompt } = await generatePosterImageBuffer(ctx);
      const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
      await db
        .update(marketingAssetsTable)
        .set({
          status: "completed",
          imageData: dataUri,
          generationPrompt: prompt,
          title: ctx.title,
          updatedAt: new Date(),
        })
        .where(eq(marketingAssetsTable.id, asset.id));
    } else if (asset.assetType === "thumbnail") {
      const { buffer, prompt } = await generateThumbnailImageBuffer(ctx);
      const dataUri = `data:image/png;base64,${buffer.toString("base64")}`;
      await db
        .update(marketingAssetsTable)
        .set({
          status: "completed",
          imageData: dataUri,
          generationPrompt: prompt,
          title: ctx.title,
          updatedAt: new Date(),
        })
        .where(eq(marketingAssetsTable.id, asset.id));
    }
  } catch (err) {
    req.log.error({ err: String(err), assetId: asset.id, assetType: asset.assetType }, "marketing-assets: asset generation failed");
    await db
      .update(marketingAssetsTable)
      .set({
        status: "failed",
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        updatedAt: new Date(),
      })
      .where(eq(marketingAssetsTable.id, asset.id));
  }
}

// =========================================================
// GET assets for a video
// =========================================================
router.get("/marketing-assets/video/:videoId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const videoId = param(req.params.videoId as string | string[]);
  if (!UUID_RE.test(videoId)) { res.status(400).json({ error: "Invalid videoId" }); return; }

  const [video] = await db
    .select({ id: videosTable.id })
    .from(videosTable)
    .where(and(eq(videosTable.id, videoId), eq(videosTable.userId, userId)))
    .limit(1);

  if (!video) { res.status(404).json({ error: "Video not found" }); return; }

  const assets = await db
    .select()
    .from(marketingAssetsTable)
    .where(and(eq(marketingAssetsTable.videoId, videoId), eq(marketingAssetsTable.userId, userId)));

  res.json(assets.map(buildAssetResponse));
});

// =========================================================
// GET single asset
// =========================================================
router.get("/marketing-assets/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = param(req.params.id as string | string[]);
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [asset] = await db
    .select()
    .from(marketingAssetsTable)
    .where(and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.userId, userId)))
    .limit(1);

  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  res.json(buildAssetResponse(asset));
});

// =========================================================
// DELETE asset
// =========================================================
router.delete("/marketing-assets/:id", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = param(req.params.id as string | string[]);
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const deleted = await db
    .delete(marketingAssetsTable)
    .where(and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.userId, userId)))
    .returning({ id: marketingAssetsTable.id });

  if (deleted.length === 0) { res.status(404).json({ error: "Asset not found" }); return; }

  res.json({ success: true });
});

// =========================================================
// Regenerate single asset
// =========================================================
router.post("/marketing-assets/:id/regenerate", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const id = param(req.params.id as string | string[]);
  if (!UUID_RE.test(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [asset] = await db
    .select()
    .from(marketingAssetsTable)
    .where(and(eq(marketingAssetsTable.id, id), eq(marketingAssetsTable.userId, userId)))
    .limit(1);

  if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

  const [video] = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.id, asset.videoId))
    .limit(1);

  if (!video) { res.status(404).json({ error: "Associated video not found" }); return; }

  // Reset to generating
  const [updated] = await db
    .update(marketingAssetsTable)
    .set({ status: "generating", errorMessage: null, imageData: null, trailerContent: null, updatedAt: new Date() })
    .where(eq(marketingAssetsTable.id, id))
    .returning();

  if (!updated) { res.status(500).json({ error: "Failed to update asset" }); return; }

  res.status(202).json(buildAssetResponse(updated));

  const ctx: VideoContext = {
    id: video.id,
    title: video.title,
    description: video.description,
    inputContent: video.inputContent,
    style: video.style,
    durationSeconds: video.durationSeconds,
    language: asset.language,
  };

  generateAsset(ctx, updated, req).catch((err) => {
    req.log.error({ err: String(err), assetId: id }, "marketing-assets: regenerate background error");
  });
});

export default router;
