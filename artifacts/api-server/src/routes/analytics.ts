/**
 * GEMS Analytics Routes
 *
 * Comprehensive platform analytics for super_admin:
 * - Users: registration trends, role/status distribution, top creators
 * - Revenue: language purchase revenue, plan breakdown, daily trend
 * - Videos: style/status/resolution/duration distribution, completion rate
 * - GPU: queue depth, worker utilization, render throughput, compute hours
 */

import { Router, type IRouter } from "express";
import {
  db,
  usersTable,
  videosTable,
  languagesTable,
  userLanguagesTable,
} from "@workspace/db";
import { eq, count, sum, avg, gte, desc, sql, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { adminLimiter } from "../middlewares/security";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dayBuckets(days: number): Date[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    d.setHours(0, 0, 0, 0);
    return d;
  });
}

function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/users
// ---------------------------------------------------------------------------
router.get(
  "/admin/analytics/users",
  requireAuth, requireRole("super_admin"), adminLimiter,
  async (req, res): Promise<void> => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const buckets = dayBuckets(30);

    const [
      roleDistResult,
      statusDistResult,
      recentUsersResult,
      topCreatorsResult,
      weeklyTrendResult,
    ] = await Promise.all([
      // Role distribution
      db.select({ role: usersTable.role, cnt: count() })
        .from(usersTable)
        .groupBy(usersTable.role),

      // Status distribution
      db.select({ status: usersTable.status, cnt: count() })
        .from(usersTable)
        .groupBy(usersTable.status),

      // Last 30 days registrations (raw, we bucket manually)
      db.select({ createdAt: usersTable.createdAt })
        .from(usersTable)
        .where(gte(usersTable.createdAt, thirtyDaysAgo)),

      // Top creators by video count
      db.select({
          id: usersTable.id,
          name: usersTable.name,
          email: usersTable.email,
          role: usersTable.role,
          videoCount: count(videosTable.id),
          completedCount: sql<number>`cast(count(case when ${videosTable.status} = 'completed' then 1 end) as integer)`,
        })
        .from(usersTable)
        .leftJoin(videosTable, eq(videosTable.userId, usersTable.id))
        .groupBy(usersTable.id)
        .orderBy(desc(count(videosTable.id)))
        .limit(10),

      // Weekly registrations over last 12 weeks
      db.select({ createdAt: usersTable.createdAt })
        .from(usersTable)
        .where(gte(usersTable.createdAt, new Date(Date.now() - 84 * 24 * 60 * 60 * 1000))),
    ]);

    // Bucket recent registrations by day
    const countsByDay: Record<string, number> = {};
    for (const b of buckets) countsByDay[dateLabel(b)] = 0;
    for (const u of recentUsersResult) {
      const label = dateLabel(u.createdAt);
      if (label in countsByDay) countsByDay[label]++;
    }
    const registrationTrend = buckets.map((b) => ({
      date: dateLabel(b),
      count: countsByDay[dateLabel(b)] ?? 0,
    }));

    // Weekly trend
    const weeklyMap: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      const d = new Date(Date.now() - (11 - i) * 7 * 24 * 60 * 60 * 1000);
      d.setHours(0, 0, 0, 0);
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() - d.getDay());
      weeklyMap[dateLabel(weekStart)] = 0;
    }
    for (const u of weeklyTrendResult) {
      const weekStart = new Date(u.createdAt);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const key = dateLabel(weekStart);
      if (key in weeklyMap) weeklyMap[key]++;
    }
    const weeklyTrend = Object.entries(weeklyMap).map(([week, count]) => ({ week, count }));

    const roleMap = Object.fromEntries(roleDistResult.map((r) => [r.role, r.cnt]));
    const statusMap = Object.fromEntries(statusDistResult.map((s) => [s.status, s.cnt]));

    res.json({
      roleDistribution: {
        user: roleMap.user ?? 0,
        admin: roleMap.admin ?? 0,
        super_admin: roleMap.super_admin ?? 0,
      },
      statusDistribution: {
        active: statusMap.active ?? 0,
        blocked: statusMap.blocked ?? 0,
        terminated: statusMap.terminated ?? 0,
      },
      registrationTrend,
      weeklyTrend,
      topCreators: topCreatorsResult.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        videoCount: u.videoCount,
        completedCount: u.completedCount,
      })),
    });
  }
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/revenue
// ---------------------------------------------------------------------------
router.get(
  "/admin/analytics/revenue",
  requireAuth, requireRole("super_admin"), adminLimiter,
  async (req, res): Promise<void> => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const buckets = dayBuckets(30);

    const [purchasesResult, languagesResult, recentPurchasesResult] = await Promise.all([
      // All purchases joined to language for price
      db.select({
          languageId: userLanguagesTable.languageId,
          cnt: count(),
          revenue: sql<number>`cast(count(*) * max(${languagesTable.priceUsd}) as numeric(10,2))`,
          languageName: languagesTable.name,
          region: languagesTable.region,
          priceUsd: languagesTable.priceUsd,
          createdAt: userLanguagesTable.purchasedAt,
        })
        .from(userLanguagesTable)
        .leftJoin(languagesTable, eq(languagesTable.id, userLanguagesTable.languageId))
        .groupBy(
          userLanguagesTable.languageId,
          languagesTable.name,
          languagesTable.region,
          languagesTable.priceUsd,
          userLanguagesTable.purchasedAt,
        ),

      // Language prices for plan simulation
      db.select({ id: languagesTable.id, name: languagesTable.name, priceUsd: languagesTable.priceUsd, region: languagesTable.region }).from(languagesTable),

      // Recent purchases for daily trend
      db.select({
          purchasedAt: userLanguagesTable.purchasedAt,
          priceUsd: languagesTable.priceUsd,
        })
        .from(userLanguagesTable)
        .leftJoin(languagesTable, eq(languagesTable.id, userLanguagesTable.languageId))
        .where(gte(userLanguagesTable.purchasedAt, thirtyDaysAgo)),
    ]);

    // Aggregate per-language revenue
    const perLanguage: Record<string, { name: string; region: string; purchases: number; revenue: number; priceUsd: number }> = {};
    for (const row of purchasesResult) {
      const id = row.languageId;
      if (!id) continue;
      if (!perLanguage[id]) {
        perLanguage[id] = { name: row.languageName ?? "Unknown", region: row.region ?? "global", purchases: 0, revenue: 0, priceUsd: row.priceUsd ?? 0 };
      }
      perLanguage[id].purchases += Number(row.cnt);
      perLanguage[id].revenue += Number(row.priceUsd ?? 0) * Number(row.cnt);
    }

    const totalRevenue = Object.values(perLanguage).reduce((s, l) => s + l.revenue, 0);
    const totalPurchases = Object.values(perLanguage).reduce((s, l) => s + l.purchases, 0);

    // Daily revenue trend (from purchases)
    const revByDay: Record<string, number> = {};
    for (const b of buckets) revByDay[dateLabel(b)] = 0;
    for (const p of recentPurchasesResult) {
      if (!p.purchasedAt) continue;
      const label = dateLabel(p.purchasedAt);
      if (label in revByDay) revByDay[label] += Number(p.priceUsd ?? 0);
    }
    const dailyTrend = buckets.map((b) => ({
      date: dateLabel(b),
      revenue: +((revByDay[dateLabel(b)] ?? 0)).toFixed(2),
    }));

    // MRR estimate: sum of last 30 days revenue
    const mrr = +(dailyTrend.reduce((s, d) => s + d.revenue, 0)).toFixed(2);

    // Regional breakdown
    const regionalBreakdown = {
      indian: Object.values(perLanguage).filter((l) => l.region === "indian").reduce((s, l) => s + l.revenue, 0),
      global: Object.values(perLanguage).filter((l) => l.region === "global").reduce((s, l) => s + l.revenue, 0),
    };

    res.json({
      totalRevenue: +totalRevenue.toFixed(2),
      totalPurchases,
      mrr,
      regionalBreakdown: {
        indian: +regionalBreakdown.indian.toFixed(2),
        global: +regionalBreakdown.global.toFixed(2),
      },
      perLanguage: Object.entries(perLanguage)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .map(([id, data]) => ({ id, ...data, revenue: +data.revenue.toFixed(2) })),
      dailyTrend,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/videos
// ---------------------------------------------------------------------------
router.get(
  "/admin/analytics/videos",
  requireAuth, requireRole("super_admin"), adminLimiter,
  async (req, res): Promise<void> => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const buckets = dayBuckets(30);

    const [
      styleDistResult,
      statusDistResult,
      resolutionDistResult,
      colorGradeDistResult,
      inputTypeDistResult,
      allVideosResult,
      recentVideosResult,
      completedVideosResult,
    ] = await Promise.all([
      db.select({ style: videosTable.style, cnt: count() }).from(videosTable).groupBy(videosTable.style),
      db.select({ status: videosTable.status, cnt: count() }).from(videosTable).groupBy(videosTable.status),
      db.select({ resolution: videosTable.resolution, cnt: count() }).from(videosTable).groupBy(videosTable.resolution),
      db.select({ colorGrade: videosTable.colorGrade, cnt: count() }).from(videosTable).groupBy(videosTable.colorGrade),
      db.select({ inputType: videosTable.inputType, cnt: count() }).from(videosTable).groupBy(videosTable.inputType),
      // All videos for duration bucketing
      db.select({ durationSeconds: videosTable.durationSeconds, status: videosTable.status, cinemaMode: videosTable.cinemaMode }).from(videosTable),
      // Recent videos for daily creation trend
      db.select({ createdAt: videosTable.createdAt }).from(videosTable).where(gte(videosTable.createdAt, thirtyDaysAgo)),
      // Completed videos for avg processing time
      db.select({
          processingStartedAt: videosTable.processingStartedAt,
          completedAt: videosTable.completedAt,
          durationSeconds: videosTable.durationSeconds,
        })
        .from(videosTable)
        .where(and(eq(videosTable.status, "completed"), sql`${videosTable.processingStartedAt} is not null`, sql`${videosTable.completedAt} is not null`))
        .limit(500),
    ]);

    // Duration buckets
    const durationBuckets = {
      "under_1min": 0,
      "1_10min": 0,
      "10_30min": 0,
      "30min_1hr": 0,
      "1_3hr": 0,
      "over_3hr": 0,
    };
    let cinemaModeCount = 0;
    for (const v of allVideosResult) {
      const d = v.durationSeconds;
      if (d < 60) durationBuckets.under_1min++;
      else if (d < 600) durationBuckets["1_10min"]++;
      else if (d < 1800) durationBuckets["10_30min"]++;
      else if (d < 3600) durationBuckets["30min_1hr"]++;
      else if (d < 10800) durationBuckets["1_3hr"]++;
      else durationBuckets.over_3hr++;
      if (v.cinemaMode) cinemaModeCount++;
    }

    // Daily creation trend
    const countsByDay: Record<string, number> = {};
    for (const b of buckets) countsByDay[dateLabel(b)] = 0;
    for (const v of recentVideosResult) {
      const label = dateLabel(v.createdAt);
      if (label in countsByDay) countsByDay[label]++;
    }
    const dailyCreationTrend = buckets.map((b) => ({ date: dateLabel(b), count: countsByDay[dateLabel(b)] ?? 0 }));

    // Avg render time
    let renderTimes: number[] = [];
    for (const v of completedVideosResult) {
      if (v.processingStartedAt && v.completedAt) {
        const ms = new Date(v.completedAt).getTime() - new Date(v.processingStartedAt).getTime();
        if (ms > 0) renderTimes.push(ms / 1000);
      }
    }
    const avgRenderSeconds = renderTimes.length > 0 ? +(renderTimes.reduce((s, t) => s + t, 0) / renderTimes.length).toFixed(1) : null;

    const statusMap = Object.fromEntries(statusDistResult.map((s) => [s.status, s.cnt]));
    const completed = statusMap.completed ?? 0;
    const failed = statusMap.failed ?? 0;
    const completionRate = completed + failed > 0 ? +(completed / (completed + failed) * 100).toFixed(1) : null;

    const totalDurationSeconds = allVideosResult.reduce((s, v) => s + v.durationSeconds, 0);

    res.json({
      totalVideos: allVideosResult.length,
      completionRate,
      avgRenderSeconds,
      cinemaModeRate: allVideosResult.length > 0 ? +(cinemaModeCount / allVideosResult.length * 100).toFixed(1) : 0,
      totalDurationHours: +(totalDurationSeconds / 3600).toFixed(1),
      styleDistribution: styleDistResult.map((s) => ({ style: s.style, count: s.cnt })),
      statusDistribution: statusDistResult.map((s) => ({ status: s.status, count: s.cnt })),
      resolutionDistribution: resolutionDistResult.map((r) => ({ resolution: r.resolution, count: r.cnt })),
      colorGradeDistribution: colorGradeDistResult.map((c) => ({ colorGrade: c.colorGrade, count: c.cnt })),
      inputTypeDistribution: inputTypeDistResult.map((i) => ({ inputType: i.inputType, count: i.cnt })),
      durationBuckets: Object.entries(durationBuckets).map(([label, count]) => ({ label, count })),
      dailyCreationTrend,
    });
  }
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/gpu
// ---------------------------------------------------------------------------
router.get(
  "/admin/analytics/gpu",
  requireAuth, requireRole("super_admin"), adminLimiter,
  async (req, res): Promise<void> => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const buckets = dayBuckets(30);

    const [
      activeJobsResult,
      pendingJobsResult,
      completedTodayResult,
      failedTodayResult,
      priorityQueueResult,
      recentCompletedResult,
      workerTypeResult,
      dailyJobsResult,
    ] = await Promise.all([
      db.select({ cnt: count(), workerType: videosTable.workerType })
        .from(videosTable).where(eq(videosTable.status, "processing"))
        .groupBy(videosTable.workerType),

      db.select({ cnt: count(), priority: videosTable.priority })
        .from(videosTable).where(eq(videosTable.status, "pending"))
        .groupBy(videosTable.priority),

      db.select({ cnt: count() }).from(videosTable)
        .where(and(eq(videosTable.status, "completed"), gte(videosTable.completedAt, today))),

      db.select({ cnt: count() }).from(videosTable)
        .where(and(eq(videosTable.status, "failed"), gte(videosTable.updatedAt, today))),

      db.select({ priority: videosTable.priority, cnt: count() })
        .from(videosTable)
        .where(eq(videosTable.status, "processing"))
        .groupBy(videosTable.priority),

      // Completed in last 30 days for throughput + render time
      db.select({
          processingStartedAt: videosTable.processingStartedAt,
          completedAt: videosTable.completedAt,
          durationSeconds: videosTable.durationSeconds,
          priority: videosTable.priority,
          workerType: videosTable.workerType,
        })
        .from(videosTable)
        .where(and(
          eq(videosTable.status, "completed"),
          gte(videosTable.completedAt, thirtyDaysAgo),
          sql`${videosTable.processingStartedAt} is not null`,
        ))
        .limit(1000),

      db.select({ workerType: videosTable.workerType, cnt: count() })
        .from(videosTable)
        .groupBy(videosTable.workerType),

      // Daily completed count for throughput trend
      db.select({ completedAt: videosTable.completedAt })
        .from(videosTable)
        .where(and(eq(videosTable.status, "completed"), gte(videosTable.completedAt, thirtyDaysAgo))),
    ]);

    // Worker capacity model:
    // enterprise → 5 parallel, paid → 3, free → 1
    const CAPACITY: Record<string, number> = { enterprise: 5, paid: 3, free: 1 };
    const activeByWorker = Object.fromEntries(activeJobsResult.map((r) => [r.workerType, r.cnt]));
    const gpuActive = activeByWorker.gpu ?? 0;
    const cpuActive = activeByWorker.cpu ?? 0;
    const totalActive = gpuActive + cpuActive;

    const pendingMap = Object.fromEntries(pendingJobsResult.map((r) => [r.priority, r.cnt]));
    const queueDepth = (pendingMap.enterprise ?? 0) + (pendingMap.paid ?? 0) + (pendingMap.free ?? 0);

    // Max theoretical capacity = sum of active job capacities
    const priorityMap = Object.fromEntries(priorityQueueResult.map((r) => [r.priority, r.cnt]));
    const maxCapacity = Math.max(
      (priorityMap.enterprise ?? 0) * CAPACITY.enterprise +
      (priorityMap.paid ?? 0) * CAPACITY.paid +
      (priorityMap.free ?? 0) * CAPACITY.free,
      1
    );
    const utilization = totalActive > 0 ? Math.min(100, +(totalActive / maxCapacity * 100).toFixed(1)) : 0;

    // Avg render time
    const renderTimes: number[] = [];
    let totalComputeSeconds = 0;
    for (const v of recentCompletedResult) {
      if (v.processingStartedAt && v.completedAt) {
        const secs = (new Date(v.completedAt).getTime() - new Date(v.processingStartedAt).getTime()) / 1000;
        if (secs > 0) { renderTimes.push(secs); totalComputeSeconds += secs; }
      }
    }
    const avgRenderSeconds = renderTimes.length > 0 ? +(renderTimes.reduce((s, t) => s + t, 0) / renderTimes.length).toFixed(1) : null;
    const estimatedComputeHours = +(totalComputeSeconds / 3600).toFixed(2);

    // Daily throughput trend
    const throughputByDay: Record<string, number> = {};
    for (const b of buckets) throughputByDay[dateLabel(b)] = 0;
    for (const v of dailyJobsResult) {
      if (!v.completedAt) continue;
      const label = dateLabel(v.completedAt);
      if (label in throughputByDay) throughputByDay[label]++;
    }
    const dailyThroughput = buckets.map((b) => ({ date: dateLabel(b), count: throughputByDay[dateLabel(b)] ?? 0 }));

    // Worker type breakdown
    const workerTypeMap = Object.fromEntries(workerTypeResult.map((r) => [r.workerType, r.cnt]));

    res.json({
      activeJobs: totalActive,
      gpuJobs: gpuActive,
      cpuJobs: cpuActive,
      queueDepth,
      completedToday: completedTodayResult[0]?.cnt ?? 0,
      failedToday: failedTodayResult[0]?.cnt ?? 0,
      utilization,
      avgRenderSeconds,
      estimatedComputeHours,
      workerTypeDistribution: {
        gpu: workerTypeMap.gpu ?? 0,
        cpu: workerTypeMap.cpu ?? 0,
      },
      priorityQueue: {
        enterprise: pendingMap.enterprise ?? 0,
        paid: pendingMap.paid ?? 0,
        free: pendingMap.free ?? 0,
      },
      dailyThroughput,
    });
  }
);

export default router;
