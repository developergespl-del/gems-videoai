import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  db, videosTable, projectsTable, usersTable, adsTable,
  adminPermissionsTable, adminAuditLogsTable,
} from "@workspace/db";
import { eq, count, desc, gte, sum, sql, and, asc, inArray } from "drizzle-orm";
import { UpdateUserRoleBody, AdminUpdateUserStatusBody, AdminCreateUserBody, SetAdminPermissionsBody } from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";
import bcrypt from "bcryptjs";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const ROLE_LEVEL: Record<string, number> = { user: 0, admin: 1, super_admin: 2 };

function canManage(actorRole: string, targetRole: string): boolean {
  return (ROLE_LEVEL[actorRole] ?? 0) > (ROLE_LEVEL[targetRole] ?? 0);
}

// ── Permission middleware ────────────────────────────────────────────────────

async function checkHasPermission(userId: string, permission: string): Promise<boolean> {
  const [row] = await db
    .select({ id: adminPermissionsTable.id })
    .from(adminPermissionsTable)
    .where(and(
      eq(adminPermissionsTable.adminUserId, userId),
      eq(adminPermissionsTable.permission, permission),
    ));
  return !!row;
}

function requireAdminPermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (req.user.role === "super_admin") { next(); return; }
    try {
      const has = await checkHasPermission(req.user.userId, permission);
      if (!has) {
        res.status(403).json({ error: "Forbidden", message: `You do not have permission: ${permission}` });
        return;
      }
      next();
    } catch (err) {
      logger.error(err, "requireAdminPermission DB check failed");
      res.status(500).json({ error: "internal_error" });
    }
  };
}

// ── Audit logging helper ─────────────────────────────────────────────────────

async function logAudit(
  actorId: string,
  actorRole: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  details: Record<string, unknown> | null,
  ipAddress: string | null,
): Promise<void> {
  try {
    // Fetch actor name/email at insert time so audit record survives user deletion
    const [actor] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, actorId));
    await db.insert(adminAuditLogsTable).values({
      actorId,
      actorName: actor?.name ?? null,
      actorEmail: actor?.email ?? null,
      actorRole,
      action,
      targetType,
      targetId,
      details,
      ipAddress,
    });
  } catch (err) {
    logger.error(err, "logAudit failed — main operation not affected");
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

router.get("/admin/stats", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const [totalUsers] = await db.select({ count: count() }).from(usersTable);
  const [totalVideos] = await db.select({ count: count() }).from(videosTable);
  const [totalProjects] = await db.select({ count: count() }).from(projectsTable);
  const [activeJobs] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.status, "processing"));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  const [todayVideos] = await db.select({ count: count() }).from(videosTable).where(gte(videosTable.createdAt, today));
  const [weekUsers] = await db.select({ count: count() }).from(usersTable).where(gte(usersTable.createdAt, weekAgo));
  const [activeUsers] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.status, "active"));
  const [blockedUsers] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.status, "blocked"));

  res.json({
    totalUsers: totalUsers?.count ?? 0,
    totalVideos: totalVideos?.count ?? 0,
    totalProjects: totalProjects?.count ?? 0,
    activeProcessingJobs: activeJobs?.count ?? 0,
    totalStorageUsedMb: 0,
    videosCreatedToday: todayVideos?.count ?? 0,
    newUsersThisWeek: weekUsers?.count ?? 0,
    activeUsers: activeUsers?.count ?? 0,
    blockedUsers: blockedUsers?.count ?? 0,
  });
});

// ── User management ──────────────────────────────────────────────────────────

router.get("/admin/users", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("users.view"), async (req, res): Promise<void> => {
  const page = parseInt(String(req.query.page || "1"), 10);
  const limit = parseInt(String(req.query.limit || "20"), 10);
  const offset = (page - 1) * limit;

  const [users, totalResult] = await Promise.all([
    db.select().from(usersTable).orderBy(desc(usersTable.createdAt)).limit(limit).offset(offset),
    db.select({ count: count() }).from(usersTable),
  ]);

  const userIds = users.map((u) => u.id);
  const videoCounts = userIds.length > 0
    ? await db
        .select({ userId: videosTable.userId, count: count() })
        .from(videosTable)
        .where(inArray(videosTable.userId, userIds))
        .groupBy(videosTable.userId)
    : [];

  const vcMap = Object.fromEntries(videoCounts.map((vc) => [vc.userId, vc.count]));

  res.json({
    users: users.map((u) => ({
      id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
      avatarUrl: u.avatarUrl ?? null, createdAt: u.createdAt, updatedAt: u.updatedAt,
      videoCount: vcMap[u.id] ?? 0, storageUsedMb: u.storageUsedMb ?? 0,
    })),
    total: totalResult[0]?.count ?? 0,
    page,
    limit,
  });
});

router.post("/admin/users", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("users.create"), async (req, res): Promise<void> => {
  const actorRole = req.user!.role;

  const parsed = AdminCreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const { email, password, name, role } = parsed.data;
  const targetRole = role ?? "user";

  if (!canManage(actorRole, targetRole)) {
    res.status(403).json({ error: "Forbidden", message: `Your role (${actorRole}) cannot create a ${targetRole} account` });
    return;
  }

  const [existing] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "Conflict", message: "Email already registered" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await db.insert(usersTable).values({ email, passwordHash, name, role: targetRole as any }).returning();

  void logAudit(req.user!.userId, actorRole, "user.created", "user", user.id,
    { email: user.email, name: user.name, role: user.role }, req.ip ?? null);

  res.status(201).json({
    id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
    avatarUrl: user.avatarUrl ?? null, createdAt: user.createdAt, updatedAt: user.updatedAt,
    videoCount: 0, storageUsedMb: 0,
  });
});

router.patch("/admin/users/:id/role", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const actorId = req.user!.userId;

  if (id === actorId) {
    res.status(400).json({ error: "Bad request", message: "Cannot change your own role" });
    return;
  }

  const parsed = UpdateUserRoleBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const [target] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, id));
  if (!target) { res.status(404).json({ error: "Not found" }); return; }

  if (!canManage(req.user!.role, target.role)) {
    res.status(403).json({ error: "Forbidden", message: "Cannot change role of a user with equal or higher privileges" });
    return;
  }

  const [user] = await db.update(usersTable).set({ role: parsed.data.role }).where(eq(usersTable.id, id)).returning();
  const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, user.id));

  void logAudit(actorId, req.user!.role, "user.role.changed", "user", id,
    { from: target.role, to: parsed.data.role }, req.ip ?? null);

  res.json({
    id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
    avatarUrl: user.avatarUrl ?? null, createdAt: user.createdAt, updatedAt: user.updatedAt,
    videoCount: vc?.count ?? 0, storageUsedMb: user.storageUsedMb ?? 0,
  });
});

router.patch("/admin/users/:id/status", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("users.status"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const actorId = req.user!.userId;
  const actorRole = req.user!.role;

  if (id === actorId) {
    res.status(400).json({ error: "Bad request", message: "Cannot change your own status" });
    return;
  }

  const parsed = AdminUpdateUserStatusBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const [target] = await db.select({ role: usersTable.role, status: usersTable.status }).from(usersTable).where(eq(usersTable.id, id));
  if (!target) { res.status(404).json({ error: "Not found" }); return; }

  if (!canManage(actorRole, target.role)) {
    res.status(403).json({ error: "Forbidden", message: "Cannot modify a user with equal or higher privileges" });
    return;
  }

  const [user] = await db.update(usersTable).set({ status: parsed.data.status }).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "Not found" }); return; }

  const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, user.id));

  void logAudit(actorId, actorRole, "user.status.changed", "user", id,
    { from: target.status, to: parsed.data.status }, req.ip ?? null);

  res.json({
    id: user.id, email: user.email, name: user.name, role: user.role, status: user.status,
    avatarUrl: user.avatarUrl ?? null, createdAt: user.createdAt, updatedAt: user.updatedAt,
    videoCount: vc?.count ?? 0, storageUsedMb: user.storageUsedMb ?? 0,
  });
});

router.delete("/admin/users/:id", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("users.delete"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const actorId = req.user!.userId;
  const actorRole = req.user!.role;

  if (id === actorId) {
    res.status(400).json({ error: "Bad request", message: "Cannot delete your own account" });
    return;
  }

  const [target] = await db.select({ id: usersTable.id, role: usersTable.role, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, id));
  if (!target) { res.status(404).json({ error: "Not found" }); return; }

  if (!canManage(actorRole, target.role)) {
    res.status(403).json({ error: "Forbidden", message: "Cannot delete a user with equal or higher privileges" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));

  void logAudit(actorId, actorRole, "user.deleted", "user", id,
    { email: target.email, role: target.role }, req.ip ?? null);

  res.status(204).send();
});

// ── Video management ─────────────────────────────────────────────────────────

router.get("/admin/videos", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("videos.view"), async (req, res): Promise<void> => {
  const page = parseInt(String(req.query.page || "1"), 10);
  const limit = parseInt(String(req.query.limit || "20"), 10);
  const status = req.query.status as string | undefined;
  const offset = (page - 1) * limit;

  let videos;
  let totalResult;

  if (status) {
    videos = await db.select().from(videosTable).where(eq(videosTable.status, status as any)).orderBy(desc(videosTable.createdAt)).limit(limit).offset(offset);
    [totalResult] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.status, status as any));
  } else {
    videos = await db.select().from(videosTable).orderBy(desc(videosTable.createdAt)).limit(limit).offset(offset);
    [totalResult] = await db.select({ count: count() }).from(videosTable);
  }

  res.json({
    videos: videos.map((v) => ({
      id: v.id, userId: v.userId, projectId: v.projectId ?? null, title: v.title,
      description: v.description ?? null, inputType: v.inputType, inputContent: v.inputContent,
      style: v.style, durationSeconds: v.durationSeconds, status: v.status, progress: v.progress,
      outputUrl: v.outputUrl ?? null, thumbnailUrl: v.thumbnailUrl ?? null,
      errorMessage: v.errorMessage ?? null, createdAt: v.createdAt, updatedAt: v.updatedAt,
      completedAt: v.completedAt ?? null,
    })),
    total: totalResult?.count ?? 0,
    page,
    limit,
  });
});

// ── Analytics ─────────────────────────────────────────────────────────────────

router.get("/admin/analytics/realtime", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsersResult, activeUsersResult, blockedUsersResult,
    totalVideosResult, videosTodayResult, videosWeekResult,
    activeRenderResult, completedJobsResult, failedJobsResult,
    storageResult, totalAdsResult,
  ] = await Promise.all([
    db.select({ count: count() }).from(usersTable),
    db.select({ count: count() }).from(usersTable).where(eq(usersTable.status, "active")),
    db.select({ count: count() }).from(usersTable).where(eq(usersTable.status, "blocked")),
    db.select({ count: count() }).from(videosTable),
    db.select({ count: count() }).from(videosTable).where(gte(videosTable.createdAt, today)),
    db.select({ count: count() }).from(videosTable).where(gte(videosTable.createdAt, weekAgo)),
    db.select({ count: count() }).from(videosTable).where(eq(videosTable.status, "processing")),
    db.select({ count: count() }).from(videosTable).where(eq(videosTable.status, "completed")),
    db.select({ count: count() }).from(videosTable).where(eq(videosTable.status, "failed")),
    db.select({ total: sum(usersTable.storageUsedMb) }).from(usersTable),
    db.select({ count: count() }).from(adsTable),
  ]);

  const topUsers = await db
    .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role, videoCount: count(videosTable.id) })
    .from(usersTable)
    .leftJoin(videosTable, eq(videosTable.userId, usersTable.id))
    .groupBy(usersTable.id)
    .orderBy(desc(count(videosTable.id)))
    .limit(5);

  const totalStorageMb = Number(storageResult[0]?.total ?? 0);

  res.json({
    totalUsers: totalUsersResult[0]?.count ?? 0,
    activeUsers: activeUsersResult[0]?.count ?? 0,
    blockedUsers: blockedUsersResult[0]?.count ?? 0,
    totalVideos: totalVideosResult[0]?.count ?? 0,
    videosToday: videosTodayResult[0]?.count ?? 0,
    videosThisWeek: videosWeekResult[0]?.count ?? 0,
    activeRenderJobs: activeRenderResult[0]?.count ?? 0,
    completedJobs: completedJobsResult[0]?.count ?? 0,
    failedJobs: failedJobsResult[0]?.count ?? 0,
    totalStorageGb: +(totalStorageMb / 1024).toFixed(2),
    totalAds: totalAdsResult[0]?.count ?? 0,
    totalImpressions: 0,
    totalClicks: 0,
    topUsers: topUsers.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, videoCount: u.videoCount })),
  });
});

// ── Permissions management (super_admin only) ────────────────────────────────

router.get("/admin/my-permissions", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  if (req.user!.role === "super_admin") {
    res.json({ permissions: ["*"] });
    return;
  }
  const rows = await db
    .select({ permission: adminPermissionsTable.permission })
    .from(adminPermissionsTable)
    .where(eq(adminPermissionsTable.adminUserId, req.user!.userId));
  res.json({ permissions: rows.map((r) => r.permission) });
});

router.get("/admin/permissions/:userId", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const rows = await db
    .select({ permission: adminPermissionsTable.permission })
    .from(adminPermissionsTable)
    .where(eq(adminPermissionsTable.adminUserId, userId));
  res.json({ permissions: rows.map((r) => r.permission) });
});

router.put("/admin/permissions/:userId", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

  const parsed = SetAdminPermissionsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const [target] = await db.select({ role: usersTable.role, email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId));
  if (!target) { res.status(404).json({ error: "Not found" }); return; }

  if (target.role === "super_admin") {
    res.status(403).json({ error: "Forbidden", message: "Cannot modify super_admin permissions" });
    return;
  }

  await db.delete(adminPermissionsTable).where(eq(adminPermissionsTable.adminUserId, userId));

  const grantedBy = req.user!.userId;
  if (parsed.data.permissions.length > 0) {
    await db.insert(adminPermissionsTable).values(
      parsed.data.permissions.map((p) => ({ adminUserId: userId, permission: p, grantedBy })),
    );
  }

  void logAudit(grantedBy, req.user!.role, "permissions.updated", "user", userId,
    { email: target.email, permissions: parsed.data.permissions }, req.ip ?? null);

  res.json({ permissions: parsed.data.permissions });
});

// ── Audit logs ───────────────────────────────────────────────────────────────

router.get("/admin/audit-logs", requireAuth, requireRole("admin", "super_admin"), requireAdminPermission("audit.view"), async (req, res): Promise<void> => {
  const page = parseInt(String(req.query.page || "1"), 10);
  const limit = Math.min(parseInt(String(req.query.limit || "50"), 10), 100);
  const actorIdFilter = req.query.actorId as string | undefined;
  const actionFilter = req.query.action as string | undefined;
  const offset = (page - 1) * limit;

  const conditions = [];
  if (actorIdFilter) conditions.push(eq(adminAuditLogsTable.actorId, actorIdFilter));
  if (actionFilter) conditions.push(eq(adminAuditLogsTable.action, actionFilter));

  const whereClause = conditions.length > 0 ? (conditions.length === 1 ? conditions[0] : and(...conditions)) : undefined;
  const [logs, totalResult] = await Promise.all([
    db
      .select({
        id: adminAuditLogsTable.id,
        actorId: adminAuditLogsTable.actorId,
        storedActorName: adminAuditLogsTable.actorName,
        storedActorEmail: adminAuditLogsTable.actorEmail,
        joinedActorName: usersTable.name,
        joinedActorEmail: usersTable.email,
        actorRole: adminAuditLogsTable.actorRole,
        action: adminAuditLogsTable.action,
        targetType: adminAuditLogsTable.targetType,
        targetId: adminAuditLogsTable.targetId,
        details: adminAuditLogsTable.details,
        ipAddress: adminAuditLogsTable.ipAddress,
        createdAt: adminAuditLogsTable.createdAt,
      })
      .from(adminAuditLogsTable)
      .leftJoin(usersTable, eq(usersTable.id, adminAuditLogsTable.actorId))
      .where(whereClause)
      .orderBy(desc(adminAuditLogsTable.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(adminAuditLogsTable)
      .where(whereClause),
  ]);

  const total = totalResult[0]?.count ?? 0;
  res.json({
    logs: logs.map((l) => ({
      id: l.id,
      actorId: l.actorId,
      // Prefer stored snapshot (survives user deletion); fall back to live join for legacy rows
      actorEmail: l.storedActorEmail ?? l.joinedActorEmail ?? "unknown",
      actorName: l.storedActorName ?? l.joinedActorName ?? "Deleted User",
      actorRole: l.actorRole,
      action: l.action,
      targetType: l.targetType ?? null,
      targetId: l.targetId ?? null,
      details: l.details ?? null,
      ipAddress: l.ipAddress ?? null,
      createdAt: l.createdAt,
    })),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

export default router;
