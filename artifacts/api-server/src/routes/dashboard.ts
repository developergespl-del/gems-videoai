import { Router, type IRouter } from "express";
import { db, videosTable, projectsTable, usersTable } from "@workspace/db";
import { eq, and, count, sum, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/dashboard/stats", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  const [totalVids] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, userId));
  const [completedVids] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "completed")));
  const [processingVids] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "processing")));
  const [failedVids] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "failed")));
  const [totalProjects] = await db.select({ count: count() }).from(projectsTable).where(eq(projectsTable.userId, userId));
  const [totalDuration] = await db.select({ total: sum(videosTable.durationSeconds) }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "completed")));

  res.json({
    totalVideos: totalVids?.count ?? 0,
    completedVideos: completedVids?.count ?? 0,
    processingVideos: processingVids?.count ?? 0,
    failedVideos: failedVids?.count ?? 0,
    totalProjects: totalProjects?.count ?? 0,
    storageUsedMb: user?.storageUsedMb ?? 0,
    totalDurationSeconds: parseInt(String(totalDuration?.total ?? "0"), 10) || 0,
  });
});

router.get("/dashboard/recent-activity", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const limit = parseInt(String(req.query.limit || "10"), 10);

  const videos = await db
    .select()
    .from(videosTable)
    .where(eq(videosTable.userId, userId))
    .orderBy(desc(videosTable.createdAt))
    .limit(limit);

  const activities = videos.map((v) => ({
    id: v.id,
    videoId: v.id,
    title: v.title,
    status: v.status,
    thumbnailUrl: v.thumbnailUrl ?? null,
    createdAt: v.createdAt,
  }));

  res.json({ activities });
});

router.get("/dashboard/video-status-breakdown", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;

  const [pending] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "pending")));
  const [processing] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "processing")));
  const [completed] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "completed")));
  const [failed] = await db.select({ count: count() }).from(videosTable).where(and(eq(videosTable.userId, userId), eq(videosTable.status, "failed")));

  res.json({
    pending: pending?.count ?? 0,
    processing: processing?.count ?? 0,
    completed: completed?.count ?? 0,
    failed: failed?.count ?? 0,
  });
});

export default router;
