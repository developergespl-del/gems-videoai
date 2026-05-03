/**
 * Upstash Redis — REST API via fetch (no SDK to avoid drizzle-orm duplicate conflict).
 *
 * The UPSTASH_REDIS_URL must be the full REST URL:
 *   https://<name>.upstash.io  (Upstash provides this in their dashboard)
 */
import { logger } from "./logger";

// Strip any surrounding quotes that may have been included when saving the secret
function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

const rawUrl = stripQuotes(process.env["UPSTASH_REDIS_URL"] ?? "");
const token = stripQuotes(process.env["UPSTASH_REDIS_TOKEN"] ?? "");

function normalizeUpstashUrl(u: string): string {
  u = u.trim().replace(/\/$/, "");
  if (u && !u.startsWith("http://") && !u.startsWith("https://")) {
    u = `https://${u}`;
  }
  return u;
}

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

const url = normalizeUpstashUrl(rawUrl);
export const upstashConfigured = isValidUrl(url) && token.length > 0;

if (upstashConfigured) {
  logger.info({ url }, "Upstash Redis configured");
} else {
  logger.warn({ rawUrl }, "Upstash Redis not configured or invalid URL — using local Redis only");
}

async function upstashCommand(command: unknown[]): Promise<unknown> {
  if (!upstashConfigured) throw new Error("Upstash not configured");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Upstash HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result: unknown; error?: string };
  if (json.error) throw new Error(`Upstash error: ${json.error}`);
  return json.result;
}

export async function enqueueVideoUpstash(videoId: string): Promise<boolean> {
  if (!upstashConfigured) return false;
  try {
    await upstashCommand(["LPUSH", "video_queue", videoId]);
    logger.info({ videoId }, "Upstash: enqueued video job");
    return true;
  } catch (err) {
    logger.warn({ err, videoId }, "Upstash: enqueue failed — will fall back to local Redis");
    return false;
  }
}

export async function popJobUpstash(timeoutSec: number): Promise<string | null> {
  if (!upstashConfigured) return null;
  try {
    const result = await upstashCommand(["BLPOP", "video_queue", timeoutSec]);
    if (!result) return null;
    const arr = result as string[];
    return arr[1] ?? null;
  } catch (err) {
    logger.warn({ err }, "Upstash: BLPOP failed — will fall back to local Redis");
    return null;
  }
}
