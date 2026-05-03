import { GoogleGenAI } from "@google/genai";
import { logger } from "./logger";

const apiKey = process.env["GEMINI_API_KEY"];

if (!apiKey) {
  logger.warn("GEMINI_API_KEY is not set — AI script generation will be unavailable");
}

export const genai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export interface GeneratedScene {
  index: number;
  title: string;
  description: string;
  visualNotes: string;
}

export interface GeneratedScript {
  logline: string;
  scenes: GeneratedScene[];
}

export async function generateVideoScript(
  inputType: string,
  inputContent: string,
  style: string,
  durationSeconds: number,
  sceneCount: number
): Promise<GeneratedScript> {
  if (!genai) {
    return fallbackScript(sceneCount);
  }

  const styleDescriptions: Record<string, string> = {
    cinematic: "cinematic, film-quality, epic wide shots, dramatic lighting",
    documentary: "documentary-style, realistic, observational, natural lighting",
    dramatic: "high-drama, emotionally intense, dynamic camera work",
    action: "fast-paced, high-energy, explosive visuals, quick cuts",
    romantic: "soft, warm, intimate, golden hour lighting",
    horror: "dark, suspenseful, unsettling, shadows and tension",
    comedy: "bright, light-hearted, playful, comedic timing",
  };

  const styleDesc = styleDescriptions[style] ?? style;
  const approxSecondsPerScene = Math.round(durationSeconds / sceneCount);

  const prompt = `You are a professional Hollywood screenwriter and cinematographer.

A user wants a ${durationSeconds}-second ${style} video with ${sceneCount} scenes (~${approxSecondsPerScene}s each).

Input type: ${inputType}
Content: ${inputContent}

Visual style: ${styleDesc}

Write a structured screenplay as valid JSON with this exact shape:
{
  "logline": "<one-sentence summary of the video>",
  "scenes": [
    {
      "index": 1,
      "title": "<short scene title>",
      "description": "<2-3 sentence scene description with dialogue or narration if needed>",
      "visualNotes": "<cinematography direction: camera angle, movement, lighting, color palette>"
    }
  ]
}

Rules:
- Return ONLY the JSON object, no markdown, no extra text
- Generate exactly ${sceneCount} scenes
- Each scene should flow naturally into the next
- Visual notes should be vivid and specific to the ${style} style
- Titles should be evocative and cinematic`;

  try {
    const response = await genai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8192 },
    });

    const rawText = response.text ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in Gemini response");

    const parsed = JSON.parse(jsonMatch[0]) as GeneratedScript;
    if (!parsed.scenes || parsed.scenes.length === 0) throw new Error("Empty scenes array");

    logger.info({ sceneCount: parsed.scenes.length }, "Gemini: script generated");
    return parsed;
  } catch (err) {
    logger.error({ err }, "Gemini: script generation failed — using fallback");
    return fallbackScript(sceneCount);
  }
}

function fallbackScript(sceneCount: number): GeneratedScript {
  const scenes: GeneratedScene[] = Array.from({ length: sceneCount }, (_, i) => ({
    index: i + 1,
    title: `Scene ${i + 1}`,
    description: `Scene ${i + 1} of the video unfolds with carefully crafted visuals.`,
    visualNotes: "Wide establishing shot, natural lighting, smooth camera movement.",
  }));
  return {
    logline: "A cinematic journey unfolds across carefully crafted scenes.",
    scenes,
  };
}
