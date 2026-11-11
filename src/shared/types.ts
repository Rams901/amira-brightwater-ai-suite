export type CallCategory = "repair" | "maintenance" | "quote" | "billing" | "other";

export type CallUrgency = "urgent" | "normal";

export type Weekday = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday";

export type SlotPeriod = "morning" | "afternoon";

export type CanonicalSlot = `${Weekday} ${SlotPeriod}`;

export type DetectedLanguage = "en" | "ar" | "mixed";

export type EngineMode = "hybrid" | "cascade" | "benchmark";

export type ExecutionProviderMode = "live" | "sandbox";

export type RecordStatus =
  | "booked"
  | "awaiting_slot_choice"
  | "escalated_urgent"
  | "forwarded_to_office"
  | "needs_review";

export type RoutingActionType =
  | "notify_on_call"
  | "book_slot"
  | "propose_nearest_slots"
  | "forward_office_queue"
  | "flag_needs_review"
  | "suppress_reply_unreachable"
  | "idempotent_skip";

export interface TranscriptTurn {
  speaker: "agent" | "caller";
  text: string;
}

export interface IncomingCall {
  call_id: string;
  received?: string;
  caller_id: string | null;
  duration_sec?: number;
  transcript: TranscriptTurn[];
}

export interface AvailabilitySlot {
  day: Weekday;
  period: SlotPeriod;
  status: "free" | "booked";
  booked_by_call_id?: string | null;
  booked_caller_name?: string | null;
  updated_at?: string | null;
}

export interface AvailabilitySchedule {
  note: string;
  slots: AvailabilitySlot[];
}

/**
 * Exact 11-field extraction schema specified in Challenge Part 1 (Page 3).
 */
export interface ExtractedCallData {
  call_id: string;
  caller_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  category: CallCategory[];
  urgency: CallUrgency;
  appointment_requested: boolean;
  preferred_slot: CanonicalSlot | null;
  summary: string;
  missing_fields: string[];
}

export interface ReplyDraft {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
  language: "en" | "ar";
  english_mirror?: string;
}

export interface OnCallAlert {
  alert_id: string;
  call_id: string;
  created_at: string;
  caller_name: string | null;
  phone: string | null;
  address: string | null;
  hazard_flags: string[];
  summary: string;
  language: DetectedLanguage;
}

export interface OfficeTicket {
  ticket_id: string;
  call_id: string;
  created_at: string;
  categories: CallCategory[];
  caller_name: string | null;
  contact: string | null;
  summary: string;
  linked_booking: CanonicalSlot | null;
}

export interface JevPrimitiveReadout {
  key: string;
  type: "noul" | "choice" | "score";
  label: string;
  value: number | string;
  confidence?: number;
  probabilities?: Record<string, number>;
  triggered?: boolean;
}

export interface SdeRuleCheck {
  rule: string;
  description: string;
  p_broken: number;
  fired: boolean;
}

export interface JevTelemetry {
  provider_mode: ExecutionProviderMode;
  model: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  primitives: JevPrimitiveReadout[];
  sde_checks: SdeRuleCheck[];
  request_payload_preview: Record<string, unknown>;
}

export interface DeepSeekTelemetry {
  provider_mode: ExecutionProviderMode;
  model: string;
  extraction_latency_ms: number;
  reply_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  json_repair_attempts: number;
  cascade_escalated: boolean;
}

export interface BenchmarkDiffItem {
  field: string;
  hybrid_value: string;
  cascade_value: string;
  matches: boolean;
}

export interface BenchmarkComparison {
  agreement_rate: number;
  hybrid_total_ms: number;
  cascade_total_ms: number;
  hybrid_cost_usd: number;
  cascade_cost_usd: number;
  cascade_escalated: boolean;
  cascade_fired_rules: string[];
  diffs: BenchmarkDiffItem[];
}

export interface ProcessedCallRecord {
  record_id: string;
  processed_at: string;
  total_processing_ms: number;
  engine_mode: EngineMode;
  language: DetectedLanguage;
  received: string | null;
  duration_sec: number | null;
  transcript_sha256: string;
  extracted: ExtractedCallData;
  status: RecordStatus;
  outcome_headline: string;
  routing_actions: RoutingActionType[];
  booked_slot: CanonicalSlot | null;
  proposed_slots: CanonicalSlot[];
  reply_draft: ReplyDraft | null;
  on_call_alert: OnCallAlert | null;
  office_ticket: OfficeTicket | null;
  jev_telemetry: JevTelemetry | null;
  deepseek_telemetry: DeepSeekTelemetry | null;
  benchmark_comparison: BenchmarkComparison | null;
  idempotent_replay: boolean;
  original_processed_at: string | null;
  error_isolated: string | null;
  raw_call: IncomingCall | Record<string, unknown>;
}

export type StreamStageEvent =
  | {
      type: "batch_start";
      batch_id: string;
      total_calls: number;
      engine_mode: EngineMode;
      provider_mode: ExecutionProviderMode;
    }
  | {
      type: "call_stage";
      batch_id: string;
      call_index: number;
      call_id: string;
      stage:
        | "idempotency_check"
        | "pre_parse"
        | "parallel_ai"
        | "routing_truth_table"
        | "reply_drafting"
        | "jev_verification"
        | "persisted";
      message: string;
    }
  | {
      type: "call_complete";
      batch_id: string;
      call_index: number;
      record: ProcessedCallRecord;
      availability: AvailabilitySchedule;
    }
  | {
      type: "batch_complete";
      batch_id: string;
      records: ProcessedCallRecord[];
      availability: AvailabilitySchedule;
      duration_ms: number;
    }
  | {
      type: "stream_error";
      message: string;
    };

export interface TestCaseAssertion {
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface TestCaseResult {
  test_id: string;
  title: string;
  language: "en" | "ar" | "bilingual";
  category_tag: string;
  description: string;
  passed: boolean;
  duration_ms: number;
  assertions: TestCaseAssertion[];
  record_snapshot?: ProcessedCallRecord;
}
