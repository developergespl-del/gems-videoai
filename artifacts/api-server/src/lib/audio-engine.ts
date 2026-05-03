/**
 * GEMS Audio + Realism Engine
 *
 * Generates a comprehensive cinematic audio specification and realism directive
 * for a video based on its story analysis and screenplay.
 *
 * Audio System:
 *   - Emotion-based voice profiles (age, tone, modulation, breathing, pauses)
 *   - Scene-by-scene emotion-audio timeline
 *   - Copyright-free background music specification
 *
 * Realism System:
 *   - Zero-artifact enforcement rules
 *   - Micro-expression and FACS muscle directives
 *   - Natural lighting, skin texture, movement physics
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface EmotionBeat {
  sceneNumber: number;
  emotion: string;
  intensity: number;           // 0.0–1.0
  colorTemperature: string;    // e.g. "3200K warm"
  audioMood: string;
  description: string;
}

export interface VoiceProfile {
  character: string;
  age: number;
  gender: string;
  language: string;
  baseVoiceTone: string;
  breathingPattern: string;
  speakingPace: string;
  naturalPauses: string[];
  emotionModulation: Record<string, string>;  // emotion → voice instruction
  ageVoiceEffect: string;
  copyrightNote: string;
}

export interface MusicSceneMap {
  sceneNumber: number;
  trackMood: string;
  volumeDynamics: string;
  instrument: string;
}

export interface BackgroundMusic {
  primaryGenre: string;
  mood: string;
  bpm: number;
  musicalKey: string;
  instruments: string[];
  dynamicRange: string;
  licenseType: string;
  referenceStyle: string;
  sceneMapping: MusicSceneMap[];
  noList: string[];             // sounds/styles explicitly excluded
}

export interface AudioProfile {
  emotionTimeline: EmotionBeat[];
  voiceProfiles: VoiceProfile[];
  backgroundMusic: BackgroundMusic;
  mixingDirections: string;
  silenceUsage: string;
  audioMasteringNote: string;
}

export interface ArtifactPrevention {
  morphingZeroTolerance: boolean;
  handRendering: string;
  eyeRealism: string;
  teethVisibility: string;
  hairPhysics: string;
  earLobeAndNeckDetail: string;
}

export interface FacialExpressionSystem {
  microExpressionCapture: string;
  emotionBlending: string;
  muscleTension: string;
  skinDeformation: string;
  eyeContactBehavior: string;
  blinkRate: string;
}

export interface LightingSpec {
  type: string;
  colorTemperature: string;
  shadowSoftness: string;
  practicalLights: string;
  goldenHourUsage: string;
  avoidList: string[];
  skintoneRendering: string;
}

export interface MovementRealism {
  bodyWeight: string;
  breathingVisible: string;
  cameraMotion: string;
  clothingPhysics: string;
  microTremorsAndFidget: string;
}

export interface RealismProfile {
  artifactPrevention: ArtifactPrevention;
  facialExpressions: FacialExpressionSystem;
  lighting: LightingSpec;
  movementRealism: MovementRealism;
  skinTextureDetail: string;
  environmentalism: string;     // background authenticity
  humanTruthStatement: string;
}

export interface AudioRealismOutput {
  audioProfile: AudioProfile;
  realismProfile: RealismProfile;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const AUDIO_SYSTEM_PROMPT = `You are GEMS Audio-Realism Director — a world-class cinematic audio and visual realism designer with 25 years of experience in Indian cinema, Hollywood productions, and AI video generation.

Your task: given a story analysis and screenplay, output a COMPLETE audio + realism specification in valid JSON.

AUDIO DESIGN PRINCIPLES:
- Every voice profile MUST be age-accurate (a 60-year-old sounds different from a 28-year-old)
- Emotional modulation is non-negotiable — grief slows pace, widens vowels, softens consonants
- Natural breathing patterns: pauses mid-sentence, audible intake before emotional lines
- All music must be 100% copyright-free / royalty-free
- Use silence as a cinematic tool — it is as powerful as sound
- Background music must never overpower dialogue

VOICE SCIENCE:
- Children (6-12): higher fundamental frequency 250-400Hz, breathier quality
- Teens (13-19): voice breaks, inconsistent register
- Young adults (20-35): full resonance, clear articulation
- Middle-aged (36-55): richer timbre, slightly slower cadence
- Elderly (60+): lighter breath support, slight tremolo, slower articulation, potential voice raspiness

EMOTION-VOICE MAPPING:
- Grief: slower pace, soft volume, slight vocal fry, longer pauses, avoid sharp consonants
- Fear: faster pace, higher pitch, shallow breathing, short sentences
- Anger: louder, clipped consonants, forward placement, harder vowels
- Joy: brighter timbre, faster pace, rising inflection
- Determination: steady pace, lower register, measured breath, firm consonants
- Nostalgia: slower, warmer, breathy quality, trailing off on sentences

REALISM RULES (ZERO TOLERANCE):
1. No morphing faces — every frame must look like a real human
2. Hands must have exactly 5 properly jointed fingers
3. Eyes must have natural saccades (quick involuntary movements), corneal reflections, and ~15 blinks/minute
4. Skin must show pores, subtle imperfections — no plastic smoothing
5. Hair must react to gravity, wind, and movement
6. Clothing must have fabric physics (gravity, wrinkle, fold)
7. Body must show weight shift, inertia, natural micro-tremors
8. Breathing must be visible on chest/shoulders at all times
9. Lighting must have no flat areas — always some natural gradient
10. Indian skin tones must be rendered with accurate melanin depth

OUTPUT FORMAT (strict JSON):
{
  "audioProfile": {
    "emotionTimeline": [...],
    "voiceProfiles": [...],
    "backgroundMusic": {...},
    "mixingDirections": "...",
    "silenceUsage": "...",
    "audioMasteringNote": "..."
  },
  "realismProfile": {
    "artifactPrevention": {...},
    "facialExpressions": {...},
    "lighting": {...},
    "movementRealism": {...},
    "skinTextureDetail": "...",
    "environmentalism": "...",
    "humanTruthStatement": "..."
  }
}`;

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

interface AudioEngineInput {
  title: string;
  inputContent: string;
  style: string;
  durationSeconds: number;
  analysis: {
    contextAnalysis?: unknown;
    emotionalProfile?: unknown;
    characterProfiles?: unknown;
    culturalContext?: unknown;
    primaryEmotion?: string;
    regionLanguage?: string;
    narrativeTone?: string;
  };
  screenplay?: unknown;
}

export async function generateAudioRealismProfile(
  input: AudioEngineInput
): Promise<AudioRealismOutput> {
  const { title, inputContent, style, durationSeconds, analysis, screenplay } = input;

  const userPrompt = `VIDEO: "${title}"
Style: ${style} | Duration: ${durationSeconds}s

STORY:
${inputContent.slice(0, 1200)}

ANALYSIS SUMMARY:
Primary Emotion: ${analysis.primaryEmotion || "not specified"}
Region/Language: ${analysis.regionLanguage || "not specified"}
Narrative Tone: ${analysis.narrativeTone || "not specified"}
Emotional Profile: ${JSON.stringify(analysis.emotionalProfile || {}, null, 0).slice(0, 800)}
Character Profiles: ${JSON.stringify(analysis.characterProfiles || [], null, 0).slice(0, 1200)}
Cultural Context: ${JSON.stringify(analysis.culturalContext || {}, null, 0).slice(0, 600)}
${screenplay ? `\nSCREENPLAY EXCERPT:\n${JSON.stringify(screenplay, null, 0).slice(0, 2000)}` : ""}

Generate the complete audio + realism specification for this cinematic video.
Include SPECIFIC voice profiles for each identified character.
Music must be copyright-free and culturally appropriate.
Realism rules must address this story's specific visual challenges.`;

  logger.info({ title }, "Audio Engine: starting generation");

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 5000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: AUDIO_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  let parsed: AudioRealismOutput;
  try {
    parsed = JSON.parse(raw) as AudioRealismOutput;
  } catch {
    logger.error({ raw: raw.slice(0, 200) }, "Audio Engine: JSON parse failed");
    throw new Error("Audio Engine returned invalid JSON");
  }

  if (!parsed.audioProfile || !parsed.realismProfile) {
    throw new Error("Audio Engine response missing required fields");
  }

  logger.info({ title }, "Audio Engine: generation complete");
  return parsed;
}
