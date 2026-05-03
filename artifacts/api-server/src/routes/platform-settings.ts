import { Router } from "express";
import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireAuth, requireRole } from "../middlewares/auth";

const router = Router();

const DEFAULT_SETTINGS = {
  maintenanceMode: false,
  maintenanceMessage: "The system is currently under maintenance. Please check back soon.",
  adsEnabled: false,
  supportWhatsapp: null as string | null,
  supportEmail: null as string | null,
  supportAdminCanEdit: false,
};

async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, key));
  return row?.value ?? null;
}

async function setSetting(key: string, value: string, userId: string): Promise<void> {
  await db
    .insert(platformSettingsTable)
    .values({ key, value, updatedByUserId: userId })
    .onConflictDoUpdate({
      target: platformSettingsTable.key,
      set: { value, updatedAt: new Date(), updatedByUserId: userId },
    });
}

// GET /api/platform/settings — public, no auth required
router.get("/platform/settings", async (req, res): Promise<void> => {
  try {
    const [mmRow, msgRow, adsRow, waRow, emailRow, adminEditRow, charIdRow] = await Promise.all([
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "maintenance_mode")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "maintenance_message")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "ads_enabled")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_whatsapp")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_email")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_admin_can_edit")),
      db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "character_identity_enabled")),
    ]);

    res.json({
      maintenanceMode: mmRow[0]?.value === "true",
      maintenanceMessage: msgRow[0]?.value ?? DEFAULT_SETTINGS.maintenanceMessage,
      adsEnabled: adsRow[0]?.value === "true",
      updatedAt: mmRow[0]?.updatedAt?.toISOString() ?? null,
      supportWhatsapp: waRow[0]?.value ?? null,
      supportEmail: emailRow[0]?.value ?? null,
      supportAdminCanEdit: adminEditRow[0]?.value === "true",
      characterIdentityEnabled: charIdRow[0]?.value !== "false",
    });
  } catch (err) {
    req.log.error(err, "Failed to get platform settings");
    res.status(500).json({ error: "internal_error" });
  }
});

// PUT /api/admin/platform/settings — super_admin always; admin allowed if support_admin_can_edit is true (for support fields only)
router.put(
  "/admin/platform/settings",
  requireAuth,
  async (req, res): Promise<void> => {
    try {
      const role = req.user!.role;
      const isSuperAdmin = role === "super_admin";
      const isAdmin = role === "admin";

      if (!isSuperAdmin && !isAdmin) {
        res.status(403).json({ error: "forbidden" });
        return;
      }

      // Check if admin is allowed to edit support contact
      const [adminEditRow] = await db
        .select()
        .from(platformSettingsTable)
        .where(eq(platformSettingsTable.key, "support_admin_can_edit"));
      const adminCanEdit = adminEditRow?.value === "true";

      if (isAdmin && !adminCanEdit) {
        res.status(403).json({ error: "forbidden", message: "Super admin has not granted you permission to edit support contact." });
        return;
      }

      const { maintenanceMode, maintenanceMessage, adsEnabled, supportWhatsapp, supportEmail, supportAdminCanEdit, characterIdentityEnabled } = req.body as {
        maintenanceMode?: boolean;
        maintenanceMessage?: string;
        adsEnabled?: boolean;
        supportWhatsapp?: string | null;
        supportEmail?: string | null;
        supportAdminCanEdit?: boolean;
        characterIdentityEnabled?: boolean;
      };

      const userId = req.user!.userId;

      // Super admin can update all fields; admin can only update support contact
      if (isSuperAdmin) {
        if (maintenanceMode !== undefined) await setSetting("maintenance_mode", String(maintenanceMode), userId);
        if (maintenanceMessage !== undefined) await setSetting("maintenance_message", maintenanceMessage, userId);
        if (adsEnabled !== undefined) await setSetting("ads_enabled", String(adsEnabled), userId);
        if (supportAdminCanEdit !== undefined) await setSetting("support_admin_can_edit", String(supportAdminCanEdit), userId);
        if (characterIdentityEnabled !== undefined) await setSetting("character_identity_enabled", String(characterIdentityEnabled), userId);
      }

      // Both super_admin and permitted admin can update support contact
      if (supportWhatsapp !== undefined) await setSetting("support_whatsapp", supportWhatsapp ?? "", userId);
      if (supportEmail !== undefined) await setSetting("support_email", supportEmail ?? "", userId);

      const [mmRow, msgRow, adsRow, waRow, emailRow, adminEditRowUpdated, charIdRowUpdated] = await Promise.all([
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "maintenance_mode")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "maintenance_message")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "ads_enabled")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_whatsapp")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_email")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "support_admin_can_edit")),
        db.select().from(platformSettingsTable).where(eq(platformSettingsTable.key, "character_identity_enabled")),
      ]);

      res.json({
        maintenanceMode: mmRow[0]?.value === "true",
        maintenanceMessage: msgRow[0]?.value ?? DEFAULT_SETTINGS.maintenanceMessage,
        adsEnabled: adsRow[0]?.value === "true",
        updatedAt: mmRow[0]?.updatedAt?.toISOString() ?? null,
        supportWhatsapp: waRow[0]?.value || null,
        supportEmail: emailRow[0]?.value || null,
        supportAdminCanEdit: adminEditRowUpdated[0]?.value === "true",
        characterIdentityEnabled: charIdRowUpdated[0]?.value !== "false",
      });
    } catch (err) {
      req.log.error(err, "Failed to update platform settings");
      res.status(500).json({ error: "internal_error" });
    }
  }
);

export default router;
