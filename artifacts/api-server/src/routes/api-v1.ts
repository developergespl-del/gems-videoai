import { Router, Request, Response, NextFunction, type IRouter } from "express";
import { db, apiKeysTable, apiClientUsersTable, apiClientsTable, apiRequestLogsTable } from "@workspace/db";
import { eq, and, gte, count, sql } from "drizzle-orm";
import crypto from "crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function todayMidnightUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

declare global {
  namespace Express {
    interface Request {
      apiKey?: typeof apiKeysTable.$inferSelect;
      apiClient?: typeof apiClientsTable.$inferSelect;
    }
  }
}

async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const start = Date.now();
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "API key required. Send as: Authorization: Bearer gems_xxx" });
    return;
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey.startsWith("gems_")) {
    res.status(401).json({ error: "unauthorized", message: "Invalid API key format" });
    return;
  }

  const keyHash = hashKey(rawKey);
  const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.keyHash, keyHash)).limit(1);

  if (!key) {
    res.status(401).json({ error: "unauthorized", message: "Invalid API key" });
    return;
  }

  const now = new Date();

  if (key.status === "blocked") {
    res.status(403).json({ error: "forbidden", message: "This API key has been blocked. Contact GEMS support." });
    return;
  }
  if (key.status === "suspended") {
    res.status(403).json({ error: "forbidden", message: "This API key is suspended. Contact GEMS support." });
    return;
  }
  if (key.status === "expired" || key.validUntil < now) {
    res.status(403).json({ error: "forbidden", message: "This API key has expired. Please renew your subscription." });
    return;
  }

  const [client] = await db.select().from(apiClientsTable).where(eq(apiClientsTable.id, key.clientId)).limit(1);
  if (!client) {
    res.status(403).json({ error: "forbidden", message: "API client not found" });
    return;
  }
  if (client.status === "blocked") {
    res.status(403).json({ error: "forbidden", message: "Your API account has been blocked. Contact GEMS support." });
    return;
  }
  if (client.status === "suspended") {
    res.status(403).json({ error: "forbidden", message: "Your API account is suspended. Contact GEMS support." });
    return;
  }

  const todayMidnight = todayMidnightUtc();
  const [todayCount] = await db.select({ count: count() })
    .from(apiRequestLogsTable)
    .where(and(eq(apiRequestLogsTable.apiKeyId, key.id), gte(apiRequestLogsTable.createdAt, todayMidnight)));

  const usedToday = todayCount?.count ?? 0;
  if (usedToday >= key.requestLimitPerDay) {
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: `Daily request limit of ${key.requestLimitPerDay} reached. Resets at UTC midnight.`,
      limit: key.requestLimitPerDay,
      used: usedToday,
    });
    return;
  }

  req.apiKey = key;
  req.apiClient = client;

  res.on("finish", () => {
    const responseTimeMs = Date.now() - start;
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "";
    const endpoint = req.path;
    const method = req.method;
    const statusCode = res.statusCode;

    db.insert(apiRequestLogsTable).values({
      apiKeyId: key.id,
      ip,
      endpoint,
      method,
      statusCode,
      responseTimeMs,
    }).catch((err) => logger.error(err, "Failed to write API request log"));

    db.update(apiKeysTable)
      .set({ requestCount: sql`${apiKeysTable.requestCount} + 1`, lastUsedAt: new Date() })
      .where(eq(apiKeysTable.id, key.id))
      .catch((err) => logger.error(err, "Failed to increment request count"));
  });

  next();
}

function buildUser(u: typeof apiClientUsersTable.$inferSelect) {
  return {
    id: u.id,
    externalId: u.externalId ?? null,
    name: u.name,
    email: u.email,
    status: u.status,
    createdAt: u.createdAt.toISOString(),
  };
}

// HEALTH CHECK
router.get("/api/v1/health", requireApiKey, (req, res): void => {
  res.json({
    status: "ok",
    client: req.apiClient!.name,
    keyPrefix: req.apiKey!.keyPrefix,
    requestsToday: null,
    validUntil: req.apiKey!.validUntil.toISOString(),
  });
});

// CREATE USER
router.post("/api/v1/users", requireApiKey, async (req, res): Promise<void> => {
  const { name, email, externalId } = req.body as { name?: string; email?: string; externalId?: string };
  if (!name || !email) {
    res.status(400).json({ error: "bad_request", message: "name and email are required" });
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    res.status(400).json({ error: "bad_request", message: "Invalid email address" });
    return;
  }

  const existing = await db.select({ id: apiClientUsersTable.id })
    .from(apiClientUsersTable)
    .where(and(
      eq(apiClientUsersTable.apiClientId, req.apiClient!.id),
      eq(apiClientUsersTable.email, email.toLowerCase())
    ))
    .limit(1);

  if (existing.length > 0) {
    res.status(409).json({ error: "conflict", message: "A user with this email already exists for this API client" });
    return;
  }

  const [user] = await db.insert(apiClientUsersTable).values({
    apiClientId: req.apiClient!.id,
    name,
    email: email.toLowerCase(),
    externalId: externalId ?? null,
    status: "active",
  }).returning();

  res.status(201).json(buildUser(user!));
});

// LIST USERS
router.get("/api/v1/users", requireApiKey, async (req, res): Promise<void> => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
  const statusFilter = req.query.status as string | undefined;

  const conditions = [eq(apiClientUsersTable.apiClientId, req.apiClient!.id)];
  if (statusFilter && ["active", "blocked"].includes(statusFilter)) {
    conditions.push(eq(apiClientUsersTable.status, statusFilter as "active" | "blocked"));
  }

  const users = await db.select().from(apiClientUsersTable)
    .where(and(...conditions))
    .orderBy(sql`${apiClientUsersTable.createdAt} desc`)
    .limit(limit);

  res.json({ users: users.map(buildUser), total: users.length });
});

// GET USER
router.get("/api/v1/users/:userId", requireApiKey, async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0]! : req.params.userId;
  const [user] = await db.select().from(apiClientUsersTable)
    .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, req.apiClient!.id)))
    .limit(1);
  if (!user) { res.status(404).json({ error: "not_found", message: "User not found" }); return; }
  res.json(buildUser(user));
});

// UPDATE USER STATUS
router.patch("/api/v1/users/:userId", requireApiKey, async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0]! : req.params.userId;
  const { status } = req.body as { status?: "active" | "blocked" };
  if (status && !["active", "blocked"].includes(status)) {
    res.status(400).json({ error: "bad_request", message: "status must be active or blocked" });
    return;
  }
  const updateData: Partial<typeof apiClientUsersTable.$inferInsert> = { updatedAt: new Date() };
  if (status) updateData.status = status;

  const [updated] = await db.update(apiClientUsersTable)
    .set(updateData)
    .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, req.apiClient!.id)))
    .returning();
  if (!updated) { res.status(404).json({ error: "not_found", message: "User not found" }); return; }
  res.json(buildUser(updated));
});

// DELETE USER
router.delete("/api/v1/users/:userId", requireApiKey, async (req, res): Promise<void> => {
  const userId = Array.isArray(req.params.userId) ? req.params.userId[0]! : req.params.userId;
  const [u] = await db.select().from(apiClientUsersTable)
    .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, req.apiClient!.id)))
    .limit(1);
  if (!u) { res.status(404).json({ error: "not_found", message: "User not found" }); return; }
  await db.delete(apiClientUsersTable).where(eq(apiClientUsersTable.id, userId));
  res.status(204).send();
});

export default router;
