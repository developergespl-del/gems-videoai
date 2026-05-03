/**
 * GEMS Paranormal, Supernatural & Superpower Film Engine
 *
 * Analyzes any script/story for horror, paranormal, supernatural, and
 * superhero elements and produces a structured production profile covering:
 *
 *   - Content-type classification (horror / paranormal / supernatural /
 *     superpower / superhero)
 *   - Character ability profiles (powers, evolution arc, VFX keywords)
 *   - Per-scene VFX requirements with technique + color-grading notes
 *   - Atmosphere profile (lighting, color palette, sound design, environment)
 *   - Physics rules for fictional elements (no cartoon/glitch feel)
 *   - Style directives (cinematic style, camera rules, hero moments)
 *   - Cultural blend (Indian tantrik / haveli / mythology + global Hollywood)
 *   - Strict realism directives
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types (mirrored from DB schema types for convenience)
// ---------------------------------------------------------------------------

export interface CharacterAbility {
  characterName: string;
  abilityType: string;
  powerLevel: "dormant" | "weak" | "medium" | "strong" | "god-tier";
  evolutionArc: string;
  vfxKeywords: string[];
  physicsNotes: string;
}

export interface VfxRequirement {
  elementType: string;
  technique: string;
  colorGrading: string;
  referenceMood: string;
  avoidList: string[];
}

export interface AtmosphereProfile {
  lighting: string;
  colorPalette: string[];
  soundDesign: string;
  environmentNotes: string;
}

export interface PhysicsRule {
  element: string;
  rule: string;
  avoidList: string[];
}

export interface StyleDirectives {
  cinematicStyle: string;
  cameraRules: string;
  paceNotes: string;
  heroMoments: string[];
  signatureShots: string[];
}

export interface CulturalBlend {
  indianElements: string[];
  globalInfluences: string[];
  languageNotes: string;
}

export interface SceneVfxEntry {
  sceneIndex: number;
  vfxElements: string[];
  atmosphereIntensity: "none" | "low" | "medium" | "high" | "extreme";
  powerActivations: string[];
  directorNote: string;
}

export interface ParanormalProfile {
  hasParanormalElements: "yes" | "no" | "partial";
  contentTypes: string[];
  characterAbilities: CharacterAbility[];
  vfxRequirements: VfxRequirement[];
  atmosphereProfile: AtmosphereProfile;
  physicsRules: PhysicsRule[];
  styleDirectives: StyleDirectives;
  culturalBlend: CulturalBlend;
  realismDirectives: string;
  sceneVfxMap: SceneVfxEntry[];
}

// ---------------------------------------------------------------------------
// JSON schema for strict output
// ---------------------------------------------------------------------------

const RESPONSE_SCHEMA = {
  type: "object",
  required: [
    "hasParanormalElements",
    "contentTypes",
    "characterAbilities",
    "vfxRequirements",
    "atmosphereProfile",
    "physicsRules",
    "styleDirectives",
    "culturalBlend",
    "realismDirectives",
    "sceneVfxMap",
  ],
  additionalProperties: false,
  properties: {
    hasParanormalElements: { type: "string", enum: ["yes", "no", "partial"] },
    contentTypes: { type: "array", items: { type: "string" } },
    characterAbilities: {
      type: "array",
      items: {
        type: "object",
        required: ["characterName", "abilityType", "powerLevel", "evolutionArc", "vfxKeywords", "physicsNotes"],
        additionalProperties: false,
        properties: {
          characterName: { type: "string" },
          abilityType: { type: "string" },
          powerLevel: { type: "string", enum: ["dormant", "weak", "medium", "strong", "god-tier"] },
          evolutionArc: { type: "string" },
          vfxKeywords: { type: "array", items: { type: "string" } },
          physicsNotes: { type: "string" },
        },
      },
    },
    vfxRequirements: {
      type: "array",
      items: {
        type: "object",
        required: ["elementType", "technique", "colorGrading", "referenceMood", "avoidList"],
        additionalProperties: false,
        properties: {
          elementType: { type: "string" },
          technique: { type: "string" },
          colorGrading: { type: "string" },
          referenceMood: { type: "string" },
          avoidList: { type: "array", items: { type: "string" } },
        },
      },
    },
    atmosphereProfile: {
      type: "object",
      required: ["lighting", "colorPalette", "soundDesign", "environmentNotes"],
      additionalProperties: false,
      properties: {
        lighting: { type: "string" },
        colorPalette: { type: "array", items: { type: "string" } },
        soundDesign: { type: "string" },
        environmentNotes: { type: "string" },
      },
    },
    physicsRules: {
      type: "array",
      items: {
        type: "object",
        required: ["element", "rule", "avoidList"],
        additionalProperties: false,
        properties: {
          element: { type: "string" },
          rule: { type: "string" },
          avoidList: { type: "array", items: { type: "string" } },
        },
      },
    },
    styleDirectives: {
      type: "object",
      required: ["cinematicStyle", "cameraRules", "paceNotes", "heroMoments", "signatureShots"],
      additionalProperties: false,
      properties: {
        cinematicStyle: { type: "string" },
        cameraRules: { type: "string" },
        paceNotes: { type: "string" },
        heroMoments: { type: "array", items: { type: "string" } },
        signatureShots: { type: "array", items: { type: "string" } },
      },
    },
    culturalBlend: {
      type: "object",
      required: ["indianElements", "globalInfluences", "languageNotes"],
      additionalProperties: false,
      properties: {
        indianElements: { type: "array", items: { type: "string" } },
        globalInfluences: { type: "array", items: { type: "string" } },
        languageNotes: { type: "string" },
      },
    },
    realismDirectives: { type: "string" },
    sceneVfxMap: {
      type: "array",
      items: {
        type: "object",
        required: ["sceneIndex", "vfxElements", "atmosphereIntensity", "powerActivations", "directorNote"],
        additionalProperties: false,
        properties: {
          sceneIndex: { type: "number" },
          vfxElements: { type: "array", items: { type: "string" } },
          atmosphereIntensity: { type: "string", enum: ["none", "low", "medium", "high", "extreme"] },
          powerActivations: { type: "array", items: { type: "string" } },
          directorNote: { type: "string" },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the GEMS Paranormal & Supernatural Film Engine — an expert AI cinematographer specializing in horror, paranormal, supernatural, and superhero film production.

Your job is to analyze any script or story and extract a comprehensive VFX + atmosphere + physics profile that enables hyper-realistic cinematic production of paranormal/supernatural/superhero content.

CONTENT TYPE RULES:
- Classify content types accurately: horror, paranormal, supernatural, superpower, superhero, or standard (if none detected)
- If the story contains ANY paranormal/supernatural element (even briefly), mark hasParanormalElements as "partial" or "yes"
- If truly no such elements exist, mark "no" and still provide a full safe/realistic profile

VFX ENGINE RULES:
- Describe every VFX technique with practical production language (not vague terms)
- Reference real film benchmarks (The Conjuring, Hereditary, Doctor Strange, RRR, etc.)
- NEVER suggest cartoon or digitally obvious effects
- Ghost → transparent + floating + environmental interaction (fog, dust disturbance)
- Demon → dark aura + environmental distortion + eye glow (subtle, not glowing orbs)
- Superpower → physical consequence (shockwaves, debris, wind displacement)

PHYSICS RULES:
- ALL fictional elements must follow believable physics logic
- Flying characters: aerodynamic body posture, clothes react to wind, hair physics
- Possessions: micro-tremors first, then escalation — never instant full control
- Telekinesis: objects show strain, vibrate before lifting, shadow shifts

ATMOSPHERE SYSTEM:
- Lighting must use practical motivations (candles, flickering bulbs, moonlight)
- Color palettes must be specific (e.g., "sickly teal + deep maroon" not just "dark colors")
- Sound design descriptions inform the audio team with specific layers

CULTURAL BLEND:
- Indian horror: tantrik rituals, haveli architecture, jungle spirits, preta mythology, Sanskrit chants
- Indian superhero: devotional iconography, mythological powers (Hanuman speed, Arjuna precision)
- Always blend Indian elements naturally with global cinematic grammar

REALISM DIRECTIVES:
- Must feel like real film production
- No CGI seams, no lens flares from powers, no floaty/weightless movement
- Effects must earn their reveal — build tension before the visual

OUTPUT: Return a single strict JSON object matching the provided schema.`;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function analyzeParanormalElements(params: {
  title: string;
  style: string;
  inputContent: string;
  durationSeconds: number;
  existingAnalysis?: {
    characterProfiles?: unknown;
    sceneBreakdown?: unknown;
    narrativeTone?: string;
    primaryEmotion?: string;
  } | null;
}): Promise<ParanormalProfile> {
  const { title, style, inputContent, durationSeconds, existingAnalysis } = params;

  const durationMin = Math.round(durationSeconds / 60);

  const userPrompt = `ANALYZE THIS FILM CONTENT FOR PARANORMAL/SUPERNATURAL/SUPERHERO ELEMENTS:

Title: "${title}"
Style: ${style}
Target Duration: ${durationMin} minutes

${existingAnalysis?.narrativeTone ? `Narrative Tone: ${existingAnalysis.narrativeTone}` : ""}
${existingAnalysis?.primaryEmotion ? `Primary Emotion: ${existingAnalysis.primaryEmotion}` : ""}

SCRIPT / STORY:
${inputContent.slice(0, 6000)}

${existingAnalysis?.characterProfiles ? `\nEXISTING CHARACTER ANALYSIS:\n${JSON.stringify(existingAnalysis.characterProfiles, null, 2).slice(0, 2000)}` : ""}

${existingAnalysis?.sceneBreakdown ? `\nEXISTING SCENE BREAKDOWN:\n${JSON.stringify(existingAnalysis.sceneBreakdown, null, 2).slice(0, 2000)}` : ""}

Generate the complete Paranormal & VFX Profile JSON for this content. Be thorough and specific. If the content has no paranormal elements, still provide a complete atmospheric and physics profile appropriate for the style.`;

  logger.info({ title, style }, "paranormal-engine: starting analysis");

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "paranormal_profile",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
    temperature: 0.7,
    max_tokens: 4096,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) {
    throw new Error("paranormal-engine: empty response from AI");
  }

  let parsed: ParanormalProfile;
  try {
    parsed = JSON.parse(raw) as ParanormalProfile;
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 200) }, "paranormal-engine: JSON parse error");
    throw new Error("paranormal-engine: failed to parse AI response as JSON");
  }

  logger.info(
    { title, contentTypes: parsed.contentTypes, hasParanormal: parsed.hasParanormalElements },
    "paranormal-engine: analysis complete"
  );

  return parsed;
}
