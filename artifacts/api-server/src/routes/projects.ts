import { Router, type IRouter } from "express";
import { db, projectsTable, videosTable } from "@workspace/db";
import { eq, and, count, desc } from "drizzle-orm";
import { CreateProjectBody, UpdateProjectBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

async function formatProject(p: typeof projectsTable.$inferSelect) {
  const [vc] = await db.select({ count: count() }).from(videosTable).where(eq(videosTable.projectId, p.id));
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description ?? null,
    videoCount: vc?.count ?? 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

router.get("/projects", requireAuth, async (req, res): Promise<void> => {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.userId, req.user!.userId))
    .orderBy(desc(projectsTable.createdAt));

  const formatted = await Promise.all(projects.map(formatProject));

  res.json({ projects: formatted, total: formatted.length });
});

router.post("/projects", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const [project] = await db.insert(projectsTable).values({
    userId: req.user!.userId,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
  }).returning();

  res.status(201).json(await formatProject(project));
});

router.get("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [project] = await db.select().from(projectsTable).where(
    and(eq(projectsTable.id, id), eq(projectsTable.userId, req.user!.userId))
  );

  if (!project) {
    res.status(404).json({ error: "Not found", message: "Project not found" });
    return;
  }

  res.json(await formatProject(project));
});

router.patch("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const parsed = UpdateProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", message: parsed.error.message });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.description !== undefined) updates.description = parsed.data.description;

  const [project] = await db.update(projectsTable)
    .set(updates)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, req.user!.userId)))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(await formatProject(project));
});

router.delete("/projects/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  const [project] = await db.delete(projectsTable)
    .where(and(eq(projectsTable.id, id), eq(projectsTable.userId, req.user!.userId)))
    .returning();

  if (!project) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ message: "Project deleted successfully" });
});

export default router;
