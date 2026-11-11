import { z } from "zod";
import type { CanonicalSlot, SlotPeriod, Weekday } from "./types.js";

export const WEEKDAYS: readonly Weekday[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
] as const;

export const SLOT_PERIODS: readonly SlotPeriod[] = ["morning", "afternoon"] as const;

export const ALL_CANONICAL_SLOTS: readonly CanonicalSlot[] = [
  "Monday morning",
  "Monday afternoon",
  "Tuesday morning",
  "Tuesday afternoon",
  "Wednesday morning",
  "Wednesday afternoon",
  "Thursday morning",
  "Thursday afternoon",
  "Friday morning",
  "Friday afternoon",
] as const;

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB strict ceiling
export const MAX_BATCH_CALLS = 100;

const SpeakerSchema = z
  .string()
  .transform((val): "agent" | "caller" => {
    const v = val.trim().toLowerCase();
    if (
      v === "agent" ||
      v === "lena" ||
      v === "assistant" ||
      v === "لينا" ||
      v === "الموظفة" ||
      v === "المساعدة"
    ) {
      return "agent";
    }
    return "caller";
  });

export const TranscriptTurnSchema = z.object({
  speaker: SpeakerSchema,
  text: z.string(),
});

export const IncomingCallSchema = z.object({
  call_id: z.string().min(1, "call_id must be a non-empty string"),
  received: z.string().optional(),
  caller_id: z.string().nullable().default(null),
  duration_sec: z.number().nonnegative().optional(),
  transcript: z.array(TranscriptTurnSchema).min(1, "transcript must contain at least 1 turn"),
});

export const AvailabilitySlotSchema = z.object({
  day: z.enum(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]),
  period: z.enum(["morning", "afternoon"]),
  status: z.enum(["free", "booked"]),
  booked_by_call_id: z.string().nullable().optional(),
  booked_caller_name: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

export const AvailabilityScheduleSchema = z.object({
  note: z.string().default("Regular slots only. Urgent cases go to the on-call team."),
  slots: z.array(AvailabilitySlotSchema).min(1, "availability slots array must not be empty"),
});

export const ExtractedCallDataSchema = z.object({
  call_id: z.string().min(1),
  caller_name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  category: z
    .array(z.enum(["repair", "maintenance", "quote", "billing", "other"]))
    .min(1),
  urgency: z.enum(["urgent", "normal"]),
  appointment_requested: z.boolean(),
  preferred_slot: z
    .enum([
      "Monday morning",
      "Monday afternoon",
      "Tuesday morning",
      "Tuesday afternoon",
      "Wednesday morning",
      "Wednesday afternoon",
      "Thursday morning",
      "Thursday afternoon",
      "Friday morning",
      "Friday afternoon",
    ])
    .nullable(),
  summary: z.string().min(1),
  missing_fields: z.array(z.string()),
});

export const DeepSeekSpanExtractionSchema = z.object({
  caller_name: z.string().nullable(),
  address: z.string().nullable(),
  summary: z.string().min(1),
});

export const DeepSeekFullCascadeSchema = z.object({
  caller_name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  category: z
    .array(z.enum(["repair", "maintenance", "quote", "billing", "other"]))
    .min(1),
  urgency: z.enum(["urgent", "normal"]),
  appointment_requested: z.boolean(),
  preferred_slot: z.string().nullable(),
  summary: z.string().min(1),
});

export interface FileGateValidationResult {
  valid: boolean;
  detectedKind: "calls_batch" | "single_call" | "availability" | "invalid";
  error?: string;
  warnings: string[];
  parsedCalls?: unknown[];
  parsedAvailability?: z.infer<typeof AvailabilityScheduleSchema>;
  itemDiagnostics?: Array<{
    index: number;
    call_id: string;
    valid: boolean;
    issue?: string;
  }>;
}

const FORBIDDEN_BINARY_HEADERS = [
  "%PDF-",
  "PK\x03\x04",
  "\x89PNG",
  "GIF89a",
  "<!DOCTYPE html",
  "<html",
];

/**
 * Multi-layer restricted file validator shared by React client preview & Express upload gate.
 * Enforces: .json extension, <= 2MB size, no null-byte / binary spoofing, valid JSON,
 * and structural match against Call Transcript(s) or Availability Schedule.
 */
export function validateRestrictedJsonInput(params: {
  fileName: string;
  mimeType?: string;
  byteLength: number;
  rawText: string;
  expectedTarget?: "calls" | "availability" | "either";
}): FileGateValidationResult {
  const { fileName, mimeType, byteLength, rawText, expectedTarget = "either" } = params;
  const warnings: string[] = [];

  if (!fileName.toLowerCase().endsWith(".json")) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: `Restricted file type rejected: "${fileName}". Only strict .json files are allowed.`,
      warnings,
    };
  }

  if (
    mimeType &&
    mimeType.trim() !== "" &&
    !["application/json", "text/json", "application/x-json", "text/plain"].includes(
      mimeType.split(";")[0].trim().toLowerCase()
    )
  ) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: `Disallowed MIME type "${mimeType}". Expected application/json.`,
      warnings,
    };
  }

  if (byteLength <= 0) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: "Uploaded file is empty (0 bytes).",
      warnings,
    };
  }

  if (byteLength > MAX_UPLOAD_BYTES) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: `File exceeds 2.0 MB security limit (${(byteLength / (1024 * 1024)).toFixed(2)} MB).`,
      warnings,
    };
  }

  if (rawText.includes("\u0000")) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: "Security gate blocked binary null-byte payload disguised as .json.",
      warnings,
    };
  }

  const trimmedStart = rawText.trimStart().slice(0, 32);
  for (const sig of FORBIDDEN_BINARY_HEADERS) {
    if (trimmedStart.startsWith(sig)) {
      return {
        valid: false,
        detectedKind: "invalid",
        error: `Security gate detected non-JSON magic signature (${sig.slice(0, 6)}) inside .json upload.`,
        warnings,
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: `Malformed JSON syntax: ${err instanceof Error ? err.message : String(err)}`,
      warnings,
    };
  }

  // Case 1: Availability Schedule object ({ slots: [...] })
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "slots" in (parsed as Record<string, unknown>)
  ) {
    if (expectedTarget === "calls") {
      return {
        valid: false,
        detectedKind: "availability",
        error:
          "This file matches availability.json (technician schedule), not a call transcript payload. Upload it in the Availability slot.",
        warnings,
      };
    }
    const availCheck = AvailabilityScheduleSchema.safeParse(parsed);
    if (!availCheck.success) {
      return {
        valid: false,
        detectedKind: "invalid",
        error: `Invalid availability.json structure: ${availCheck.error.issues[0]?.message ?? "schema mismatch"}`,
        warnings,
      };
    }
    return {
      valid: true,
      detectedKind: "availability",
      warnings,
      parsedAvailability: availCheck.data,
    };
  }

  // Case 2: Array of calls OR single call object
  if (expectedTarget === "availability") {
    return {
      valid: false,
      detectedKind: "invalid",
      error: "Expected an availability.json object containing a `slots` array.",
      warnings,
    };
  }

  const candidateItems: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && ("call_id" in parsed || "transcript" in parsed)
      ? [parsed]
      : [];

  if (candidateItems.length === 0) {
    return {
      valid: false,
      detectedKind: "invalid",
      error:
        "JSON payload does not match Brightwater Call Transcript schema (`call_id` + `transcript[]`) or `availability.json` (`slots[]`).",
      warnings,
    };
  }

  if (candidateItems.length > MAX_BATCH_CALLS) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: `Batch contains ${candidateItems.length} calls (maximum allowed per upload is ${MAX_BATCH_CALLS}).`,
      warnings,
    };
  }

  const diagnostics = candidateItems.map((item, index) => {
    const res = IncomingCallSchema.safeParse(item);
    const rawId =
      item &&
      typeof item === "object" &&
      typeof (item as Record<string, unknown>).call_id === "string"
        ? String((item as Record<string, unknown>).call_id)
        : `ITEM-${index + 1}`;

    if (!res.success) {
      const msg = res.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`).join("; ");
      warnings.push(`Call #${index + 1} (${rawId}) has structural issues (${msg}) — will be isolated safely to needs_review without stopping batch.`);
      return {
        index,
        call_id: rawId,
        valid: false,
        issue: msg,
      };
    }
    return {
      index,
      call_id: res.data.call_id,
      valid: true,
    };
  });

  // Require at least one call-like object in the upload so arbitrary JSON arrays (e.g. [1,2,3]) are rejected
  const hasAnyCallLike = candidateItems.some(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      ("call_id" in (item as Record<string, unknown>) ||
        "transcript" in (item as Record<string, unknown>))
  );

  if (!hasAnyCallLike) {
    return {
      valid: false,
      detectedKind: "invalid",
      error: "JSON array contains no call transcript objects (`call_id` / `transcript`).",
      warnings: [],
    };
  }

  return {
    valid: true,
    detectedKind: Array.isArray(parsed) ? "calls_batch" : "single_call",
    warnings,
    parsedCalls: candidateItems,
    itemDiagnostics: diagnostics,
  };
}
