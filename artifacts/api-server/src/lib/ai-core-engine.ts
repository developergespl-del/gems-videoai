/**
 * GEMS AI Core Engine
 *
 * A deep, human-like intelligence layer that analyses story/script/image inputs
 * before video generation.  It performs:
 *
 *  1. Context Understanding   — Who, what, where, why, when
 *  2. Emotion Detection       — Primary/secondary emotions, emotional arc
 *  3. Character Intelligence  — Names, ages, roles, dress, age progression
 *  4. Indian Cultural System  — Regional language, traditions, horror archetypes
 *  5. Production Planning     — Scene breakdown, voice direction, cinematic notes
 *  6. Human Speaking Style    — Natural dialogue cadence, reactions, subtext
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CharacterProfile {
  name: string;
  age: number;
  gender: string;
  role: "protagonist" | "antagonist" | "supporting" | "narrator";
  occupation: string;
  dress: string;
  physicalDescription: string;
  personality: string[];
  emotionalState: string;
  voiceStyle: string;
  accent: string;
  dialect: string;
  ageProgressionNeeded: boolean;
  ageProgressionFrom?: number;
  ageProgressionTo?: number;
  voiceChangeWithAge: string;
}

export interface EmotionalProfile {
  primaryEmotion: string;
  secondaryEmotions: string[];
  emotionalArc: Array<{ moment: string; emotion: string; intensity: number }>;
  overallTone: string;
  audienceImpact: string;
  indianEmotionMapping: string;
}

export interface CulturalContext {
  isCulturallyIndian: boolean;
  region: string;
  language: string;
  dialect: string;
  traditions: string[];
  festivals: string[];
  horrorArchetypes: string[];           // bhoot, tantrik, haveli, churail, etc.
  familyDynamics: string;
  socialContext: string;
  regionalFlavour: string;
  musicalStyle: string;
  clothingEra: string;
}

export interface Scene {
  sceneNumber: number;
  location: string;
  timeOfDay: string;
  duration: number;                     // seconds
  description: string;
  characters: string[];
  emotion: string;
  cameraDirection: string;
  lighting: string;
  soundscape: string;
  dialogue: string;
  culturalElement: string;
  cinematicStyle: string;
}

export interface DialogueStyle {
  speakingPace: "slow" | "medium" | "fast" | "variable";
  naturalFiller: string[];              // "hmm", "arre", "accha", "bhai", etc.
  sentenceStructure: string;
  emotionalInterjections: string[];
  silenceMoments: string[];
  subtext: string;
  regionalExpressions: string[];
}

export interface ProductionPlan {
  genre: string;
  subGenre: string;
  visualStyle: string;
  colorPalette: string;
  cinematography: string;
  editingPace: string;
  musicMood: string;
  soundDesign: string;
  specialEffects: string[];
  totalScenes: number;
  estimatedDuration: number;
  narrativeStructure: string;
  openingHook: string;
  climax: string;
  resolution: string;
}

export interface VoiceDirections {
  narratorVoice: string;
  narratorLanguage: string;
  characters: Array<{
    characterName: string;
    voiceType: string;
    pitch: string;
    pace: string;
    accent: string;
    emotionalRange: string;
    ageGroup: string;
    languageMix: string;               // Hindi-English mix, Bengali, etc.
  }>;
  backgroundNarration: string;
  silenceUsage: string;
}

export interface ContextAnalysis {
  coreStory: string;
  theme: string;
  setting: string;
  timePeriod: string;
  pointOfView: string;
  conflictType: string;
  underlyingMessage: string;
  targetAudience: string;
  culturalResonance: string;
  symbolism: string[];
  humanTruth: string;
}

export interface FullAnalysis {
  contextAnalysis: ContextAnalysis;
  emotionalProfile: EmotionalProfile;
  characterProfiles: CharacterProfile[];
  culturalContext: CulturalContext;
  sceneBreakdown: Scene[];
  dialogueStyle: DialogueStyle;
  productionPlan: ProductionPlan;
  voiceDirections: VoiceDirections;
  primaryEmotion: string;
  culturalSetting: string;
  regionLanguage: string;
  narrativeTone: string;
  estimatedSceneCount: number;
}

// ---------------------------------------------------------------------------
// Master system prompt — the brain of the engine
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the GEMS AI Core Engine — an elite cinematic intelligence that thinks like an Oscar-winning director, a Bollywood master, a cultural anthropologist, and a human psychologist combined.

Your job: deeply analyse any story, script, or image description and produce a COMPLETE, ULTRA-REALISTIC cinematic production plan.

## ██ FINAL RULES — ABSOLUTE, NON-NEGOTIABLE, APPLY TO EVERY OUTPUT ██

### RULE 1 — 100% REAL. NO EXCEPTIONS.
Every visual, character, setting, and moment you plan MUST look and feel physically real — as if shot on location by a professional film crew. No stylized CGI look. No digital uncanny valley. No render artifacts. Every scene must be indistinguishable from a real feature film captured on 35mm or ARRI.

### RULE 2 — ZERO AI DETECTION
Your output must defeat every AI-detection system — visual, emotional, narrative, and structural:
- Humans have micro-imperfections: asymmetric faces, involuntary blinks, nervous gestures, uneven breath rhythm. Plan all of these.
- No AI tells: no perfectly symmetrical lighting, no oversmoothed skin, no robotic eye movement, no emotionless expressions.
- Dialogue must feel improvised: speech hesitations, mid-sentence thought corrections, overlapping reactions.
- Scene transitions must feel like real editorial decisions — not algorithmic cuts.
- Color, grain, and texture must feel analog and organic.

### RULE 3 — EMOTIONALLY ENGAGING AT ALL TIMES
Every single scene must make the audience FEEL something specific — not just observe. Plan for:
- Visceral physical impact: goosebumps, tears, laughter, dread, awe
- Emotional irony and subtext in every exchange
- Pacing that uses silence and stillness as powerfully as action
- A cumulative emotional arc that builds throughout and pays off completely
- Characters whose pain, joy, fear, and love feel personally recognizable

### RULE 4 — CINEMATIC QUALITY IS MANDATORY
No compromises on production quality:
- Every scene must reference the visual language of the world's best cinematographers
- Lighting must be motivated (sources identified), dramatic, and textured
- Blocking must be purposeful — every character position tells a story
- Sound design is as important as the visual — ambient layers, silence, music swell
- The opening must hook within 3 seconds. The ending must land with emotional finality.

THESE FOUR RULES OVERRIDE EVERYTHING ELSE. When in doubt, make it more real, more human, more emotionally devastating, more cinematic.

## YOUR THINKING PROCESS (ALWAYS FOLLOW IN ORDER):

### STEP 1 — Context Understanding
- Read the full input multiple times like a human would
- Extract: WHO (characters), WHAT (events), WHERE (locations), WHEN (time period), WHY (motivation), HOW (manner of events)
- Identify the REAL story beneath the surface story
- Find the human truth — what universal emotion does this touch?

### STEP 2 — Character Intelligence
For EVERY character (named or implied):
- Full name (or inferred name based on culture/region)
- Exact age (or estimated age range)
- Role in story
- Physical appearance: height, build, skin tone, hair
- Dress: era-appropriate, region-appropriate clothing
- Personality traits (minimum 5)
- Emotional state at each story moment
- Voice: pitch, pace, accent, language mix
- AGE PROGRESSION: If a character appears at different ages (e.g., 30 then 60 years later), plan exactly how their appearance, voice, and mannerisms change

### STEP 3 — Emotion Detection (Human-Level)
- Identify primary emotion (not just "sad" — be specific: "grief mixed with silent acceptance")
- Map the full emotional arc — how do emotions change scene by scene?
- Detect subtext: what are characters REALLY feeling beneath what they say?
- Indian emotional mapping: connect to specific Bollywood/classical emotional concepts (Virah, Shringara, Karuna, Rudra, Bhayanak, etc.)

### STEP 4 — Indian Cultural Intelligence (CRITICAL)
If the story is Indian or has Indian characters/settings:
- Detect exact region: Punjab, Bengal, Assam, Maharashtra, UP, Tamil Nadu, Kerala, Rajasthan, etc.
- Language and dialect: Hindi (Bhojpuri? Haryanvi?), Bengali (standard? Sylheti?), Assamese, Tamil, Telugu, Kannada, Marathi, Punjabi, etc.
- Traditions: festivals, rituals, wedding customs, food references, relationship dynamics
- Family structure: joint family? Nuclear? Caste dynamics? Urban vs rural?
- HORROR ELEMENTS: If horror/thriller — identify Indian horror archetypes:
  * Bhoot (ghost) — type: friendly, malevolent, tragic
  * Churail (witch-ghost) — appearances, mythology
  * Tantrik — black magic rituals, sacred ash, fire ceremonies
  * Haveli (mansion) — old architecture, family curses, ancestral spirits
  * Pret (restless spirit)
  * Yaksha/Yakshini — forest spirits
  * Regional horror: Daayan (witch), Mohini, Nishi (Bengal midnight spirits)
- Music: classical ragas, folk music, regional film music style
- Visual aesthetics: colours, patterns, architecture style

### STEP 5 — Human Speaking Style
Generate dialogue/voice direction that sounds EXACTLY like real humans, not AI:
- Natural filler words and pauses ("hmm", "arre yaar", "accha", "dekh", "suno", "bhai", "didi")
- Sentence fragments (real people don't speak in complete sentences)
- Code-switching (Hindi + English mix is natural in urban India)
- Regional expressions and idioms
- Emotional interjections that feel genuine
- Silence and breath moments
- Subtext — what's NOT said matters as much as what IS said

### STEP 6 — Scene Breakdown
Break the story into specific, filmable scenes:
- Exact location description (interior/exterior, lighting conditions)
- Time of day and weather
- Camera direction (close-up, wide shot, tracking shot, POV, etc.)
- Sound design (ambient sounds, music swell, silence)
- Character blocking
- Duration estimate for each scene

### STEP 7 — Production Plan
Create a complete cinematic blueprint:
- Visual style (cinematography references)
- Color palette (warm, cold, desaturated, vibrant — WHY?)
- Editing pace
- Music mood and specific instrument/genre suggestions
- Sound design details
- Special effects needed

## OUTPUT FORMAT
Return ONLY valid JSON. No markdown. No explanation. No preamble.
The JSON must exactly match this TypeScript structure (all fields required):

{
  "contextAnalysis": { "coreStory", "theme", "setting", "timePeriod", "pointOfView", "conflictType", "underlyingMessage", "targetAudience", "culturalResonance", "symbolism": [], "humanTruth" },
  "emotionalProfile": { "primaryEmotion", "secondaryEmotions": [], "emotionalArc": [{"moment", "emotion", "intensity": 0-10}], "overallTone", "audienceImpact", "indianEmotionMapping" },
  "characterProfiles": [{ "name", "age": 0, "gender", "role", "occupation", "dress", "physicalDescription", "personality": [], "emotionalState", "voiceStyle", "accent", "dialect", "ageProgressionNeeded": false, "ageProgressionFrom": null, "ageProgressionTo": null, "voiceChangeWithAge" }],
  "culturalContext": { "isCulturallyIndian": true/false, "region", "language", "dialect", "traditions": [], "festivals": [], "horrorArchetypes": [], "familyDynamics", "socialContext", "regionalFlavour", "musicalStyle", "clothingEra" },
  "sceneBreakdown": [{ "sceneNumber": 1, "location", "timeOfDay", "duration": 0, "description", "characters": [], "emotion", "cameraDirection", "lighting", "soundscape", "dialogue", "culturalElement", "cinematicStyle" }],
  "dialogueStyle": { "speakingPace", "naturalFiller": [], "sentenceStructure", "emotionalInterjections": [], "silenceMoments": [], "subtext", "regionalExpressions": [] },
  "productionPlan": { "genre", "subGenre", "visualStyle", "colorPalette", "cinematography", "editingPace", "musicMood", "soundDesign", "specialEffects": [], "totalScenes": 0, "estimatedDuration": 0, "narrativeStructure", "openingHook", "climax", "resolution" },
  "voiceDirections": { "narratorVoice", "narratorLanguage", "characters": [{"characterName", "voiceType", "pitch", "pace", "accent", "emotionalRange", "ageGroup", "languageMix"}], "backgroundNarration", "silenceUsage" },
  "primaryEmotion": "",
  "culturalSetting": "",
  "regionLanguage": "",
  "narrativeTone": "",
  "estimatedSceneCount": 0
}`;

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

export async function analyzeVideoInput(params: {
  inputType: "story" | "script" | "image";
  inputContent: string;
  style: string;
  durationSeconds: number;
  title: string;
}): Promise<FullAnalysis> {
  const { inputType, inputContent, style, durationSeconds, title } = params;

  const userPrompt = buildUserPrompt(inputType, inputContent, style, durationSeconds, title);

  logger.info({ title, inputType, durationSeconds }, "AI Core Engine: starting analysis");

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  logger.info({ title }, "AI Core Engine: analysis complete");

  let parsed: FullAnalysis;
  try {
    parsed = JSON.parse(raw) as FullAnalysis;
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 500) }, "AI Core Engine: JSON parse error");
    throw new Error("AI Core Engine returned invalid JSON");
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Streaming analysis — returns SSE-compatible async generator
// ---------------------------------------------------------------------------

export async function* analyzeVideoInputStream(params: {
  inputType: "story" | "script" | "image";
  inputContent: string;
  style: string;
  durationSeconds: number;
  title: string;
}): AsyncGenerator<string> {
  const { inputType, inputContent, style, durationSeconds, title } = params;

  const userPrompt = buildUserPrompt(inputType, inputContent, style, durationSeconds, title);

  const stream = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 8192,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      yield content;
    }
  }
}

// ---------------------------------------------------------------------------
// Thinking step narration — produces human-like "thinking" updates to stream
// to the UI while the real analysis runs
// ---------------------------------------------------------------------------

export async function generateThinkingNarrative(params: {
  inputType: "story" | "script" | "image";
  inputContent: string;
  style: string;
}): Promise<string[]> {
  const { inputType, inputContent, style } = params;

  const prompt = `You are the GEMS AI engine's internal monologue. You are reading a ${inputType} and thinking through it like an experienced film director.

Input: """${inputContent.slice(0, 800)}"""

Style requested: ${style}

Generate 6-8 short internal thought statements (1 sentence each) that represent your natural, human-like thinking process as you analyze this content. These should feel like genuine thoughts, not robotic steps. Include:
- First impression reaction
- Character noticing
- Emotional identification  
- Cultural context recognition (if Indian)
- Scene visualization
- Production insight

Return a JSON array of strings only: ["thought1", "thought2", ...]`;

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 800,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? '{"thoughts":[]}';
  try {
    const parsed = JSON.parse(raw);
    // Handle both array and object responses
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.thoughts)) return parsed.thoughts;
    return Object.values(parsed).flat().filter((v): v is string => typeof v === "string");
  } catch {
    return ["Reading your story carefully...", "Analyzing characters and emotions...", "Building the cinematic vision..."];
  }
}

// ---------------------------------------------------------------------------
// Re-analyze with additional cultural depth (on-demand)
// ---------------------------------------------------------------------------

export async function deepCulturalAnalysis(params: {
  inputContent: string;
  region: string;
  horrorMode: boolean;
}): Promise<CulturalContext> {
  const { inputContent, region, horrorMode } = params;

  const prompt = `Perform an ultra-deep Indian cultural analysis of this content:

"""${inputContent.slice(0, 1200)}"""

Region focus: ${region}
Horror mode: ${horrorMode}

${horrorMode ? `For horror, identify ALL applicable elements:
- Specific ghost/spirit type (Bhoot, Churail, Pret, Mohini, Daayan, Yakshini, Nishi, Pisach)
- Tantrik rituals described or implied
- Haveli/mansion architectural horror elements
- Local village mythology
- Time-specific threats (midnight, Amavasya/new moon, eclipse)
- Sacred objects (black thread, sindoor, tilak, peepal tree)
- Regional horror specific to ${region}` : ""}

Return only valid JSON matching the CulturalContext interface.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 2000,
    messages: [
      { role: "system", content: "You are an expert in Indian culture, mythology, folklore, and regional traditions. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw) as CulturalContext;
}

// ---------------------------------------------------------------------------
// Character age progression analysis
// ---------------------------------------------------------------------------

export async function analyzeAgeProgression(params: {
  characterName: string;
  fromAge: number;
  toAge: number;
  gender: string;
  ethnicity: string;
}): Promise<{
  physicalChanges: string[];
  voiceChanges: string[];
  mannerismChanges: string[];
  emotionalMaturation: string[];
  dressingChanges: string[];
  cinematicApproach: string;
}> {
  const { characterName, fromAge, toAge, gender, ethnicity } = params;

  const prompt = `Describe the realistic physical and emotional transformation of ${characterName}, a ${ethnicity} ${gender}, from age ${fromAge} to age ${toAge}.

Be extremely specific and realistic — like a makeup and VFX supervisor briefing their team.

Return JSON with:
{
  "physicalChanges": ["specific change 1", ...],
  "voiceChanges": ["voice quality changes", ...],
  "mannerismChanges": ["movement and behavior changes", ...],
  "emotionalMaturation": ["emotional depth changes", ...],
  "dressingChanges": ["clothing style evolution", ...],
  "cinematicApproach": "how to film this transformation"
}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 1500,
    messages: [
      { role: "system", content: "You are a specialist in human aging, transformation, and cinematic representation. Return only valid JSON." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Helper — build user prompt
// ---------------------------------------------------------------------------

function buildUserPrompt(
  inputType: "story" | "script" | "image",
  inputContent: string,
  style: string,
  durationSeconds: number,
  title: string
): string {
  const durationMinutes = Math.round(durationSeconds / 60);

  const inputLabel = {
    story: "STORY INPUT",
    script: "SCRIPT INPUT",
    image: "IMAGE DESCRIPTION INPUT",
  }[inputType];

  return `## VIDEO GENERATION REQUEST

**Title:** ${title}
**Requested Style:** ${style}
**Target Duration:** ${durationSeconds} seconds (${durationMinutes} minutes)
**Input Type:** ${inputType.toUpperCase()}

### ${inputLabel}:
"""
${inputContent}
"""

Think deeply. This video must be ultra-realistic with zero AI feel.
Plan the perfect ${style} cinematic experience for exactly ${durationSeconds} seconds.
${durationSeconds > 600 ? `This is a LONG-FORM video (${durationMinutes} minutes) — plan enough scenes to fill the runtime naturally.` : ""}
${inputType === "image" ? "The user described an image. Infer a rich story from the visual details provided." : ""}

Now analyse everything deeply and return the complete production JSON.`;
}
