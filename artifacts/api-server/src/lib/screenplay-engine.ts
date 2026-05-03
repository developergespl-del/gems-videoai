/**
 * GEMS Screenplay Engine
 *
 * Step 2 of the 3-step generation workflow.
 * Takes the completed AI analysis and generates a proper Final Draft-style
 * cinematic screenplay with camera directions, lip-sync notes, voice coaching,
 * and frame-accurate emotion accuracy maps.
 */

import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";
import type { FullAnalysis } from "./ai-core-engine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DialogueLine {
  character: string;
  parenthetical: string;
  line: string;
  languageNote: string;
  deliveryNote: string;
}

export interface EmotionAccuracyBeat {
  timecode: string;
  character: string;
  microExpression: string;
  intensity: number;
  muscleGroups: string;
  eyeDirection: string;
  lipPosition: string;
}

export interface ScreenplayScene {
  number: number;
  slugLine: string;
  interiorExterior: "INT" | "EXT" | "INT/EXT";
  location: string;
  timeOfDay: string;
  action: string;
  cameraDirection: string;
  lensBehavior: string;
  colorGradingNote: string;
  lightingInstruction: string;
  soundDirection: string;
  ambientSoundscape: string;
  musicCue: string;
  characters: string[];
  dialogue: DialogueLine[];
  transition: string;
  emotionTarget: string;
  voiceNote: string;
  lipSyncNote: string;
  emotionAccuracy: EmotionAccuracyBeat[];
  duration: number;
  culturalElement: string;
  // Long-video markers
  isIntermissionScene?: boolean;   // true for the dedicated INTERMISSION beat
  isPartBreak?: "part1_end" | "part2_begin"; // markers for 3-hr+ split
}

export interface Screenplay {
  title: string;
  logline: string;
  genre: string;
  style: string;
  totalDuration: number;
  writtenBy: string;
  basedOn: string;
  scenes: ScreenplayScene[];
  openingSlate: string;
  closingSlate: string;
  productionNotes: string;
  voiceActingDirections: string;
  lipSyncGuidance: string;
  overallEmotionArc: string;
  culturalAuthenticityNotes: string;
  renderingDirections: string;
  // Long-video metadata (AI-populated when applicable)
  intermissionLabel?: string;       // "INTERMISSION" in the story's primary language
  part1ClosingSlate?: string;        // closing slate for Part 1
  part2OpeningSlate?: string;        // opening slate for Part 2
  splitNarrativeNote?: string;       // how continuity is maintained across parts
}

// ---------------------------------------------------------------------------
// System prompt — the director's brain
// ---------------------------------------------------------------------------

const SCREENPLAY_SYSTEM_PROMPT = `You are the GEMS Screenplay Engine — a master screenwriter who combines the precision of a Final Draft script, the visual mastery of Roger Deakins, the voice direction expertise of a Bollywood music director, and the technical accuracy of a VFX supervisor.

Your job: take a completed AI story analysis and write a PRODUCTION-READY cinematic screenplay that contains EVERYTHING needed for video generation — frame by frame.

## ██ FINAL RULES — ABSOLUTE, OVERRIDE EVERYTHING, APPLY TO EVERY SCENE ██

### RULE 1 — 100% PHOTOREALISTIC. NO AI LOOK.
Every shot you write must produce an image indistinguishable from real professional cinematography:
- Specify imperfect, organic lighting — motivated sources (window light, practical lamps, torchlight, fire) with natural fall-off and fill
- Describe real textural detail: pores on skin, dust particles in light beams, fabric creases, worn surfaces
- Camera must behave like a real operator — slight handheld breathe on intimate scenes, locked-off on wide masters, weight on lens moves
- No clean digital renders. Every frame must carry the character of film grain, lens flare, chromatic aberration where appropriate

### RULE 2 — DEFEAT EVERY AI DETECTION SYSTEM
Write human imperfection into every element:
- FACES: specify asymmetric micro-expressions, involuntary blinks (2–4/minute), natural eye saccades, uneven muscle tension
- VOICES: write in breath, stumble, overlap — characters interrupt themselves, trail off, restart sentences
- MOVEMENT: no fluid AI motion — weight, momentum, stumble, hesitation, fidget
- DIALOGUE: contractions, ellipses, broken grammar, code-switching, regional idiom — sounds RECORDED, not generated
- EDITING: motivate every cut — cut on action, cut on sound, never a clean algorithmic transition
- COLOR: specify analog imperfection — slight color cast from practicals, vignette from lens, highlight rolloff, not digitally graded

### RULE 3 — EMOTIONAL DEVASTATION IS THE MINIMUM BAR
Every scene must target a specific emotional response and earn it:
- State the INTENDED AUDIENCE FEELING at the top of every scene's emotionTarget field — be precise: "quiet devastation mixed with reluctant hope", not just "sad"
- Write micro-beats: a single shared glance, the way a hand touches a sleeve, a breath held and released — these carry more emotion than any line of dialogue
- Sound is emotion: specify the exact ambient soundscape that shapes the feeling before a word is spoken
- Silence is a weapon: mark exactly where silence hits harder than music — and hold it 2–3 seconds longer than feels comfortable
- The final frame of the film must be EARNED — the audience must feel they have lived through something real

### RULE 4 — CINEMATIC QUALITY, ZERO COMPROMISE
Production language in every direction:
- Every camera direction must specify: shot size + movement + angle + lens + motivation
- Every scene must have: motivated light source, specific ambient sound, music entry/exit point
- Blocking must be choreographed: mark where characters stand, move, and stop — and WHY it matters narratively
- The first 3 seconds of the film must be the strongest visual in the screenplay — hook before anything else
- The closing image must rhyme visually or emotionally with the opening — create a closed, resonant circle

THESE FOUR RULES ARE THE HIGHEST PRIORITY. Every creative decision must serve them. When in doubt: go more real, more raw, more human, more devastating.

## SCREENPLAY REQUIREMENTS

### 1. SCENE HEADERS (Slug Lines)
Format: INT/EXT. EXACT_LOCATION — TIME_OF_DAY
Example: EXT. PURANI HAVELI, MEERUT OUTSKIRTS — DEEP NIGHT

### 2. ACTION LINES
- Write in present tense, active voice
- Every shot should be visualizable by a cinematographer
- Include blocking (where characters stand/move)
- Describe textures, lighting, weather in sensory detail

### 3. CAMERA DIRECTIONS (per scene)
Be specific and technical:
- Shot type: EXTREME CLOSE-UP / CLOSE-UP / MEDIUM / WIDE / EXTREME WIDE
- Movement: STATIC / PUSH-IN / PULL-OUT / TRACKING / HANDHELD / DRONE
- Angle: EYE-LEVEL / LOW-ANGLE / HIGH-ANGLE / DUTCH TILT / BIRD'S EYE
- Lens behavior: shallow focus, rack focus, depth of field notes
- Example: "ECU - HANDHELD - LOW-ANGLE. The camera trembles as it creeps toward the rusted lock. Rack focus: lock → hallway darkness."

### 4. DIALOGUE WITH FULL DIRECTION
For every line of dialogue include:
- Character name (CAPS)
- Parenthetical: (physical action + emotional state + delivery speed)
- The line itself — authentic to the character's voice, region, age
- Language note: specify Hindi/Bengali/Assamese/English/code-switch
- Delivery note: pace, breath pauses, where voice breaks

### 5. LIP SYNC NOTES (CRITICAL FOR VIDEO GENERATION)
For each dialogue scene:
- Identify critical phoneme pairs that must sync precisely
- For Indian languages: م/m, ب/b, پ/p labial consonants; ड/ट dental stops
- Timing of mouth open/close relative to audio
- Key words where lip sync is most visible

### 6. EMOTION ACCURACY MAP (CRITICAL)
For every character in every dialogue beat, specify:
- Timecode offset (0.0s from scene start)
- Exact micro-expression: which facial muscles, what movement
- Eye direction: up-left, down-right, direct, unfocused
- Lip position at rest vs during speech
- Intensity: 1-10
Example: "0.3s before RAHUL speaks — brow compression (corrugator supercilii), lip press (orbicularis oris), gaze drops to floor"

### 7. SOUND DESIGN (per scene)
- Ambient soundscape: specific sounds (distance, direction)
- Music cue: specific raga, tempo, instrument entry
- Sound effects: precise timing
- Silence moments: where silence is used as a weapon

### 8. CULTURAL AUTHENTICITY
If Indian: include specific regional authenticity notes
- Props that must be authentic (specific brand, period, region)
- Background details (what locals wear, carry, do)
- Language accuracy (dialectal variations, pronunciation notes)

## OUTPUT FORMAT
Return ONLY valid JSON matching the Screenplay interface exactly.
All fields required. Scenes array must match or expand the story's scene breakdown.

### LONG-VIDEO SCENE MARKERS
When the prompt includes long-video directives:
- INTERMISSION scene: set \`"isIntermissionScene": true\`, slugLine = "-- INTERMISSION --"
- Part break scene (Part 1 end): set \`"isPartBreak": "part1_end"\`
- Part begin scene (Part 2 start): set \`"isPartBreak": "part2_begin"\`
- Top-level screenplay fields: \`"intermissionLabel"\`, \`"part1ClosingSlate"\`, \`"part2OpeningSlate"\`, \`"splitNarrativeNote"\`
These fields are optional and only required when the corresponding directive is in the prompt.`;

// ---------------------------------------------------------------------------
// Main screenplay generation function
// ---------------------------------------------------------------------------

export interface CinemaSpec {
  aspectRatio: string;
  resolution: string;
  cinemaMode: boolean;
  colorGrade: string;
  filmGrain: boolean;
  depthOfField: boolean;
  audioMastering: string;
  exportFormats: string[];
}

export interface ParanormalContext {
  hasParanormalElements: string;
  contentTypes: string[];
  characterAbilities: unknown[];
  vfxRequirements: unknown[];
  atmosphereProfile: unknown;
  physicsRules: unknown[];
  styleDirectives: unknown;
  culturalBlend: unknown;
  realismDirectives: string | null;
  sceneVfxMap: unknown[];
}

export async function generateScreenplay(params: {
  analysis: FullAnalysis;
  title: string;
  style: string;
  durationSeconds: number;
  inputType: string;
  paranormalContext?: ParanormalContext | null;
  cinemaSpec?: CinemaSpec | null;
}): Promise<Screenplay> {
  const { analysis, title, style, durationSeconds, paranormalContext, cinemaSpec } = params;

  const userPrompt = buildScreenplayPrompt(analysis, title, style, durationSeconds, paranormalContext, cinemaSpec);

  logger.info({ title }, "Screenplay Engine: starting generation");

  const completion = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 6000,
    messages: [
      { role: "system", content: SCREENPLAY_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";

  logger.info({ title }, "Screenplay Engine: generation complete");

  let screenplay: Screenplay;
  try {
    screenplay = JSON.parse(raw) as Screenplay;
  } catch (err) {
    logger.error({ err, raw: raw.slice(0, 300) }, "Screenplay Engine: JSON parse error");
    throw new Error("Screenplay Engine returned invalid JSON");
  }

  return screenplay;
}

// ---------------------------------------------------------------------------
// Helper — build the prompt from existing analysis
// ---------------------------------------------------------------------------

function buildScreenplayPrompt(
  analysis: FullAnalysis,
  title: string,
  style: string,
  durationSeconds: number,
  paranormalContext?: ParanormalContext | null,
  cinemaSpec?: CinemaSpec | null
): string {
  const minutes = Math.round(durationSeconds / 60);

  const paranormalSection =
    paranormalContext && paranormalContext.hasParanormalElements !== "no"
      ? `
## ⚡ PARANORMAL & SUPERNATURAL VFX DIRECTIVES (AUTO-DETECTED — MANDATORY)
Content Types Detected: ${paranormalContext.contentTypes.join(", ")}

CHARACTER ABILITIES:
${JSON.stringify(paranormalContext.characterAbilities, null, 2)}

VFX REQUIREMENTS (apply per scene, integrate naturally — NO cartoon effects):
${JSON.stringify(paranormalContext.vfxRequirements, null, 2)}

ATMOSPHERE PROFILE (apply throughout):
${JSON.stringify(paranormalContext.atmosphereProfile, null, 2)}

PHYSICS RULES (strict — all fictional elements must obey):
${JSON.stringify(paranormalContext.physicsRules, null, 2)}

STYLE DIRECTIVES (cinematic, not digital):
${JSON.stringify(paranormalContext.styleDirectives, null, 2)}

CULTURAL BLEND:
${JSON.stringify(paranormalContext.culturalBlend, null, 2)}

REALISM DIRECTIVE: ${paranormalContext.realismDirectives ?? "All effects must feel like real in-camera practical FX — no CGI seams, no cartoonish glow."}

SCENE VFX MAP (apply only where listed — avoid overuse):
${JSON.stringify(paranormalContext.sceneVfxMap, null, 2)}

RULE: Every scene that involves paranormal/supernatural/superpower elements MUST include:
  - Precise VFX description in camera directions
  - Physics-accurate movement notes
  - Atmosphere/lighting cue from the profile above
  - NO placeholder text — actual cinematic production language only
`
      : "";

  // ── Long-video section ───────────────────────────────────────────────────
  const INTERMISSION_THRESHOLD = 5400;  // 1.5 hours
  const SPLIT_THRESHOLD = 10800;        // 3 hours
  const needsIntermission = durationSeconds > INTERMISSION_THRESHOLD;
  const needsSplit = durationSeconds > SPLIT_THRESHOLD;

  const intermissionHalf = Math.round(durationSeconds / 2);
  const splitHalf = Math.round(durationSeconds / 2);
  const fmt = (s: number) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

  const longVideoSection = needsSplit
    ? `
## 🎬 LONG FILM — MANDATORY PART SPLIT (${fmt(durationSeconds)} total)

This is a FULL-LENGTH FEATURE FILM exceeding 3 hours. You MUST structure the screenplay as TWO PARTS:

**PART 1** covers the first ~${fmt(splitHalf)} of story.
**PART 2** covers the remaining ~${fmt(splitHalf)} of story.

RULES:
1. Insert a scene with \`"isPartBreak": "part1_end"\` at the natural narrative break nearest the ${fmt(splitHalf)} mark. This MUST fall at a chapter boundary — end of an act, after a major revelation, or after an emotional peak. NEVER mid-dialogue or mid-action.
2. Immediately after, insert a scene with \`"isPartBreak": "part2_begin"\` — a brief story-so-far recap scene (max 2 minutes) that orients the audience returning for Part 2. It should FEEL like a subtle reminder, not an explicit recap card.
3. Set \`"part1ClosingSlate"\` to a cinematic "END OF PART 1 — CONTINUED" slate text.
4. Set \`"part2OpeningSlate"\` to a cinematic "PART 2 — [TITLE]" slate text.
5. Set \`"splitNarrativeNote"\` explaining where the emotional and narrative thread is picked up.
6. Also include the INTERMISSION scene (see below) since this film exceeds 1.5 hours.
${needsIntermission ? `
**INTERMISSION** at ~${fmt(intermissionHalf)} mark (see below).
` : ""}
`
    : needsIntermission
    ? `
## 🎬 LONG FILM — MANDATORY INTERMISSION (${fmt(durationSeconds)} total)

This film exceeds 1 hour 30 minutes. You MUST insert an INTERMISSION scene.

RULES:
1. Find the most natural story pause near the ~${fmt(intermissionHalf)} mark — after a scene's emotional peak, between acts, or at a chapter ending. NEVER mid-dialogue or mid-action.
2. Insert a dedicated scene with \`"isIntermissionScene": true\` at that point.
3. The scene's \`"slugLine"\` MUST be exactly: \`"-- INTERMISSION --"\`
4. The scene's \`"action"\` describes: FADE TO BLACK — INTERMISSION CARD appears in the film's primary language — soft cinematic music plays — hold 8–12 seconds — FADE IN.
5. The scene's \`"musicCue"\` should specify a gentle, thematic instrumental piece (no lyrics) bridging the break.
6. Set \`"intermissionLabel"\` in the Screenplay object to the word "INTERMISSION" translated to the film's primary language (e.g., "ANTRAKTA" in Hindi, "INTERVAL" in Tamil, "ENTRACTE" in French, etc.).
7. \`"transition"\` must be: \`"FADE OUT / FADE IN"\`
8. Duration of the intermission scene: exactly 10 seconds.

STORY CONTINUITY: The scene immediately after the intermission must open with a brief emotional re-anchoring — a moment, image, or sound that reconnects the audience to where they left off emotionally.
`
    : "";

  const cinemaSection = cinemaSpec
    ? `
## 🎬 CINEMA-GRADE OUTPUT SPECIFICATIONS (MANDATORY)
Aspect Ratio: ${cinemaSpec.aspectRatio}${cinemaSpec.aspectRatio === "21:9" || cinemaSpec.aspectRatio === "2.39:1" ? " (ANAMORPHIC SCOPE — use letterbox composition, wide-field blocking)" : ""}
Resolution: ${cinemaSpec.resolution}${cinemaSpec.cinemaMode ? " — CINEMA MODE ACTIVE (theatrical quality mastering required)" : ""}
Color Grade: ${cinemaSpec.colorGrade.toUpperCase()}${cinemaSpec.colorGrade === "natural" ? " — balanced, true-to-life" : cinemaSpec.colorGrade === "warm" ? " — golden tones, analog warmth" : cinemaSpec.colorGrade === "cold" ? " — clinical blues, controlled palette" : cinemaSpec.colorGrade === "noir" ? " — deep blacks, crushed shadows, low-key" : cinemaSpec.colorGrade === "vibrant" ? " — punchy saturation, commercial pop" : " — Holi-inspired, rich jewel tones, Bollywood vivid"}
Depth of Field: ${cinemaSpec.depthOfField ? "YES — write lens/focus notes for every scene (rack focus, bokeh, shallow depth)" : "NO — flat focus, wide-angle approach"}
Film Grain: ${cinemaSpec.filmGrain ? "YES — 35mm analog grain texture, organic feel" : "NO — clean digital"}
Audio Mastering: ${cinemaSpec.audioMastering === "surround-ready" ? "SURROUND-READY (5.1/7.1 mix) — note spatial audio directions per scene (left/right/rear channel placement)" : "STEREO — balanced L/R mix"}
Export Targets: ${cinemaSpec.exportFormats.join(", ")}

EVERY SCENE CAMERA DIRECTION MUST INCLUDE:
- Lens specification appropriate for ${cinemaSpec.resolution} ${cinemaSpec.aspectRatio} (e.g. "32mm T1.4 anamorphic" for scope, "50mm 1.8" for standard)
- ${cinemaSpec.depthOfField ? "Focus and depth-of-field notes" : ""}
- ${cinemaSpec.colorGrade !== "natural" ? `Color grade intent (${cinemaSpec.colorGrade})` : ""}
- ${cinemaSpec.cinemaMode ? "Theatrical composition (rule of thirds, golden ratio, negative space)" : ""}
`
    : "";

  return `## SCREENPLAY BRIEF

**Title:** ${title}
**Style:** ${style}
**Target Duration:** ${durationSeconds} seconds (${minutes} minutes)
${longVideoSection}${cinemaSection}${paranormalSection}
## STORY INTELLIGENCE (from AI analysis)
Core Story: ${analysis.contextAnalysis.coreStory}
Theme: ${analysis.contextAnalysis.theme}
Setting: ${analysis.contextAnalysis.setting}
Time Period: ${analysis.contextAnalysis.timePeriod}
Conflict: ${analysis.contextAnalysis.conflictType}
Human Truth: ${analysis.contextAnalysis.humanTruth}
Underlying Message: ${analysis.contextAnalysis.underlyingMessage}

## CHARACTER INTELLIGENCE
${JSON.stringify(analysis.characterProfiles, null, 2)}

## EMOTIONAL PROFILE
Primary Emotion: ${analysis.emotionalProfile.primaryEmotion}
Overall Tone: ${analysis.emotionalProfile.overallTone}
Indian Emotion Mapping: ${analysis.emotionalProfile.indianEmotionMapping}
Emotional Arc: ${JSON.stringify(analysis.emotionalProfile.emotionalArc)}

## CULTURAL CONTEXT
Region: ${analysis.culturalContext.region}
Language: ${analysis.culturalContext.language} / ${analysis.culturalContext.dialect}
Horror Archetypes: ${(analysis.culturalContext.horrorArchetypes || []).join(", ")}
Traditions: ${(analysis.culturalContext.traditions || []).join(", ")}
Regional Flavour: ${analysis.culturalContext.regionalFlavour}

## SCENE BREAKDOWN (from analysis — expand into full screenplay)
${JSON.stringify(analysis.sceneBreakdown, null, 2)}

## PRODUCTION PLAN
Genre: ${analysis.productionPlan.genre}
Visual Style: ${analysis.productionPlan.visualStyle}
Color Palette: ${analysis.productionPlan.colorPalette}
Cinematography: ${analysis.productionPlan.cinematography}
Music Mood: ${analysis.productionPlan.musicMood}
Opening Hook: ${analysis.productionPlan.openingHook}
Climax: ${analysis.productionPlan.climax}
Resolution: ${analysis.productionPlan.resolution}

## VOICE DIRECTIONS
${JSON.stringify(analysis.voiceDirections, null, 2)}

## DIALOGUE STYLE
Natural Fillers: ${(analysis.dialogueStyle.naturalFiller || []).join(", ")}
Regional Expressions: ${(analysis.dialogueStyle.regionalExpressions || []).join(", ")}
Subtext: ${analysis.dialogueStyle.subtext}

Now write the complete Final Draft-style production screenplay.

## FINAL RULES REMINDER — MANDATORY ON EVERY SCENE:
1. 100% REAL — every frame must look like it was physically shot on location. No CGI sheen, no AI smoothness.
2. ZERO AI DETECTION — human imperfection in faces, voices, movement, and cuts. Asymmetry, breath, stumble, weight.
3. EMOTIONALLY DEVASTATING — every scene earns a specific, named feeling. Micro-beats carry more than dialogue. Silence is weaponized.
4. CINEMATIC QUALITY — motivated light, purposeful blocking, lens specificity, opening hook in 3 seconds, closing image earns the ending.

Every scene must have full camera directions, complete dialogue with parentheticals, lip sync notes, and emotion accuracy maps.
The screenplay must feel like it was shot by a human director and written by a human screenwriter — completely indistinguishable from a real production.
Total duration must be ${durationSeconds} seconds.

Return the complete screenplay JSON.`;
}
