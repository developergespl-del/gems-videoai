import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "./logger";

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

const configuredRegion = stripQuotes(process.env["AWS_REGION"] ?? "us-east-1");
const bucket = stripQuotes(process.env["AWS_S3_BUCKET"] ?? "");
const accessKeyId = stripQuotes(process.env["AWS_ACCESS_KEY_ID"] ?? "");
const secretAccessKey = stripQuotes(process.env["AWS_SECRET_ACCESS_KEY"] ?? "");

function makeClient(region: string): S3Client | null {
  if (!accessKeyId || !secretAccessKey) return null;
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

export let s3 = makeClient(configuredRegion);
let activeRegion = configuredRegion;

// Extract the actual bucket region from a PermanentRedirect error endpoint
function extractRegionFromEndpoint(endpoint: string): string | null {
  // endpoint looks like: bucket.s3.eu-north-1.amazonaws.com
  const match = endpoint.match(/\.s3\.([a-z0-9-]+)\.amazonaws\.com/);
  return match ? match[1]! : null;
}

async function uploadWithRegionRetry(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  if (!s3 || !bucket) throw new Error("S3 not configured");
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    return `https://${bucket}.s3.${activeRegion}.amazonaws.com/${key}`;
  } catch (err: unknown) {
    // Auto-detect correct region from PermanentRedirect
    const errObj = err as Record<string, unknown>;
    if (errObj["name"] === "PermanentRedirect" || errObj["Code"] === "PermanentRedirect") {
      const endpoint = errObj["Endpoint"] as string | undefined;
      const detectedRegion = endpoint ? extractRegionFromEndpoint(endpoint) : null;
      if (detectedRegion && detectedRegion !== activeRegion) {
        logger.info({ from: activeRegion, to: detectedRegion }, "S3: auto-correcting region from redirect");
        activeRegion = detectedRegion;
        s3 = makeClient(detectedRegion);
        // Retry once with correct region
        await s3!.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
        return `https://${bucket}.s3.${activeRegion}.amazonaws.com/${key}`;
      }
    }
    throw err;
  }
}

export async function uploadVideoToS3(
  videoId: string,
  body: Buffer | Uint8Array,
  contentType = "video/mp4"
): Promise<string | null> {
  if (!s3 || !bucket) {
    logger.warn({ videoId }, "S3: not configured — skipping upload");
    return null;
  }
  const key = `videos/${videoId}/output.mp4`;
  try {
    const url = await uploadWithRegionRetry(key, body, contentType);
    logger.info({ videoId, url }, "S3: uploaded video");
    return url;
  } catch (err) {
    logger.error({ err, videoId }, "S3: upload failed");
    return null;
  }
}

export async function uploadThumbnailToS3(
  videoId: string,
  body: Buffer | Uint8Array,
  contentType = "image/jpeg"
): Promise<string | null> {
  if (!s3 || !bucket) return null;
  const key = `videos/${videoId}/thumbnail.jpg`;
  try {
    const url = await uploadWithRegionRetry(key, body, contentType);
    logger.info({ videoId, url }, "S3: uploaded thumbnail");
    return url;
  } catch (err) {
    logger.error({ err, videoId }, "S3: thumbnail upload failed");
    return null;
  }
}

export async function uploadCharacterFaceToS3(
  characterId: string,
  angle: "front" | "left" | "right" | "back",
  body: Buffer | Uint8Array,
  contentType = "image/jpeg"
): Promise<string | null> {
  if (!s3 || !bucket) return null;
  const ext = contentType.includes("png") ? "png" : "jpg";
  const key = `characters/${characterId}/faces/${angle}.${ext}`;
  try {
    const url = await uploadWithRegionRetry(key, body, contentType);
    logger.info({ characterId, angle, url }, "S3: uploaded character face");
    return url;
  } catch (err) {
    logger.error({ err, characterId, angle }, "S3: face upload failed");
    return null;
  }
}

export async function uploadVoiceSampleToS3(
  characterId: string,
  body: Buffer | Uint8Array,
  contentType = "audio/webm"
): Promise<string | null> {
  if (!s3 || !bucket) return null;
  const ext = contentType.includes("mp3") ? "mp3" : contentType.includes("wav") ? "wav" : "webm";
  const key = `characters/${characterId}/voice-sample.${ext}`;
  try {
    const url = await uploadWithRegionRetry(key, body, contentType);
    logger.info({ characterId, url }, "S3: uploaded voice sample");
    return url;
  } catch (err) {
    logger.error({ err, characterId }, "S3: voice sample upload failed");
    return null;
  }
}

export async function getSignedVideoUrl(videoId: string, expiresIn = 3600): Promise<string | null> {
  if (!s3 || !bucket) return null;
  const key = `videos/${videoId}/output.mp4`;
  try {
    return await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn }
    );
  } catch (err) {
    logger.error({ err, videoId }, "S3: presign failed");
    return null;
  }
}
