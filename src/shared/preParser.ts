import type {
  CanonicalSlot,
  DetectedLanguage,
  IncomingCall,
  SlotPeriod,
  Weekday,
} from "./types.js";
import { ALL_CANONICAL_SLOTS } from "./schemas.js";

/**
 * Normalize Eastern Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits
 * into standard ASCII digits (0-9) for reliable phone & invoice extraction.
 */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+|00)?\d[\d\s().-]{6,18}\d/g;
const ARABIC_CHAR_RE = /[\u0600-\u06FF]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

export interface PreParsedCandidates {
  language: DetectedLanguage;
  caller_id_normalized: string | null;
  spoken_phones: string[];
  all_candidate_phones: string[];
  candidate_emails: string[];
  formatted_transcript: string;
  caller_only_text: string;
  appear_dropped: boolean;
}

export function detectTranscriptLanguage(text: string): DetectedLanguage {
  const arabicMatches = text.match(ARABIC_CHAR_RE)?.length ?? 0;
  const latinMatches = text.match(LATIN_CHAR_RE)?.length ?? 0;
  if (arabicMatches === 0) return "en";
  if (latinMatches === 0 || arabicMatches / (arabicMatches + latinMatches) >= 0.35) {
    return arabicMatches > 0 && latinMatches > arabicMatches * 1.4 ? "mixed" : "ar";
  }
  return arabicMatches >= 12 ? "mixed" : "en";
}

function cleanPhoneSpan(raw: string): string {
  return normalizeDigits(raw)
    .replace(/[^\d+\s()-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function preParseCall(call: IncomingCall): PreParsedCandidates {
  const fullTextRaw = call.transcript.map((t) => t.text).join("\n");
  const callerTextRaw = call.transcript
    .filter((t) => t.speaker === "caller")
    .map((t) => t.text)
    .join("\n");

  const language = detectTranscriptLanguage(callerTextRaw || fullTextRaw);
  const normalizedCallerText = normalizeDigits(callerTextRaw);
  const normalizedFullText = normalizeDigits(fullTextRaw);

  const callerIdNorm =
    call.caller_id && call.caller_id.trim().length > 0
      ? cleanPhoneSpan(call.caller_id)
      : null;

  const spokenPhonesSet = new Set<string>();
  for (const match of normalizedCallerText.matchAll(PHONE_RE)) {
    const cleaned = cleanPhoneSpan(match[0]);
    const digitCount = cleaned.replace(/\D/g, "").length;
    if (digitCount >= 7 && digitCount <= 16) {
      spokenPhonesSet.add(cleaned);
    }
  }
  const spokenPhones = Array.from(spokenPhonesSet);

  const allPhonesSet = new Set<string>();
  if (callerIdNorm) allPhonesSet.add(callerIdNorm);
  for (const p of spokenPhones) allPhonesSet.add(p);

  const emailsSet = new Set<string>();
  for (const match of normalizedFullText.matchAll(EMAIL_RE)) {
    emailsSet.add(match[0].trim().toLowerCase());
  }

  const lastTurn = call.transcript[call.transcript.length - 1];
  const lastText = lastTurn?.text.trim() ?? "";
  const appearDropped =
    lastTurn?.speaker === "caller" &&
    (/\.\.\.\s*$/.test(lastText) ||
      /(?:i'll|i have to go|sorry, i|لازم أسكر|مضطر أقفل|لحظة|ألو\s*$)/i.test(lastText) ||
      (!/[.!?؟۔]$/.test(lastText) && (call.duration_sec ?? 999) < 55));

  const formattedTranscript = call.transcript
    .map((t, idx) => `[Turn ${idx + 1} - ${t.speaker.toUpperCase()}]: ${t.text}`)
    .join("\n");

  return {
    language,
    caller_id_normalized: callerIdNorm,
    spoken_phones: spokenPhones,
    all_candidate_phones: Array.from(allPhonesSet),
    candidate_emails: Array.from(emailsSet),
    formatted_transcript: formattedTranscript,
    caller_only_text: callerTextRaw,
    appear_dropped: appearDropped,
  };
}

/**
 * Guarantee the challenge constraint: `summary` is at most two sentences.
 * Handles both English (. ! ?) and Arabic (۔ ؟ ! .) sentence terminators.
 */
export function clampTwoSentences(rawSummary: string): string {
  const cleaned = rawSummary.replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const sentences = cleaned
    .split(/(?<=[.!?؟۔])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length <= 2) {
    return cleaned;
  }
  return `${sentences[0]} ${sentences[1]}`.trim();
}

const ARABIC_DAY_MAP: Record<string, Weekday> = {
  الاثنين: "Monday",
  الإثنين: "Monday",
  الثلاثاء: "Tuesday",
  الأربعاء: "Wednesday",
  الاربعاء: "Wednesday",
  الخميس: "Thursday",
  الجمعة: "Friday",
  الجمعه: "Friday",
};

export const ARABIC_SLOT_LABELS: Record<CanonicalSlot, string> = {
  "Monday morning": "صباح الاثنين",
  "Monday afternoon": "بعد ظهر الاثنين",
  "Tuesday morning": "صباح الثلاثاء",
  "Tuesday afternoon": "بعد ظهر الثلاثاء",
  "Wednesday morning": "صباح الأربعاء",
  "Wednesday afternoon": "بعد ظهر الأربعاء",
  "Thursday morning": "صباح الخميس",
  "Thursday afternoon": "بعد ظهر الخميس",
  "Friday morning": "صباح الجمعة",
  "Friday afternoon": "بعد ظهر الجمعة",
};

export function formatSlotForLanguage(slot: CanonicalSlot, lang: "en" | "ar"): string {
  return lang === "ar" ? ARABIC_SLOT_LABELS[slot] : slot;
}

/**
 * Normalizes a free-form slot string (English or Arabic) into one of the 10 canonical
 * weekday+period slots, or null if not mappable.
 */
export function normalizeCanonicalSlot(raw: string | null | undefined): CanonicalSlot | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if ((ALL_CANONICAL_SLOTS as readonly string[]).includes(trimmed)) {
    return trimmed as CanonicalSlot;
  }

  const lower = trimmed.toLowerCase();
  let matchedDay: Weekday | null = null;
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"] as const) {
    if (lower.includes(day.toLowerCase())) {
      matchedDay = day;
      break;
    }
  }
  if (!matchedDay) {
    for (const [arDay, enDay] of Object.entries(ARABIC_DAY_MAP)) {
      if (trimmed.includes(arDay)) {
        matchedDay = enDay;
        break;
      }
    }
  }

  let matchedPeriod: SlotPeriod | null = null;
  if (
    lower.includes("morning") ||
    lower.includes("am") ||
    /صباح|الصبح|صباحاً|صباحا/.test(trimmed)
  ) {
    matchedPeriod = "morning";
  } else if (
    lower.includes("afternoon") ||
    lower.includes("pm") ||
    /ظهر|مساء|العصر|بعد الظهر/.test(trimmed)
  ) {
    matchedPeriod = "afternoon";
  }

  if (matchedDay && matchedPeriod) {
    return `${matchedDay} ${matchedPeriod}`;
  }
  return null;
}
