import Redis from "ioredis";
import { logger } from "./logger";

export const redis = new Redis({
  host: process.env["REDIS_HOST"] ?? "127.0.0.1",
  port: parseInt(process.env["REDIS_PORT"] ?? "6379", 10),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on("connect", () => logger.info("Redis connected"));
redis.on("ready", () => logger.info("Redis ready"));
redis.on("error", (err) => logger.warn({ err: err.message }, "Redis error"));

export async function connectRedis(): Promise<void> {
  try {
    await redis.connect();
  } catch (err) {
    logger.warn({ err }, "Redis unavailable — queue features disabled");
  }
}

export async function enqueueVideo(videoId: string): Promise<void> {
  try {
    await redis.lpush("video_queue", videoId);
    logger.info({ videoId }, "Enqueued video job");
  } catch (err) {
    logger.warn({ err, videoId }, "Failed to enqueue video — Redis may be down");
  }
}
