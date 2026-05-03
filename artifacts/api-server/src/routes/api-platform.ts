import { Router, type IRouter } from "express";
import { db, apiClientsTable, apiKeysTable, apiRequestLogsTable, apiClientUsersTable } from "@workspace/db";
import { eq, count, sum, sql, gte, and } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";
import { usersTable } from "@workspace/db/schema";
import crypto from "crypto";

const router: IRouter = Router();

function param(v: string | string[]): string {
  return Array.isArray(v) ? v[0]! : v;
}

function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function generateApiKey(): string {
  const raw = crypto.randomBytes(36).toString("hex");
  return `gems_${raw}`;
}

function todayMidnightUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function buildClientWithStats(
  client: typeof apiClientsTable.$inferSelect,
  keyCount: number,
  totalRequests: number,
  userCount: number
) {
  return {
    id: client.id,
    name: client.name,
    email: client.email,
    company: client.company ?? null,
    status: client.status,
    notes: client.notes ?? null,
    keyCount,
    totalRequests,
    userCount,
    createdAt: client.createdAt.toISOString(),
  };
}

function buildKey(k: typeof apiKeysTable.$inferSelect, checkExpiry = true) {
  const now = new Date();
  const isExpired = checkExpiry && k.validUntil < now;
  return {
    id: k.id,
    clientId: k.clientId,
    name: k.name,
    keyPrefix: k.keyPrefix,
    status: isExpired && k.status === "active" ? "expired" : k.status,
    validFrom: k.validFrom.toISOString(),
    validUntil: k.validUntil.toISOString(),
    pricingTier: k.pricingTier,
    priceUsd: k.priceUsd,
    requestCount: k.requestCount,
    requestLimitPerDay: k.requestLimitPerDay,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

function buildApiUser(u: typeof apiClientUsersTable.$inferSelect) {
  return {
    id: u.id,
    apiClientId: u.apiClientId,
    externalId: u.externalId ?? null,
    name: u.name,
    email: u.email,
    status: u.status,
    transferredToUserId: u.transferredToUserId ?? null,
    transferredAt: u.transferredAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

async function getClientStats(clientId: string) {
  const [keyCountRow] = await db.select({ count: count() }).from(apiKeysTable).where(eq(apiKeysTable.clientId, clientId));
  const [reqRow] = await db.select({ total: sum(apiKeysTable.requestCount) }).from(apiKeysTable).where(eq(apiKeysTable.clientId, clientId));
  const [userCountRow] = await db.select({ count: count() }).from(apiClientUsersTable).where(eq(apiClientUsersTable.apiClientId, clientId));
  return {
    keyCount: keyCountRow?.count ?? 0,
    totalRequests: Number(reqRow?.total ?? 0),
    userCount: userCountRow?.count ?? 0,
  };
}

// LIST CLIENTS
router.get(
  "/admin/api-clients",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clients = await db.select().from(apiClientsTable).orderBy(sql`${apiClientsTable.createdAt} desc`);
    const result = await Promise.all(
      clients.map(async (c) => {
        const stats = await getClientStats(c.id);
        return buildClientWithStats(c, stats.keyCount, stats.totalRequests, stats.userCount);
      })
    );
    res.json(result);
  }
);

// CREATE CLIENT
router.post(
  "/admin/api-clients",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const { name, email, company, notes } = req.body as {
      name: string; email: string; company?: string; notes?: string;
    };
    if (!name || !email) {
      res.status(400).json({ error: "name and email are required" });
      return;
    }
    const [client] = await db
      .insert(apiClientsTable)
      .values({ name, email, company: company ?? null, notes: notes ?? null, createdByUserId: req.user?.userId })
      .returning();
    res.status(201).json(buildClientWithStats(client!, 0, 0, 0));
  }
);

// UPDATE CLIENT STATUS
router.patch(
  "/admin/api-clients/:clientId/status",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const { status } = req.body as { status: "active" | "blocked" | "suspended" };
    if (!["active", "blocked", "suspended"].includes(status)) {
      res.status(400).json({ error: "Invalid status" }); return;
    }
    const [updated] = await db.update(apiClientsTable)
      .set({ status, updatedAt: new Date() })
      .where(eq(apiClientsTable.id, clientId))
      .returning();
    if (!updated) { res.status(404).json({ error: "Client not found" }); return; }
    const stats = await getClientStats(clientId);
    res.json(buildClientWithStats(updated, stats.keyCount, stats.totalRequests, stats.userCount));
  }
);

// DELETE CLIENT
router.delete(
  "/admin/api-clients/:clientId",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    await db.delete(apiClientsTable).where(eq(apiClientsTable.id, clientId));
    res.status(204).send();
  }
);

// LIST KEYS FOR CLIENT
router.get(
  "/admin/api-clients/:clientId/keys",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const keys = await db.select().from(apiKeysTable)
      .where(eq(apiKeysTable.clientId, clientId))
      .orderBy(sql`${apiKeysTable.createdAt} desc`);
    res.json(keys.map((k) => buildKey(k)));
  }
);

// CREATE KEY
router.post(
  "/admin/api-clients/:clientId/keys",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const {
      name,
      validDays = 365,
      pricingTier = "standard",
      priceUsd = 99,
      requestLimitPerDay = 1000,
    } = req.body as {
      name: string; validDays?: number; pricingTier?: string;
      priceUsd?: number; requestLimitPerDay?: number;
    };
    if (!name) { res.status(400).json({ error: "name is required" }); return; }

    const existing = await db.select({ id: apiClientsTable.id }).from(apiClientsTable)
      .where(eq(apiClientsTable.id, clientId)).limit(1);
    if (!existing.length) { res.status(404).json({ error: "Client not found" }); return; }

    const fullKey = generateApiKey();
    const keyHash = hashKey(fullKey);
    const keyPrefix = fullKey.substring(0, 12);
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + (validDays ?? 365));

    const [key] = await db.insert(apiKeysTable).values({
      clientId,
      name,
      keyHash,
      keyPrefix,
      validUntil,
      pricingTier,
      priceUsd,
      requestLimitPerDay,
    }).returning();

    res.status(201).json({
      key: fullKey,
      ...buildKey(key!, false),
    });
  }
);

// UPDATE KEY STATUS
router.patch(
  "/admin/api-clients/:clientId/keys/:keyId/status",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const keyId = param(req.params.keyId);
    const { status } = req.body as { status: "active" | "blocked" | "suspended" | "expired" };
    if (!["active", "blocked", "suspended", "expired"].includes(status)) {
      res.status(400).json({ error: "Invalid status" }); return;
    }
    const [updated] = await db.update(apiKeysTable).set({ status })
      .where(eq(apiKeysTable.id, keyId)).returning();
    if (!updated || updated.clientId !== clientId) {
      res.status(404).json({ error: "Key not found" }); return;
    }
    res.json(buildKey(updated, false));
  }
);

// RENEW KEY — extend validity
router.patch(
  "/admin/api-clients/:clientId/keys/:keyId/renew",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const keyId = param(req.params.keyId);
    const { validDays = 365 } = req.body as { validDays?: number };

    const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, keyId)).limit(1);
    if (!key || key.clientId !== clientId) {
      res.status(404).json({ error: "Key not found" }); return;
    }

    const now = new Date();
    const base = key.validUntil > now ? key.validUntil : now;
    const newValidUntil = new Date(base);
    newValidUntil.setDate(newValidUntil.getDate() + (validDays ?? 365));

    const [updated] = await db.update(apiKeysTable)
      .set({ validUntil: newValidUntil, status: "active" })
      .where(eq(apiKeysTable.id, keyId))
      .returning();
    res.json(buildKey(updated!, false));
  }
);

// DELETE KEY
router.delete(
  "/admin/api-clients/:clientId/keys/:keyId",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const keyId = param(req.params.keyId);
    const [key] = await db.select().from(apiKeysTable).where(eq(apiKeysTable.id, keyId)).limit(1);
    if (!key || key.clientId !== clientId) {
      res.status(404).json({ error: "Key not found" }); return;
    }
    await db.delete(apiKeysTable).where(eq(apiKeysTable.id, keyId));
    res.status(204).send();
  }
);

// LIST API USERS FOR CLIENT
router.get(
  "/admin/api-clients/:clientId/users",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const users = await db.select().from(apiClientUsersTable)
      .where(eq(apiClientUsersTable.apiClientId, clientId))
      .orderBy(sql`${apiClientUsersTable.createdAt} desc`);
    res.json(users.map(buildApiUser));
  }
);

// UPDATE API USER STATUS (block/unblock)
router.patch(
  "/admin/api-clients/:clientId/users/:userId/status",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const userId = param(req.params.userId);
    const { status } = req.body as { status: "active" | "blocked" | "pending_transfer" };
    if (!["active", "blocked", "pending_transfer"].includes(status)) {
      res.status(400).json({ error: "Invalid status" }); return;
    }
    const [updated] = await db.update(apiClientUsersTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, clientId)))
      .returning();
    if (!updated) { res.status(404).json({ error: "User not found" }); return; }
    res.json(buildApiUser(updated));
  }
);

// TRANSFER API USER TO MAIN SYSTEM
router.post(
  "/admin/api-clients/:clientId/users/:userId/transfer",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const userId = param(req.params.userId);

    const [apiUser] = await db.select().from(apiClientUsersTable)
      .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, clientId)))
      .limit(1);
    if (!apiUser) { res.status(404).json({ error: "User not found" }); return; }
    if (apiUser.status === "transferred") {
      res.status(400).json({ error: "User already transferred" }); return;
    }

    const existingUser = await db.select({ id: usersTable.id })
      .from(usersTable).where(eq(usersTable.email, apiUser.email)).limit(1);

    let mainUserId: string;

    if (existingUser.length > 0) {
      mainUserId = existingUser[0]!.id;
    } else {
      const [newUser] = await db.insert(usersTable).values({
        name: apiUser.name,
        email: apiUser.email,
        passwordHash: crypto.randomBytes(32).toString("hex"),
        role: "user",
        status: "active",
      }).returning({ id: usersTable.id });
      mainUserId = newUser!.id;
    }

    const [updated] = await db.update(apiClientUsersTable)
      .set({ status: "transferred", transferredToUserId: mainUserId, transferredAt: new Date(), updatedAt: new Date() })
      .where(eq(apiClientUsersTable.id, userId))
      .returning();

    res.json({ apiUser: buildApiUser(updated!), mainUserId });
  }
);

// DELETE API USER
router.delete(
  "/admin/api-clients/:clientId/users/:userId",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const userId = param(req.params.userId);
    const [u] = await db.select().from(apiClientUsersTable)
      .where(and(eq(apiClientUsersTable.id, userId), eq(apiClientUsersTable.apiClientId, clientId)))
      .limit(1);
    if (!u) { res.status(404).json({ error: "User not found" }); return; }
    await db.delete(apiClientUsersTable).where(eq(apiClientUsersTable.id, userId));
    res.status(204).send();
  }
);

// REQUEST LOGS FOR CLIENT
router.get(
  "/admin/api-clients/:clientId/logs",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const clientId = param(req.params.clientId);
    const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);

    const keys = await db.select({ id: apiKeysTable.id, name: apiKeysTable.name })
      .from(apiKeysTable).where(eq(apiKeysTable.clientId, clientId));
    if (!keys.length) { res.json([]); return; }

    const keyIds = keys.map((k) => k.id);
    const keyNameMap = Object.fromEntries(keys.map((k) => [k.id, k.name]));

    const logs = await db.select().from(apiRequestLogsTable)
      .where(sql`${apiRequestLogsTable.apiKeyId} = ANY(${sql.raw(`ARRAY[${keyIds.map((id) => `'${id}'`).join(",")}]::uuid[]`)})`)
      .orderBy(sql`${apiRequestLogsTable.createdAt} desc`)
      .limit(limit);

    res.json(logs.map((l) => ({
      id: l.id,
      apiKeyId: l.apiKeyId,
      keyName: keyNameMap[l.apiKeyId] ?? "unknown",
      ip: l.ip,
      endpoint: l.endpoint,
      method: l.method,
      statusCode: l.statusCode,
      responseTimeMs: l.responseTimeMs ?? null,
      createdAt: l.createdAt.toISOString(),
    })));
  }
);

// PLATFORM STATS
router.get(
  "/admin/api-platform/stats",
  requireAuth,
  requireRole("super_admin"),
  async (req, res): Promise<void> => {
    const todayMidnight = todayMidnightUtc();

    const [totalClients] = await db.select({ count: count() }).from(apiClientsTable);
    const [activeClients] = await db.select({ count: count() }).from(apiClientsTable).where(eq(apiClientsTable.status, "active"));
    const [blockedClients] = await db.select({ count: count() }).from(apiClientsTable).where(eq(apiClientsTable.status, "blocked"));
    const [totalKeys] = await db.select({ count: count() }).from(apiKeysTable);
    const [activeKeys] = await db.select({ count: count() }).from(apiKeysTable).where(eq(apiKeysTable.status, "active"));
    const [totalReqRow] = await db.select({ total: sum(apiKeysTable.requestCount) }).from(apiKeysTable);
    const [reqTodayRow] = await db.select({ count: count() }).from(apiRequestLogsTable)
      .where(gte(apiRequestLogsTable.createdAt, todayMidnight));
    const [totalApiUsers] = await db.select({ count: count() }).from(apiClientUsersTable);
    const [pendingTransfers] = await db.select({ count: count() }).from(apiClientUsersTable)
      .where(eq(apiClientUsersTable.status, "pending_transfer"));

    const allClients = await db.select().from(apiClientsTable).orderBy(sql`${apiClientsTable.createdAt} desc`);
    const clientStats = await Promise.all(
      allClients.map(async (c) => {
        const [kRow] = await db.select({ count: count() }).from(apiKeysTable).where(eq(apiKeysTable.clientId, c.id));
        const [reqRow] = await db.select({ total: sum(apiKeysTable.requestCount), revenue: sum(apiKeysTable.priceUsd) })
          .from(apiKeysTable).where(eq(apiKeysTable.clientId, c.id));
        const [uRow] = await db.select({ count: count() }).from(apiClientUsersTable)
          .where(eq(apiClientUsersTable.apiClientId, c.id));
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          company: c.company ?? null,
          status: c.status,
          keyCount: kRow?.count ?? 0,
          totalRequests: Number(reqRow?.total ?? 0),
          revenueUsd: Number(reqRow?.revenue ?? 0),
          userCount: uRow?.count ?? 0,
        };
      })
    );

    res.json({
      totalClients: totalClients?.count ?? 0,
      activeClients: activeClients?.count ?? 0,
      blockedClients: blockedClients?.count ?? 0,
      totalKeys: totalKeys?.count ?? 0,
      activeKeys: activeKeys?.count ?? 0,
      totalRequests: Number(totalReqRow?.total ?? 0),
      requestsToday: reqTodayRow?.count ?? 0,
      revenueTotal: clientStats.reduce((acc, c) => acc + c.revenueUsd, 0),
      totalApiUsers: totalApiUsers?.count ?? 0,
      pendingTransfers: pendingTransfers?.count ?? 0,
      clientStats,
    });
  }
);

export default router;
