import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

export type SoundIntensity = "low" | "medium" | "high";
export type SoundDecisionKind = "kept" | "replaced" | "added";

export interface DetectedSoundCue {
  originalPrompt: string | null;
  detectedCategory: string | null;
  sceneIndex: number;
  sceneEmotion: string | null;
  sceneEnvironment: string | null;
  sceneIntensity: SoundIntensity | null;
  decision: SoundDecisionKind;
  reason: string;
  suggestedDescription: string | null;
  suggestedCategory: string | null;
  suggestedTags: string[];
  suggestedEmotions: string[];
  suggestedEnvironments: string[];
  suggestedIntensity: SoundIntensity | null;
  confidence: number;
}

export interface ScriptSoundAnalysis {
  totalDetected: number;
  totalKept: number;
  totalReplaced: number;
  totalAdded: number;
  summary: string;
  decisions: DetectedSoundCue[];
}

const SYSTEM_PROMPT = `You are a senior cinematic sound designer and Foley director for an AI video generation studio.

You will receive a SHORT-FORM SCRIPT (story or screenplay) from a user. Your job:

1. DETECT every sound prompt the user explicitly wrote (e.g. "thunder sound", "door creak", "sad violin music", "sfx: gunshot", parenthesised cues, etc.). Many scripts also imply sounds without writing them — IGNORE those for the "detected" set; you'll handle implied/missing sounds in step 4.

2. ANALYSE each detected sound against its scene CONTEXT:
   - emotion (e.g. tense, melancholic, joyful, fearful, romantic, triumphant)
   - environment (e.g. indoor, outdoor, forest, urban, village, horror, futuristic)
   - intensity (low / medium / high)
   - timing/placement

3. DECIDE for each detected sound:
   - decision: "kept"     → user's prompt is a perfect cinematic match
   - decision: "replaced" → user's prompt is weak, generic, low-quality, or wrong tone; suggest a BETTER cinematic, copyright-free alternative

4. ADD missing ambient or layered sounds where it would meaningfully improve realism. Examples: a forest scene without bird/wind ambience, a chase without footsteps + heartbeat, a horror reveal without low rumble. Use decision: "added" for these. Be tasteful — never over-noise. Aim for 0-3 ambient additions per scene, only when they clearly improve the film.

For every entry, return:
- originalPrompt: exact user text if "kept" or "replaced", null if "added"
- detectedCategory: a short category slug (e.g. "thunder", "footsteps", "music_score", "ambient_wind", "door_creak", "violin_sad")
- sceneIndex: 0-based index of the scene the sound belongs to (split scenes by paragraph or "Scene N:" markers; if unclear, use 0)
- sceneEmotion: short string
- sceneEnvironment: short string
- sceneIntensity: "low" | "medium" | "high"
- decision: one of "kept" | "replaced" | "added"
- reason: 1-sentence explanation of why kept/replaced/added
- suggestedDescription: ONLY for "replaced" or "added" — a vivid 1-sentence description of the better cinematic sound (e.g. "Layered cinematic thunder with deep sub-rumble and distant rolling tail")
- suggestedCategory: ONLY for "replaced" or "added" — short category slug to help match library
- suggestedTags / suggestedEmotions / suggestedEnvironments: keyword arrays for matching
- suggestedIntensity: "low" | "medium" | "high"
- confidence: 0-100 — your confidence in the decision

STRICT RULES:
- No mismatched, low-quality, or generic audio.
- Every replacement must be cinematic and copyright-free (assume the library is curated CC0/royalty-free; just describe what's needed).
- Maintain natural balance — never recommend more than 3 added sounds per scene.

ALSO return a short overall "summary" (1-2 sentences) describing the sound design intent.

Return STRICT JSON:
{
  "summary": string,
  "decisions": [
    {
      "originalPrompt": string|null,
      "detectedCategory": string|null,
      "sceneIndex": integer,
      "sceneEmotion": string|null,
      "sceneEnvironment": string|null,
      "sceneIntensity": "low"|"medium"|"high"|null,
      "decision": "kept"|"replaced"|"added",
      "reason": string,
      "suggestedDescription": string|null,
      "suggestedCategory": string|null,
      "suggestedTags": string[],
      "suggestedEmotions": string[],
      "suggestedEnvironments": string[],
      "suggestedIntensity": "low"|"medium"|"high"|null,
      "confidence": integer
    }
  ]
}`;

const VALID_INTENSITIES = ["low", "medium", "high"] as const;
const VALID_DECISIONS = ["kept", "replaced", "added"] as const;

function pickIntensity(v: unknown): SoundIntensity | null {
  return typeof v === "string" && (VALID_INTENSITIES as readonly string[]).includes(v)
    ? (v as SoundIntensity)
    : null;
}

function pickDecision(v: unknown): SoundDecisionKind | null {
  return typeof v === "string" && (VALID_DECISIONS as readonly string[]).includes(v)
    ? (v as SoundDecisionKind)
    : null;
}

function pickStringArray(v: unknown, max = 12): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim().length > 0 && item.length <= 100) {
      out.push(item.trim().toLowerCase());
    }
    if (out.length >= max) break;
  }
  return out;
}

function pickString(v: unknown, max = 500): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.slice(0, max);
}

function pickInt(v: unknown, def = 0, min = 0, max = 1_000_000): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function analyzeScriptSounds(scriptText: string): Promise<ScriptSoundAnalysis> {
  const trimmed = scriptText.trim();
  if (trimmed.length === 0) {
    return { totalDetected: 0, totalKept: 0, totalReplaced: 0, totalAdded: 0, summary: "Empty script.", decisions: [] };
  }

  const userPrompt = `SCRIPT:\n\n${trimmed.slice(0, 12000)}\n\nDetect every explicit sound cue, validate it against scene context, and decide kept/replaced/added per the system instructions. Return strict JSON only.`;

  let parsed: { summary?: unknown; decisions?: unknown };

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fail closed — never silently emit empty/generic results.
    logger.warn({ err: String(err) }, "Sound Design Engine: AI analysis failed");
    throw new Error("AI sound analysis is currently unavailable. Please try again in a moment.");
  }

  const decisionsRaw = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const decisions: DetectedSoundCue[] = [];

  for (const d of decisionsRaw) {
    if (typeof d !== "object" || d === null) continue;
    const rec = d as Record<string, unknown>;
    const decision = pickDecision(rec.decision);
    if (!decision) continue;

    const reason = pickString(rec.reason, 500) ?? "Auto-classified by AI sound designer.";
    const cue: DetectedSoundCue = {
      originalPrompt: pickString(rec.originalPrompt, 500),
      detectedCategory: pickString(rec.detectedCategory, 100),
      sceneIndex: pickInt(rec.sceneIndex, 0, 0, 1000),
      sceneEmotion: pickString(rec.sceneEmotion, 100),
      sceneEnvironment: pickString(rec.sceneEnvironment, 100),
      sceneIntensity: pickIntensity(rec.sceneIntensity),
      decision,
      reason,
      suggestedDescription: pickString(rec.suggestedDescription, 500),
      suggestedCategory: pickString(rec.suggestedCategory, 100),
      suggestedTags: pickStringArray(rec.suggestedTags),
      suggestedEmotions: pickStringArray(rec.suggestedEmotions),
      suggestedEnvironments: pickStringArray(rec.suggestedEnvironments),
      suggestedIntensity: pickIntensity(rec.suggestedIntensity),
      confidence: pickInt(rec.confidence, 80, 0, 100),
    };
    decisions.push(cue);
    if (decisions.length >= 60) break;
  }

  let kept = 0, replaced = 0, added = 0;
  for (const d of decisions) {
    if (d.decision === "kept") kept++;
    else if (d.decision === "replaced") replaced++;
    else if (d.decision === "added") added++;
  }

  return {
    totalDetected: kept + replaced,
    totalKept: kept,
    totalReplaced: replaced,
    totalAdded: added,
    summary: pickString(parsed.summary, 1000) ?? "Sound design analysis complete.",
    decisions,
  };
}

// Score a library entry against a cue's suggested category/tags/emotions/environments/intensity.
// Returns 0..100. Higher = better match.
export interface MatchableSound {
  id: string;
  category: string;
  tags: string[];
  emotions: string[];
  environments: string[];
  intensity: SoundIntensity;
  isActive: boolean;
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a.map((x) => x.toLowerCase()));
  let n = 0;
  for (const x of b) if (set.has(x.toLowerCase())) n++;
  return n;
}

function categoryTokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

export function scoreLibraryMatch(
  cue: Pick<DetectedSoundCue, "suggestedCategory" | "suggestedTags" | "suggestedEmotions" | "suggestedEnvironments" | "suggestedIntensity"> & { detectedCategory?: string | null },
  sound: MatchableSound,
): number {
  if (!sound.isActive) return -1;
  let score = 0;
  let categoryMatched = false;
  const sCat = sound.category.toLowerCase();
  const effectiveCategory = cue.suggestedCategory ?? cue.detectedCategory ?? null;
  if (effectiveCategory) {
    const cCat = effectiveCategory.toLowerCase();
    if (sCat === cCat) {
      score += 60;
      categoryMatched = true;
    } else if (sCat.includes(cCat) || cCat.includes(sCat)) {
      score += 35;
      categoryMatched = true;
    } else {
      // Token overlap: e.g. cue "footsteps_run" vs library "footsteps"
      const sTok = new Set(categoryTokens(sound.category));
      const cTok = categoryTokens(effectiveCategory);
      let hits = 0;
      for (const t of cTok) if (sTok.has(t)) hits++;
      if (hits > 0) {
        score += 20 + hits * 5;
        categoryMatched = true;
      }
    }
  }
  // Tag match counts toward category if no slug match (e.g. AI tag "footsteps" vs library category "footsteps")
  if (!categoryMatched && cue.suggestedTags.length > 0) {
    if (cue.suggestedTags.includes(sCat)) {
      score += 30;
      categoryMatched = true;
    }
  }
  score += overlap(cue.suggestedTags, sound.tags) * 8;
  score += overlap(cue.suggestedEmotions, sound.emotions) * 6;
  score += overlap(cue.suggestedEnvironments, sound.environments) * 6;
  if (cue.suggestedIntensity && cue.suggestedIntensity === sound.intensity) score += 10;
  // Strict rule: never return mismatched audio. If no category-level alignment, suppress score.
  if (!categoryMatched) return 0;
  return score;
}

// Minimum acceptable score for a library match. Below this the cue stays
// description-only (AI suggestion shown to user) — better than mismatched audio.
export const MIN_LIBRARY_MATCH_SCORE = 40;
