import { openai, generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ============================================================
// Types
// ============================================================

export type AssetType = "trailer" | "poster" | "thumbnail";

export interface VideoContext {
  id: string;
  title: string;
  description?: string | null;
  inputContent: string;
  style: string;
  durationSeconds: number;
  language: string;
}

export interface TrailerScene {
  sceneNumber: number;
  description: string;
  duration: string;
  musicCue: string;
  textHook: string | null;
  transition: string;
}

export interface TrailerContent {
  hook: string;
  totalDuration: string;
  scenes: TrailerScene[];
  closingTagline: string;
  musicBed: string;
  callToAction: string | null;
}

// ============================================================
// Asset planning (determine what to generate per video length)
// ============================================================

export function planAssets(durationSeconds: number): AssetType[] {
  const hours = durationSeconds / 3600;
  if (hours >= 1) {
    return ["trailer", "poster", "thumbnail"];
  }
  return ["thumbnail"];
}

// ============================================================
// Trailer script / storyboard generation
// ============================================================

const TRAILER_SYSTEM_PROMPT = `You are a world-class film trailer editor and marketing creative director.
Given a video's story/script content, generate a 1–2 minute cinematic trailer breakdown.

Requirements:
- Extract the 6–10 best, most high-impact moments from the story.
- NEVER spoil the full ending or final reveal.
- Maintain mystery and emotional curiosity.
- Add cinematic transitions (smash cut, cross dissolve, whip pan, etc.).
- Recommend a copyright-free music bed for the whole trailer (describe genre/mood, not a specific track title).
- Include 2–4 dramatic text hooks placed at peak emotional moments.
- The hook, tagline, and text elements MUST be in the requested language. Do NOT translate into English if another language is specified.

Return STRICT JSON:
{
  "hook": "Opening dramatic hook line (1–2 words or short phrase, in target language)",
  "totalDuration": "1:30",
  "scenes": [
    {
      "sceneNumber": 1,
      "description": "What is shown — a vivid shot description",
      "duration": "0:08",
      "musicCue": "Build tension — sparse piano, low strings",
      "textHook": "The line shown on screen, or null",
      "transition": "smash cut"
    }
  ],
  "closingTagline": "Final screen text in target language",
  "musicBed": "Full music description for the entire trailer",
  "callToAction": "Watch now / Subscribe etc, in target language, or null"
}`;

export async function generateTrailerContent(video: VideoContext): Promise<TrailerContent> {
  const prompt = `TITLE: ${video.title}
STYLE: ${video.style}
DURATION: ${Math.round(video.durationSeconds / 60)} minutes
LANGUAGE: ${video.language}

STORY/SCRIPT (excerpt, max 8000 chars):
${video.inputContent.slice(0, 8000)}

Generate a 1–2 minute cinematic trailer breakdown in strict JSON. All text hooks, taglines, and CTAs must be in language: ${video.language}.`;

  let parsed: { scenes?: unknown; hook?: unknown; totalDuration?: unknown; closingTagline?: unknown; musicBed?: unknown; callToAction?: unknown };
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 3000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: TRAILER_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
  } catch (err) {
    logger.warn({ err: String(err) }, "marketing-assets: trailer generation failed");
    throw new Error("Trailer generation is temporarily unavailable. Please try again.");
  }

  const scenesRaw = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: TrailerScene[] = scenesRaw.slice(0, 12).map((s: any, i: number) => ({
    sceneNumber: typeof s.sceneNumber === "number" ? s.sceneNumber : i + 1,
    description: typeof s.description === "string" ? s.description.slice(0, 500) : "",
    duration: typeof s.duration === "string" ? s.duration.slice(0, 20) : "0:08",
    musicCue: typeof s.musicCue === "string" ? s.musicCue.slice(0, 200) : "",
    textHook: typeof s.textHook === "string" ? s.textHook.slice(0, 200) : null,
    transition: typeof s.transition === "string" ? s.transition.slice(0, 50) : "cut",
  }));

  return {
    hook: typeof parsed.hook === "string" ? parsed.hook.slice(0, 200) : video.title,
    totalDuration: typeof parsed.totalDuration === "string" ? parsed.totalDuration.slice(0, 20) : "1:30",
    scenes,
    closingTagline: typeof parsed.closingTagline === "string" ? parsed.closingTagline.slice(0, 300) : "",
    musicBed: typeof parsed.musicBed === "string" ? parsed.musicBed.slice(0, 500) : "Cinematic orchestral build",
    callToAction: typeof parsed.callToAction === "string" ? parsed.callToAction.slice(0, 200) : null,
  };
}

// ============================================================
// Poster image generation
// ============================================================

async function buildPosterPrompt(video: VideoContext): Promise<string> {
  const styleDescriptions: Record<string, string> = {
    cinematic: "ultra-cinematic, wide-lens, anamorphic flare, golden hour or blue hour lighting",
    documentary: "photojournalistic, natural lighting, raw authentic composition",
    dramatic: "high contrast noir, deep shadows, intense emotional close-up",
    action: "explosive energy, motion blur, high saturation, dynamic angle",
    romantic: "warm bokeh, soft golden light, intimate composition",
    horror: "dark, oppressive, shadow-drenched, unsettling atmosphere",
    comedy: "vibrant, saturated, playful composition, warm tones",
  };
  const styleHint = styleDescriptions[video.style] ?? "professional cinematic";

  const aiPrompt = `Create a vivid film poster visual prompt for this video:
Title: ${video.title}
Style: ${video.style}
Story summary (first 600 chars): ${video.inputContent.slice(0, 600)}

Reply with ONE sentence (max 300 chars): a vivid DALL-E image prompt for a ${styleHint} film poster featuring the main character/subject, cinematic lighting, moody atmosphere, professional movie poster composition. No text overlays.`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 200,
      messages: [{ role: "user", content: aiPrompt }],
    });
    return (res.choices[0]?.message?.content ?? "").trim().slice(0, 300) || `${styleHint} film poster, dramatic lighting, cinematic composition, ${video.title}`;
  } catch {
    return `${styleHint} film poster, dramatic lighting, cinematic composition, professional movie poster, dark atmosphere, no text`;
  }
}

export async function generatePosterImageBuffer(video: VideoContext): Promise<{ buffer: Buffer; prompt: string }> {
  const prompt = await buildPosterPrompt(video);
  logger.info({ prompt }, "marketing-assets: generating poster");
  const buffer = await generateImageBuffer(
    `Film poster: ${prompt}. Professional movie poster composition, cinematic lighting, no watermarks, no text, photorealistic.`,
    "1024x1024",
  );
  return { buffer, prompt };
}

// ============================================================
// Thumbnail image generation
// ============================================================

async function buildThumbnailPrompt(video: VideoContext): Promise<string> {
  const styleEmotions: Record<string, string> = {
    horror: "shock and fear expression, terrified face, dark sinister setting",
    action: "explosive action, intense hero face, dramatic motion",
    dramatic: "emotional close-up, tear or intense stare, tension",
    romantic: "tender moment, longing gaze, warm lighting",
    cinematic: "compelling character close-up, dramatic lighting, curious expression",
    documentary: "real raw emotion, authentic moment, striking face",
    comedy: "exaggerated surprised or joyful expression, bright colors",
  };
  const emotionHint = styleEmotions[video.style] ?? "compelling emotional expression, curiosity, high contrast";

  const aiPrompt = `Create a YouTube thumbnail visual for this video:
Title: ${video.title}
Style: ${video.style}
Story (first 300 chars): ${video.inputContent.slice(0, 300)}

Reply with ONE sentence (max 250 chars): a vivid DALL-E image prompt for a high-clickbait professional YouTube thumbnail showing ${emotionHint}. Mobile-friendly, clean layout, no text.`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 150,
      messages: [{ role: "user", content: aiPrompt }],
    });
    return (res.choices[0]?.message?.content ?? "").trim().slice(0, 250) || `${emotionHint}, YouTube thumbnail, 16:9, high saturation, dramatic close-up`;
  } catch {
    return `${emotionHint}, YouTube thumbnail, high clickthrough design, dramatic lighting, clean professional composition`;
  }
}

export async function generateThumbnailImageBuffer(video: VideoContext): Promise<{ buffer: Buffer; prompt: string }> {
  const prompt = await buildThumbnailPrompt(video);
  logger.info({ prompt }, "marketing-assets: generating thumbnail");
  const buffer = await generateImageBuffer(
    `YouTube thumbnail: ${prompt}. High-contrast, visually striking, mobile-friendly, no text, no watermarks, photorealistic.`,
    "1024x1024",
  );
  return { buffer, prompt };
}
