import { Router, type IRouter } from "express";
import { db, charactersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { uploadCharacterFaceToS3, uploadVoiceSampleToS3 } from "../lib/s3";

const router: IRouter = Router();

const VALID_SLOTS = ["front", "left", "right", "back", "extra1", "extra2", "extra3"] as const;
type FaceSlot = (typeof VALID_SLOTS)[number];

const slotToColumn: Record<FaceSlot, keyof typeof charactersTable.$inferSelect> = {
  front: "frontFaceUrl",
  left: "leftFaceUrl",
  right: "rightFaceUrl",
  back: "backFaceUrl",
  extra1: "extraFace1Url",
  extra2: "extraFace2Url",
  extra3: "extraFace3Url",
};

function getFaceImages(c: typeof charactersTable.$inferSelect): string[] {
  return [
    c.frontFaceUrl,
    c.leftFaceUrl,
    c.rightFaceUrl,
    c.backFaceUrl,
    c.extraFace1Url,
    c.extraFace2Url,
    c.extraFace3Url,
  ].filter((u): u is string => !!u);
}

function formatCharacter(c: typeof charactersTable.$inferSelect) {
  return {
    id: c.id,
    userId: c.userId,
    name: c.name,
    description: c.description ?? null,
    frontFaceUrl: c.frontFaceUrl ?? null,
    leftFaceUrl: c.leftFaceUrl ?? null,
    rightFaceUrl: c.rightFaceUrl ?? null,
    backFaceUrl: c.backFaceUrl ?? null,
    extraFace1Url: c.extraFace1Url ?? null,
    extraFace2Url: c.extraFace2Url ?? null,
    extraFace3Url: c.extraFace3Url ?? null,
    faceImages: getFaceImages(c),
    voiceSampleUrl: c.voiceSampleUrl ?? null,
    voiceModelStatus: c.voiceModelStatus,
    status: c.status,
    ageGroup: c.ageGroup,
    gender: c.gender,
    isPublic: c.isPublic,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// GET /characters
router.get("/characters", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.userId, req.user!.userId))
    .orderBy(desc(charactersTable.createdAt));

  res.json({ characters: rows.map(formatCharacter), total: rows.length });
});

// POST /characters
router.post("/characters", requireAuth, async (req, res): Promise<void> => {
  const { name, description, ageGroup, gender } = req.body as {
    name?: string;
    description?: string;
    ageGroup?: string;
    gender?: string;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const [row] = await db
    .insert(charactersTable)
    .values({
      userId: req.user!.userId,
      name: name.trim(),
      description: description?.trim() ?? null,
      ageGroup: (ageGroup as any) ?? "adult",
      gender: (gender as any) ?? "neutral",
    })
    .returning();

  logger.info({ characterId: row!.id }, "Character created");
  res.status(201).json(formatCharacter(row!));
});

// GET /characters/:id
router.get("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [row] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!row) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  res.json(formatCharacter(row));
});

// PATCH /characters/:id
router.patch("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { name, description, ageGroup, gender, isPublic } = req.body as {
    name?: string;
    description?: string;
    ageGroup?: string;
    gender?: string;
    isPublic?: boolean;
  };

  const [existing] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const updates: Partial<typeof charactersTable.$inferInsert> = {};
  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description.trim() || null;
  if (ageGroup !== undefined) updates.ageGroup = ageGroup as any;
  if (gender !== undefined) updates.gender = gender as any;
  if (isPublic !== undefined) updates.isPublic = isPublic;

  const [updated] = await db
    .update(charactersTable)
    .set(updates)
    .where(eq(charactersTable.id, id))
    .returning();

  res.json(formatCharacter(updated!));
});

// DELETE /characters/:id
router.delete("/characters/:id", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const [existing] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  await db.delete(charactersTable).where(eq(charactersTable.id, id));
  res.status(204).send();
});

// POST /characters/:id/upload-face  — body: { slot, data (base64), mimeType }
// slot: front | left | right | back | extra1 | extra2 | extra3  (up to 7 total)
router.post("/characters/:id/upload-face", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { slot, data, mimeType } = req.body as {
    slot?: string;
    data?: string;
    mimeType?: string;
  };

  if (!slot || !(VALID_SLOTS as readonly string[]).includes(slot)) {
    res.status(400).json({ error: `slot must be one of: ${VALID_SLOTS.join(", ")}` });
    return;
  }
  if (!data) {
    res.status(400).json({ error: "data (base64) is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  // Enforce max 7 images total — count how many slots are already filled
  const filledSlots = getFaceImages(existing).length;
  const thisSlotEmpty = !existing[slotToColumn[slot as FaceSlot] as keyof typeof existing];
  if (thisSlotEmpty && filledSlots >= 7) {
    res.status(400).json({ error: "Maximum 7 face images allowed per character" });
    return;
  }

  const contentType = mimeType ?? "image/jpeg";
  const buffer = Buffer.from(data, "base64");

  const url = await uploadCharacterFaceToS3(
    id,
    slot as "front" | "left" | "right" | "back",
    buffer,
    contentType
  );

  const fallbackUrl = url ?? `https://picsum.photos/seed/${id}-${slot}/400/400`;
  const colName = slotToColumn[slot as FaceSlot];

  const updates: Record<string, any> = { [colName]: fallbackUrl };

  // Determine if character is now ready (has at least one face image)
  const hasFront = slot === "front" ? true : !!existing.frontFaceUrl;
  const hasAnyFace = hasFront || filledSlots > 0;
  if (hasAnyFace && existing.status === "draft") {
    updates.status = "ready";
  }

  const [updated] = await db
    .update(charactersTable)
    .set(updates)
    .where(eq(charactersTable.id, id))
    .returning();

  logger.info({ characterId: id, slot, url: fallbackUrl }, "Character face uploaded");
  res.json({ ...formatCharacter(updated!), uploadedUrl: fallbackUrl });
});

// POST /characters/:id/upload-voice  — body: { data (base64), mimeType }
router.post("/characters/:id/upload-voice", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { data, mimeType } = req.body as { data?: string; mimeType?: string };

  if (!data) {
    res.status(400).json({ error: "data (base64) is required" });
    return;
  }

  const [existing] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const contentType = mimeType ?? "audio/webm";
  const buffer = Buffer.from(data, "base64");

  const url = await uploadVoiceSampleToS3(id, buffer, contentType);
  const finalUrl = url ?? null;

  const [updated] = await db
    .update(charactersTable)
    .set({
      voiceSampleUrl: finalUrl,
      voiceModelStatus: finalUrl ? "processing" : "failed",
    })
    .where(eq(charactersTable.id, id))
    .returning();

  // Simulate voice model processing (in production this would be a real AI service)
  if (finalUrl) {
    setTimeout(async () => {
      await db
        .update(charactersTable)
        .set({ voiceModelStatus: "ready" })
        .where(eq(charactersTable.id, id));
    }, 5000);
  }

  logger.info({ characterId: id, url: finalUrl }, "Voice sample uploaded");
  res.json(formatCharacter(updated!));
});

// DELETE /characters/:id/face/:slot
router.delete("/characters/:id/face/:slot", requireAuth, async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const slot = req.params.slot as string;

  if (!(VALID_SLOTS as readonly string[]).includes(slot)) {
    res.status(400).json({ error: `Invalid slot. Must be one of: ${VALID_SLOTS.join(", ")}` });
    return;
  }

  const [existing] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.id, id), eq(charactersTable.userId, req.user!.userId)));

  if (!existing) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const colName = slotToColumn[slot as FaceSlot];
  const updates: Record<string, any> = { [colName]: null };

  const [updated] = await db
    .update(charactersTable)
    .set(updates)
    .where(eq(charactersTable.id, id))
    .returning();

  res.json(formatCharacter(updated!));
});

export default router;
