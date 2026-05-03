import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

export interface ProsodyHints {
  tone: string | null;
  pitch: "low" | "mid" | "high" | "rising" | "falling" | null;
  stress: string | null;
  syllables: string | null;
  nativeAccentNote: string | null;
}

export interface FlaggedWord {
  word: string;
  reason: string;
  suggestedPhonetic: string | null;
  confidence: number;
  prosody: ProsodyHints;
  hasUserCorrection: boolean;
  hasDictionaryEntry: boolean;
}

export interface PronunciationAnalysisResult {
  languageCode: string;
  region: string | null;
  wordCount: number;
  flaggedCount: number;
  overallConfidence: number;
  flaggedWords: FlaggedWord[];
  recommendation: string;
}

const SYSTEM_PROMPT = `You are an expert linguist and phonetician for a global, multi-language AI voice generation system.

Given a script in a specific language (and optional regional dialect), identify words or phrases where pronunciation is genuinely uncertain — proper nouns, foreign loanwords, ambiguous heteronyms, or culturally-sensitive terms whose mispronunciation would sound unnatural or robotic.

For each flagged word, return:
- word: the exact word/phrase as written in the script
- reason: a SHORT human-readable explanation (e.g. "Proper noun, regional pronunciation varies", "Heteronym - context-dependent stress", "Sanskrit loanword, retroflex consonants")
- suggestedPhonetic: an IPA-style phonetic transcription (or null if unknown)
- confidence: 0-100, how confident the AI is in its OWN pronunciation of this word
- prosody: an object with native-speaker delivery hints — { tone, pitch, stress, syllables, nativeAccentNote }
  - tone: short description of natural intonation, e.g. "neutral statement", "rising question", "warm/respectful" (or null)
  - pitch: ONE of "low" | "mid" | "high" | "rising" | "falling" (or null)
  - stress: which syllable(s) carry stress, e.g. "stress on 2nd syllable: gnoc-CHI", "primary stress on first syllable" (or null)
  - syllables: hyphen-separated breakdown, e.g. "WUR-stuh-shuhr" or "na-mas-TE" (or null)
  - nativeAccentNote: brief note on how a native speaker of this language/region would render it, e.g. "Italian double-c is hard /k/, never /tʃ/" (or null)

ALSO provide an overall confidence score (0-100) for the entire script and a short recommendation.

DO NOT flag common everyday words. Only flag words a native speaker might pronounce incorrectly without context.

Return STRICT JSON:
{
  "overallConfidence": number,
  "flaggedWords": [{
    "word": string,
    "reason": string,
    "suggestedPhonetic": string|null,
    "confidence": number,
    "prosody": {"tone": string|null, "pitch": string|null, "stress": string|null, "syllables": string|null, "nativeAccentNote": string|null}
  }],
  "recommendation": string
}`;

export async function analyzeScript(
  text: string,
  languageCode: string,
  region: string | null
): Promise<Omit<PronunciationAnalysisResult, "flaggedWords"> & { flaggedWords: Omit<FlaggedWord, "hasUserCorrection" | "hasDictionaryEntry">[] }> {
  const wordCount = text.trim().split(/\s+/).length;

  const userPrompt = `Language: ${languageCode}${region ? ` (region: ${region})` : ""}
Word count: ${wordCount}

SCRIPT:
${text.slice(0, 4000)}

Identify the words or phrases that need pronunciation review. Be selective — flag only what truly matters for natural human-like speech.`;

  logger.info({ languageCode, region, wordCount }, "Pronunciation Engine: starting analysis");

  let parsed: { overallConfidence?: number; flaggedWords?: unknown[]; recommendation?: string };

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 2000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn({ err: String(err) }, "Pronunciation Engine: AI analysis failed, returning empty result");
    parsed = { overallConfidence: 80, flaggedWords: [], recommendation: "AI analysis temporarily unavailable. Voice generation will proceed with standard accent rules." };
  }

  const VALID_PITCH = ["low", "mid", "high", "rising", "falling"] as const;
  type ValidPitch = (typeof VALID_PITCH)[number];

  function pickProsody(p: unknown): ProsodyHints {
    const rec = (typeof p === "object" && p !== null) ? (p as Record<string, unknown>) : {};
    const pitchVal = typeof rec.pitch === "string" && (VALID_PITCH as readonly string[]).includes(rec.pitch)
      ? (rec.pitch as ValidPitch)
      : null;
    return {
      tone: typeof rec.tone === "string" && rec.tone.length <= 200 ? rec.tone : null,
      pitch: pitchVal,
      stress: typeof rec.stress === "string" && rec.stress.length <= 200 ? rec.stress : null,
      syllables: typeof rec.syllables === "string" && rec.syllables.length <= 200 ? rec.syllables : null,
      nativeAccentNote: typeof rec.nativeAccentNote === "string" && rec.nativeAccentNote.length <= 500 ? rec.nativeAccentNote : null,
    };
  }

  const flaggedRaw = Array.isArray(parsed.flaggedWords) ? parsed.flaggedWords : [];
  const flaggedWords = flaggedRaw
    .filter((w): w is { word: string; reason?: string; suggestedPhonetic?: string | null; confidence?: number; prosody?: unknown } =>
      typeof w === "object" && w !== null && typeof (w as { word?: unknown }).word === "string"
    )
    .map((w) => ({
      word: w.word,
      reason: typeof w.reason === "string" ? w.reason : "Pronunciation review recommended",
      suggestedPhonetic: typeof w.suggestedPhonetic === "string" ? w.suggestedPhonetic : null,
      confidence: typeof w.confidence === "number" ? Math.max(0, Math.min(100, Math.round(w.confidence))) : 70,
      prosody: pickProsody(w.prosody),
    }));

  const overallConfidence = typeof parsed.overallConfidence === "number"
    ? Math.max(0, Math.min(100, Math.round(parsed.overallConfidence)))
    : 80;

  const recommendation = typeof parsed.recommendation === "string"
    ? parsed.recommendation
    : flaggedWords.length === 0
      ? "Script is clear. Voice generation can proceed with high confidence."
      : `Review ${flaggedWords.length} word(s) before voice generation. You can upload your own pronunciation for any of them.`;

  logger.info(
    { languageCode, flaggedCount: flaggedWords.length, overallConfidence },
    "Pronunciation Engine: analysis complete"
  );

  return {
    languageCode,
    region,
    wordCount,
    flaggedCount: flaggedWords.length,
    overallConfidence,
    flaggedWords,
    recommendation,
  };
}
