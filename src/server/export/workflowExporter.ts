import type {
  AvailabilitySchedule,
  ProcessedCallRecord,
} from "../../shared/types.js";

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = typeof val === "string" ? val : JSON.stringify(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportRecordsToCsv(records: ProcessedCallRecord[]): string {
  const headers = [
    "call_id",
    "processed_at",
    "language",
    "status",
    "outcome_headline",
    "caller_name",
    "phone",
    "email",
    "address",
    "category",
    "urgency",
    "appointment_requested",
    "preferred_slot",
    "booked_slot",
    "proposed_slots",
    "missing_fields",
    "summary",
    "reply_channel",
    "reply_body",
    "idempotent_replay",
  ];

  const lines = [headers.join(",")];
  for (const r of records) {
    const row = [
      r.extracted.call_id,
      r.processed_at,
      r.language,
      r.status,
      r.outcome_headline,
      r.extracted.caller_name ?? "",
      r.extracted.phone ?? "",
      r.extracted.email ?? "",
      r.extracted.address ?? "",
      r.extracted.category.join("|"),
      r.extracted.urgency,
      String(r.extracted.appointment_requested),
      r.extracted.preferred_slot ?? "",
      r.booked_slot ?? "",
      r.proposed_slots.join("|"),
      r.extracted.missing_fields.join("|"),
      r.extracted.summary,
      r.reply_draft?.channel ?? "",
      r.reply_draft?.body ?? "",
      String(r.idempotent_replay),
    ];
    lines.push(row.map(escapeCsvCell).join(","));
  }

  // Prepend UTF-8 BOM so Excel / Numbers opens Arabic text cleanly without mojibake
  return `\uFEFF${lines.join("\n")}`;
}

/**
 * Exports a portable workflow blueprint JSON (Submission Item #1: "Your workflow as an export file")
 * documenting every node, contract, Jev System-One question, DeepSeek prompt, and routing branch,
 * plus an n8n-importable graph representation.
 */
export function buildWorkflowBlueprintExport(params: {
  availability: AvailabilitySchedule;
  records: ProcessedCallRecord[];
}) {
  return {
    name: "Amira Brightwater — Hybrid Jev + DeepSeek V4.1 Call-to-Outcome Workflow",
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    architecture: "Hybrid System-One (TypeSafe Jev jev-1.14.0) + System-Two (DeepSeek V4.1 Flash deepseek-flash) + Deterministic TypeScript Truth Table",
    languages_supported: ["en", "ar"],
    nodes: [
      {
        id: "1_webhook_and_file_gate",
        name: "Restricted File Gate & Single-Call Webhook",
        type: "trigger.webhook_or_json_upload",
        parameters: {
          allowedExtensions: [".json"],
          maxBytes: 2097152,
          endpoints: ["POST /api/webhooks/call", "POST /api/upload/validate", "POST /api/runs/stream"],
        },
      },
      {
        id: "2_sqlite_idempotency_lock",
        name: "SQLite Idempotency & Replay Deduplication",
        type: "code.sqlite_ledger",
        parameters: {
          key: "(call_id, transcript_sha256)",
          onDuplicate: "return_cached_outcome_without_rebooking",
        },
      },
      {
        id: "3_bilingual_pre_parser",
        name: "Bilingual Regex Pre-Parser (EN + AR)",
        type: "code.pre_parser",
        parameters: {
          normalizesEasternArabicDigits: true,
          extractsVerbatimPhonesAndEmails: true,
        },
      },
      {
        id: "4a_typesafe_jev_system_one",
        name: "TypeSafe Jev Parallel Intake (14 Primitives)",
        type: "ai.typesafe.systemOne",
        parameters: {
          endpoint: "https://api.typesafe.ai/v1/systemone",
          model: "jev-1.14.0",
          primitives: [
            "cat_repair (noul)",
            "cat_maintenance (noul)",
            "cat_quote (noul)",
            "cat_billing (noul)",
            "urg_hazard (noul)",
            "urg_no_heat (noul)",
            "urg_oncall (noul)",
            "urg_severity (score)",
            "appt_requested (noul)",
            "has_preferred_slot (noul)",
            "pref_day (choice)",
            "pref_period (choice)",
            "phone_reachable (noul)",
            "call_dropped (noul)",
          ],
        },
      },
      {
        id: "4b_deepseek_flash_spans",
        name: "DeepSeek V4.1 Flash Span & Summary Extractor",
        type: "ai.deepseek.chatCompletions",
        parameters: {
          endpoint: "https://api.deepseek.com/chat/completions",
          model: "deepseek-flash",
          fields: ["caller_name", "address", "summary (<= 2 sentences)"],
          jsonRepairRetry: 1,
        },
      },
      {
        id: "5_deterministic_truth_table",
        name: "Deterministic Validation, Routing & Nearest-2-Slots Engine",
        type: "code.truth_table_router",
        parameters: {
          rules: [
            "Urgent -> Immediate On-Call Alert, NEVER book regular slot",
            "Unreachable (!phone && !email) -> status=needs_review, reply_draft=null",
            "Missing required fields -> status=needs_review, list missing_fields",
            "Normal + slot free -> Book slot in availability copy + confirm",
            "Normal + slot booked -> Propose 2 chronologically nearest free slots without booking",
            "Category includes quote or billing -> Forward summary to Office Queue",
          ],
        },
      },
      {
        id: "6_deepseek_grounded_reply",
        name: "DeepSeek V4.1 Flash Bilingual Reply Drafter (EN / AR)",
        type: "ai.deepseek.chatCompletions",
        parameters: {
          model: "deepseek-flash",
          channels: ["email", "sms"],
          arabicIncludesEnglishOperatorMirror: true,
        },
      },
      {
        id: "7_jev_sde_verifier",
        name: "TypeSafe Jev SDE Reply Verifier",
        type: "ai.typesafe.systemOne",
        parameters: {
          fireThreshold: 0.7,
          rules: [
            "hallucinates_booking",
            "quotes_unauthorized_price",
            "misses_secondary_topic",
            "wrong_language",
          ],
        },
      },
    ],
    connections: [
      { from: "1_webhook_and_file_gate", to: "2_sqlite_idempotency_lock" },
      { from: "2_sqlite_idempotency_lock", to: "3_bilingual_pre_parser" },
      { from: "3_bilingual_pre_parser", to: "4a_typesafe_jev_system_one" },
      { from: "3_bilingual_pre_parser", to: "4b_deepseek_flash_spans" },
      { from: "4a_typesafe_jev_system_one", to: "5_deterministic_truth_table" },
      { from: "4b_deepseek_flash_spans", to: "5_deterministic_truth_table" },
      { from: "5_deterministic_truth_table", to: "6_deepseek_grounded_reply" },
      { from: "6_deepseek_grounded_reply", to: "7_jev_sde_verifier" },
    ],
    latest_state_snapshot: {
      availability: params.availability,
      processed_record_count: params.records.length,
      records: params.records,
    },
  };
}
