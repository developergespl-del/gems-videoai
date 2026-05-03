import { createClient } from "@supabase/supabase-js";
import { logger } from "./logger";

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

const url = stripQuotes(process.env["SUPABASE_URL"] ?? "");
const serviceRoleKey = stripQuotes(process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "");

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return s.startsWith("http://") || s.startsWith("https://");
  } catch {
    return false;
  }
}

const configured = isValidUrl(url) && serviceRoleKey.length > 0;

export const supabase = configured
  ? createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

if (!configured) {
  logger.warn("Supabase not configured or invalid URL — real-time broadcasts disabled");
}

export async function broadcastVideoProgress(
  videoId: string,
  payload: {
    status: string;
    progress: number;
    generationStage: string;
    scenesCompleted?: number;
    outputUrl?: string | null;
    description?: string | null;
  }
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.channel(`video:${videoId}`).send({
      type: "broadcast",
      event: "progress",
      payload: { videoId, ...payload },
    });
  } catch (err) {
    logger.warn({ err, videoId }, "Supabase: broadcast failed (non-fatal)");
  }
}
