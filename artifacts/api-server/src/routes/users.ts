import { Router, type IRouter } from "express";
import { db, usersTable, videosTable } from "@workspace/db";
import { eq, ilike, count, and } from "drizzle-orm";
import { UpdateUserBody } from "@workspace/api-zod";
import { requireAuth, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/users", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const page = parseInt(String(req.query.page || "1"), 10);
  const limit = parseInt(String(req.query.limit || "20"), 10);
  const search = req.query.search as string | undefined;
  const role = req.query.role as string | undefined;
  const offset = (page - 1) * limit;

  let query = db.select().from(usersTable);

  const conditions: ReturnType<typeof eq>[] = [];
  if (search) conditions.push(ilike(usersTable.name, `%${search}%`));
  if (role) conditions.push(eq(usersTable.role, role as any));

  const users = await (conditions.length > 0
    ? db.select().from(usersTable).where(and(...conditions)).limit(limit).offset(offset)
    : db.select().from(usersTable).limit(limit).offset(offset));

  const [totalResult] = await (conditions.length > 0
    ? db.select({ count: count() }).from(usersTable).where(and(...conditions))
    : db.select({ count: count() }).from(usersTable));

  const usersWithCounts = await Promise.all(
    users.map(async (user) => {
      const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, user.id));
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatarUrl: user.avatarUrl ?? null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        videoCount: vc?.count ?? 0,
        storageUsedMb: user.storageUsedMb ?? 0,
      };
    })
  );

  res.json({
    users: usersWithCounts,
    total: totalResult?.count ?? 0,
    page,
    limit,
  });
});

router.get("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (req.user!.userId !== id && !["admin", "super_admin"].includes(req.user!.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) {
    res.status(404).json({ error: "Not found", message: "User not found" });
    return;
  }

  const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, user.id));

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    videoCount: vc?.count ?? 0,
    storageUsedMb: user.storageUsedMb ?? 0,
  });
});

router.patch("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (req.user!.userId !== id && !["admin", "super_admin"].includes(req.user!.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.avatarUrl !== undefined) updates.avatarUrl = parsed.data.avatarUrl;

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.userId, user.id));

  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    videoCount: vc?.count ?? 0,
    storageUsedMb: user.storageUsedMb ?? 0,
  });
});

router.delete("/users/:id", requireAuth, requireRole("admin", "super_admin"), async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (req.user!.userId === id) {
    res.status(400).json({ error: "Bad request", message: "Cannot delete your own account" });
    return;
  }

  const [user] = await db.delete(usersTable).where(eq(usersTable.id, id)).returning();
  if (!user) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ message: "User deleted successfully" });
});

export default router;
