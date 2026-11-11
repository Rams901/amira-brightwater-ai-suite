import crypto from "node:crypto";
import type {
  AvailabilitySchedule,
  BenchmarkComparison,
  BenchmarkDiffItem,
  EngineMode,
  ExtractedCallData,
  IncomingCall,
  JevTelemetry,
  ProcessedCallRecord,
  ReplyDraft,
  StreamStageEvent,
} from "../../shared/types.js";
import {
  ExtractedCallDataSchema,
  IncomingCallSchema,
} from "../../shared/schemas.js";
import { preParseCall } from "../../shared/preParser.js";
import {
  evaluateIntakeWithJev,
  verifyCascadeExtractionWithJev,
  verifyReplyWithJevSde,
} from "../ai/jevQuestions.js";
import {
  buildDeepSeekTelemetry,
  buildGroundedTemplateReply,
  draftReplyWithDeepSeek,
  extractFullCascadeWithDeepSeek,
  extractSpansWithDeepSeek,
  type DeepSeekMockFaultOptions,
} from "../ai/deepseekClient.js";
import { getRedactedAiStatus } from "../ai/runtimeConfig.js";
import { hashCallPayload, type LedgerStore } from "../db/ledgerStore.js";
import {
  computeMissingFields,
  executeRoutingTruthTable,
} from "./router.js";

export interface ProcessBatchOptions {
  engineMode?: EngineMode;
  store: LedgerStore;
  onEvent?: (event: StreamStageEvent) => void;
  faultByCallId?: Record<string, DeepSeekMockFaultOptions>;
  bypassIdempotency?: boolean;
  resetBeforeRun?: boolean;
}

/**
 * Processes an incoming batch of calls sequentially (`1 -> N`):
 * - When `resetBeforeRun: true` (default for new `.json` file runs in the Studio), resets
 *   the ledger and `availability.json` to the clean baseline so files never stack on top of
 *   each other.
 * - When `resetBeforeRun: false` (e.g. `POST /api/webhooks/call` or duplicate replay tests),
 *   enforces `(call_id, transcript_sha256, engine_mode)` idempotency so duplicate deliveries
 *   never create a second booking (Bonus #2).
 * - Per-call fault isolation ensures a broken call never aborts subsequent calls.
 */
export async function processCallBatch(
  rawCalls: unknown[],
  options: ProcessBatchOptions
): Promise<{
  records: ProcessedCallRecord[];
  availability: AvailabilitySchedule;
  durationMs: number;
}> {
  if (options.resetBeforeRun) {
    options.store.resetToBaseline();
  }

  const batchId = `BATCH-${crypto.randomUUID().slice(0, 8)}`;
  const engineMode: EngineMode = options.engineMode ?? "hybrid";
  const aiStatus = getRedactedAiStatus();
  const batchStartMs = performance.now();

  options.onEvent?.({
    type: "batch_start",
    batch_id: batchId,
    total_calls: rawCalls.length,
    engine_mode: engineMode,
    provider_mode: aiStatus.effectiveMode,
  });

  const records: ProcessedCallRecord[] = [];

  for (let i = 0; i < rawCalls.length; i++) {
    const rawItem = rawCalls[i];
    const callT0 = performance.now();
    const fallbackCallId =
      rawItem &&
      typeof rawItem === "object" &&
      typeof (rawItem as Record<string, unknown>).call_id === "string" &&
      (rawItem as Record<string, unknown>).call_id
        ? String((rawItem as Record<string, unknown>).call_id)
        : `MALFORMED-${i + 1}`;

    try {
      const record = await processSingleCallItem({
        rawItem,
        callIndex: i,
        batchId,
        engineMode,
        store: options.store,
        onEvent: options.onEvent,
        faultOpts: options.faultByCallId?.[fallbackCallId],
        bypassIdempotency: options.bypassIdempotency,
      });
      records.push(record);

      options.onEvent?.({
        type: "call_complete",
        batch_id: batchId,
        call_index: i,
        record,
        availability: options.store.getAvailability(),
      });
    } catch (unexpectedErr) {
      const errMessage =
        unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr);
      const isolatedRecord = createIsolatedFailureRecord({
        callId: fallbackCallId,
        rawItem,
        engineMode,
        errorMessage: errMessage,
        elapsedMs: Math.max(1, Math.round(performance.now() - callT0)),
      });
      options.store.upsertRecord(isolatedRecord);
      records.push(isolatedRecord);

      options.onEvent?.({
        type: "call_complete",
        batch_id: batchId,
        call_index: i,
        record: isolatedRecord,
        availability: options.store.getAvailability(),
      });
    }
  }

  const finalAvailability = options.store.getAvailability();
  const durationMs = Math.max(1, Math.round(performance.now() - batchStartMs));

  options.onEvent?.({
    type: "batch_complete",
    batch_id: batchId,
    records,
    availability: finalAvailability,
    duration_ms: durationMs,
  });

  return { records, availability: finalAvailability, durationMs };
}

async function processSingleCallItem(params: {
  rawItem: unknown;
  callIndex: number;
  batchId: string;
  engineMode: EngineMode;
  store: LedgerStore;
  onEvent?: (event: StreamStageEvent) => void;
  faultOpts?: DeepSeekMockFaultOptions;
  bypassIdempotency?: boolean;
}): Promise<ProcessedCallRecord> {
  const callStartMs = performance.now();
  const { rawItem, callIndex, batchId, engineMode, store, onEvent, faultOpts } = params;

  const parsedInput = IncomingCallSchema.safeParse(rawItem);
  if (!parsedInput.success) {
    const rawId =
      rawItem &&
      typeof rawItem === "object" &&
      typeof (rawItem as Record<string, unknown>).call_id === "string"
        ? String((rawItem as Record<string, unknown>).call_id)
        : `INVALID-CALL-${callIndex + 1}`;
    throw new Error(
      `Invalid input call schema for ${rawId}: ${parsedInput.error.issues
        .map((iss) => `${iss.path.join(".")}: ${iss.message}`)
        .join("; ")}`
    );
  }

  const call: IncomingCall = parsedInput.data;
  const payloadHash = hashCallPayload(call);

  // Stage 1: Idempotency Check (only intercepts if same call_id AND same engine_mode)
  onEvent?.({
    type: "call_stage",
    batch_id: batchId,
    call_index: callIndex,
    call_id: call.call_id,
    stage: "idempotency_check",
    message: `Checking idempotency ledger for ${call.call_id}...`,
  });

  if (!params.bypassIdempotency) {
    const existing = store.getRecordByCallId(call.call_id);
    if (existing) {
      if (existing.transcript_sha256 === payloadHash && existing.engine_mode === engineMode) {
        return {
          ...existing,
          total_processing_ms: Math.max(1, Math.round(performance.now() - callStartMs)),
          idempotent_replay: true,
          original_processed_at: existing.original_processed_at ?? existing.processed_at,
          outcome_headline: `Idempotent Replay Blocked — Reused original outcome (${existing.status}) without duplicate booking`,
          routing_actions: existing.routing_actions.includes("idempotent_skip")
            ? existing.routing_actions
            : [...existing.routing_actions, "idempotent_skip"],
        };
      }
      if (existing.transcript_sha256 !== payloadHash) {
        throw new Error(
          `Idempotency conflict: call_id ${call.call_id} already exists with a different transcript SHA-256.`
        );
      }
    }
  }

  // Stage 2: Bilingual Pre-Parser
  onEvent?.({
    type: "call_stage",
    batch_id: batchId,
    call_index: callIndex,
    call_id: call.call_id,
    stage: "pre_parse",
    message: "Pre-parsing phone/email regex spans & script...",
  });
  const candidates = preParseCall(call);

  // Stage 3: Execute selected AI Engine Strategy
  onEvent?.({
    type: "call_stage",
    batch_id: batchId,
    call_index: callIndex,
    call_id: call.call_id,
    stage: "parallel_ai",
    message:
      engineMode === "cascade"
        ? "SDE Cascade: DeepSeek Rung 0 -> Jev Verifier -> [Thinking if flagged]..."
        : engineMode === "benchmark"
          ? "Benchmark Diff: Running Hybrid Symphony & SDE Cascade side-by-side..."
          : "Hybrid Symphony: Running Jev (14 primitives) + DeepSeek Flash concurrently...",
  });

  let extractedCore: Omit<ExtractedCallData, "missing_fields">;
  let hazardFlags: string[] = [];
  let jevTelemetry: JevTelemetry | null = null;
  let deepseekExtractMeta = {
    providerMode: "sandbox" as "live" | "sandbox",
    model: "deepseek-flash",
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    repairAttempts: 0,
    cascadeEscalated: false,
  };
  let benchmarkComparison: BenchmarkComparison | null = null;

  if (engineMode === "hybrid") {
    const hybridRes = await runHybridExtraction(call, candidates, faultOpts);
    extractedCore = hybridRes.extractedCore;
    hazardFlags = hybridRes.hazardFlags;
    jevTelemetry = hybridRes.jevTelemetry;
    deepseekExtractMeta = hybridRes.deepseekMeta;
  } else if (engineMode === "cascade") {
    const cascadeRes = await runCascadeExtraction(call, candidates, faultOpts);
    extractedCore = cascadeRes.extractedCore;
    hazardFlags = cascadeRes.hazardFlags;
    jevTelemetry = cascadeRes.jevTelemetry;
    deepseekExtractMeta = cascadeRes.deepseekMeta;
  } else {
    const [hybridRes, cascadeRes] = await Promise.all([
      runHybridExtraction(call, candidates, faultOpts),
      runCascadeExtraction(call, candidates, faultOpts),
    ]);
    extractedCore = hybridRes.extractedCore;
    hazardFlags = hybridRes.hazardFlags;
    jevTelemetry = hybridRes.jevTelemetry;
    deepseekExtractMeta = hybridRes.deepseekMeta;
    benchmarkComparison = buildBenchmarkComparison(hybridRes, cascadeRes);
  }

  // Stage 4: Contextual Validation + Deterministic Routing Truth Table
  onEvent?.({
    type: "call_stage",
    batch_id: batchId,
    call_index: callIndex,
    call_id: call.call_id,
    stage: "routing_truth_table",
    message: "Applying validation & technician slot truth table...",
  });

  const missingFields = computeMissingFields({
    callerName: extractedCore.caller_name,
    phone: extractedCore.phone,
    email: extractedCore.email,
    address: extractedCore.address,
    category: extractedCore.category,
    urgency: extractedCore.urgency,
    appointmentRequested: extractedCore.appointment_requested,
    preferredSlot: extractedCore.preferred_slot,
  });

  const extracted: ExtractedCallData = ExtractedCallDataSchema.parse({
    ...extractedCore,
    missing_fields: missingFields,
  });

  const currentAvailability = store.getAvailability();
  const routeOutcome = executeRoutingTruthTable({
    extracted,
    language: candidates.language,
    hazardFlags,
    currentAvailability,
  });

  if (routeOutcome.bookedSlot) {
    store.saveAvailability(routeOutcome.nextAvailability);
  }

  // Stage 5 & 6: Reply Drafting + Jev SDE Reply Verification
  let replyDraft: ReplyDraft | null = null;
  let replyLatencyMs = 0;
  let replyInTokens = 0;
  let replyOutTokens = 0;

  const replyLang: "en" | "ar" = candidates.language === "ar" ? "ar" : "en";

  if (routeOutcome.shouldDraftReply) {
    onEvent?.({
      type: "call_stage",
      batch_id: batchId,
      call_index: callIndex,
      call_id: call.call_id,
      stage: "reply_drafting",
      message: `Drafting ${replyLang === "ar" ? "Arabic" : "English"} reply via DeepSeek Flash...`,
    });

    const draftRes = await draftReplyWithDeepSeek({
      callerName: extracted.caller_name,
      phone: extracted.phone,
      email: extracted.email,
      language: replyLang,
      urgency: extracted.urgency,
      bookedSlot: routeOutcome.bookedSlot,
      proposedSlots: routeOutcome.proposedSlots,
      requestedSlot: extracted.preferred_slot,
      officeCategories: routeOutcome.officeCategories,
      missingFields: extracted.missing_fields,
      summary: extracted.summary,
    });

    replyDraft = draftRes.draft;
    replyLatencyMs += draftRes.latencyMs;
    replyInTokens += draftRes.inputTokens;
    replyOutTokens += draftRes.outputTokens;

    onEvent?.({
      type: "call_stage",
      batch_id: batchId,
      call_index: callIndex,
      call_id: call.call_id,
      stage: "jev_verification",
      message: "Verifying reply safety rules with Jev SDE...",
    });

    const verifyRes = await verifyReplyWithJevSde({
      replyDraft,
      bookedSlot: routeOutcome.bookedSlot,
      officeCategories: routeOutcome.officeCategories,
      expectedLanguage: replyLang,
    });

    if (jevTelemetry) {
      jevTelemetry = {
        ...jevTelemetry,
        latency_ms: jevTelemetry.latency_ms + verifyRes.latencyMs,
        input_tokens: jevTelemetry.input_tokens + verifyRes.inputTokens,
        sde_checks: [...jevTelemetry.sde_checks, ...verifyRes.checks],
      };
    }

    if (verifyRes.anyFired) {
      const channel: "email" | "sms" = extracted.email ? "email" : "sms";
      const recipient = (extracted.email ?? extracted.phone)!;
      replyDraft = buildGroundedTemplateReply(
        {
          callerName: extracted.caller_name,
          language: replyLang,
          urgency: extracted.urgency,
          bookedSlot: routeOutcome.bookedSlot,
          proposedSlots: routeOutcome.proposedSlots,
          requestedSlot: extracted.preferred_slot,
          officeCategories: routeOutcome.officeCategories,
          missingFields: extracted.missing_fields,
        },
        channel,
        recipient
      );
    }
  }

  const deepseekTelemetry = buildDeepSeekTelemetry({
    providerMode: deepseekExtractMeta.providerMode,
    model: deepseekExtractMeta.model,
    extractionLatencyMs: deepseekExtractMeta.latencyMs,
    replyLatencyMs,
    inputTokens: deepseekExtractMeta.inputTokens + replyInTokens,
    outputTokens: deepseekExtractMeta.outputTokens + replyOutTokens,
    repairAttempts: deepseekExtractMeta.repairAttempts,
    cascadeEscalated: deepseekExtractMeta.cascadeEscalated,
  });

  const totalProcessingMs = Math.max(1, Math.round(performance.now() - callStartMs));

  const record: ProcessedCallRecord = {
    record_id: `REC-${call.call_id}-${crypto.randomUUID().slice(0, 6)}`,
    processed_at: new Date().toISOString(),
    total_processing_ms: totalProcessingMs,
    engine_mode: engineMode,
    language: candidates.language,
    received: call.received ?? null,
    duration_sec: call.duration_sec ?? null,
    transcript_sha256: payloadHash,
    extracted,
    status: routeOutcome.status,
    outcome_headline: routeOutcome.outcomeHeadline,
    routing_actions: routeOutcome.routingActions,
    booked_slot: routeOutcome.bookedSlot,
    proposed_slots: routeOutcome.proposedSlots,
    reply_draft: replyDraft,
    on_call_alert: routeOutcome.onCallAlert,
    office_ticket: routeOutcome.officeTicket,
    jev_telemetry: jevTelemetry,
    deepseek_telemetry: deepseekTelemetry,
    benchmark_comparison: benchmarkComparison,
    idempotent_replay: false,
    original_processed_at: null,
    error_isolated: null,
    raw_call: call,
  };

  store.upsertRecord(record);

  onEvent?.({
    type: "call_stage",
    batch_id: batchId,
    call_index: callIndex,
    call_id: call.call_id,
    stage: "persisted",
    message: `Completed ${call.call_id} in ${(totalProcessingMs / 1000).toFixed(2)}s (${record.status}).`,
  });

  return record;
}

async function runHybridExtraction(
  call: IncomingCall,
  candidates: ReturnType<typeof preParseCall>,
  faultOpts?: DeepSeekMockFaultOptions
) {
  const wallT0 = performance.now();
  const [jevSettled, dsSettled] = await Promise.allSettled([
    evaluateIntakeWithJev(call, candidates),
    extractSpansWithDeepSeek(call, candidates, faultOpts),
  ]);

  if (jevSettled.status === "rejected") {
    throw new Error(`Jev System One intake failed: ${jevSettled.reason}`);
  }
  if (dsSettled.status === "rejected") {
    throw new Error(`DeepSeek span extraction failed: ${dsSettled.reason}`);
  }

  const jev = jevSettled.value;
  const spans = dsSettled.value;
  const wallMs = Math.max(1, Math.round(performance.now() - wallT0));

  return {
    wallMs,
    extractedCore: {
      call_id: call.call_id,
      caller_name: spans.caller_name,
      phone: jev.selectedPhone,
      email: candidates.candidate_emails[0] ?? null,
      address: spans.address,
      category: jev.categories,
      urgency: jev.urgency,
      appointment_requested: jev.appointmentRequested,
      preferred_slot: jev.preferredSlot,
      summary: spans.summary,
    },
    hazardFlags: jev.hazardFlags,
    jevTelemetry: jev.telemetry,
    deepseekMeta: {
      providerMode: spans.providerMode,
      model: spans.model,
      latencyMs: spans.latencyMs,
      inputTokens: spans.inputTokens,
      outputTokens: spans.outputTokens,
      repairAttempts: spans.repairAttempts,
      cascadeEscalated: false,
    },
  };
}

async function runCascadeExtraction(
  call: IncomingCall,
  candidates: ReturnType<typeof preParseCall>,
  faultOpts?: DeepSeekMockFaultOptions
) {
  if (faultOpts?.injectAlwaysMalformedJson) {
    throw new Error(
      "Cascade Rung 0 & Rung 1 failed: Malformed LLM JSON output `{\"caller_name\": \"Max`"
    );
  }

  const wallT0 = performance.now();
  const rung0 = await extractFullCascadeWithDeepSeek({
    call,
    candidates,
    rung: "fast",
  });

  const verification = await verifyCascadeExtractionWithJev({
    call,
    candidates,
    candidateExtraction: rung0.data,
  });

  let finalData = rung0.data;
  let totalLatency = rung0.latencyMs;
  let totalIn = rung0.inputTokens;
  let totalOut = rung0.outputTokens;
  let escalated = false;
  const firedNames = verification.checks.filter((c) => c.fired).map((c) => c.rule);

  if (verification.escalate) {
    escalated = true;
    const rung1 = await extractFullCascadeWithDeepSeek({
      call,
      candidates,
      rung: "thinking",
      firedRules: firedNames,
    });
    finalData = rung1.data;
    totalLatency += rung1.latencyMs;
    totalIn += rung1.inputTokens;
    totalOut += rung1.outputTokens;
  }

  const wallMs = Math.max(1, Math.round(performance.now() - wallT0));
  const estJevCost = Number(((verification.inputTokens / 1_000_000) * 0.042).toFixed(7));

  const cascadeJevTelemetry: JevTelemetry = {
    provider_mode: verification.providerMode,
    model: verification.model,
    latency_ms: verification.latencyMs,
    input_tokens: verification.inputTokens,
    output_tokens: 0,
    estimated_cost_usd: estJevCost,
    primitives: [],
    sde_checks: verification.checks,
    request_payload_preview: {
      mode: "sde_cascade_verifier",
      question_count: verification.checks.length,
      escalated_to_thinking: escalated,
    },
  };

  return {
    wallMs,
    firedNames,
    extractedCore: {
      call_id: call.call_id,
      ...finalData,
    },
    hazardFlags: verification.hazardFlags,
    jevTelemetry: cascadeJevTelemetry,
    deepseekMeta: {
      providerMode: rung0.providerMode,
      model: escalated ? `${rung0.model} (escalated: thinking)` : rung0.model,
      latencyMs: totalLatency,
      inputTokens: totalIn,
      outputTokens: totalOut,
      repairAttempts: 0,
      cascadeEscalated: escalated,
    },
  };
}

function buildBenchmarkComparison(
  hybrid: Awaited<ReturnType<typeof runHybridExtraction>>,
  cascade: Awaited<ReturnType<typeof runCascadeExtraction>>
): BenchmarkComparison {
  const hybridMissing = computeMissingFields({
    callerName: hybrid.extractedCore.caller_name,
    phone: hybrid.extractedCore.phone,
    email: hybrid.extractedCore.email,
    address: hybrid.extractedCore.address,
    category: hybrid.extractedCore.category,
    urgency: hybrid.extractedCore.urgency,
    appointmentRequested: hybrid.extractedCore.appointment_requested,
    preferredSlot: hybrid.extractedCore.preferred_slot,
  });

  const cascadeMissing = computeMissingFields({
    callerName: cascade.extractedCore.caller_name,
    phone: cascade.extractedCore.phone,
    email: cascade.extractedCore.email,
    address: cascade.extractedCore.address,
    category: cascade.extractedCore.category,
    urgency: cascade.extractedCore.urgency,
    appointmentRequested: cascade.extractedCore.appointment_requested,
    preferredSlot: cascade.extractedCore.preferred_slot,
  });

  const fields: Array<{ label: string; h: string; c: string }> = [
    {
      label: "caller_name",
      h: String(hybrid.extractedCore.caller_name ?? "null"),
      c: String(cascade.extractedCore.caller_name ?? "null"),
    },
    {
      label: "phone",
      h: String(hybrid.extractedCore.phone ?? "null"),
      c: String(cascade.extractedCore.phone ?? "null"),
    },
    {
      label: "email",
      h: String(hybrid.extractedCore.email ?? "null"),
      c: String(cascade.extractedCore.email ?? "null"),
    },
    {
      label: "address",
      h: String(hybrid.extractedCore.address ?? "null"),
      c: String(cascade.extractedCore.address ?? "null"),
    },
    {
      label: "category",
      h: [...hybrid.extractedCore.category].sort().join(", "),
      c: [...cascade.extractedCore.category].sort().join(", "),
    },
    {
      label: "urgency",
      h: hybrid.extractedCore.urgency,
      c: cascade.extractedCore.urgency,
    },
    {
      label: "appointment_requested",
      h: String(hybrid.extractedCore.appointment_requested),
      c: String(cascade.extractedCore.appointment_requested),
    },
    {
      label: "preferred_slot",
      h: String(hybrid.extractedCore.preferred_slot ?? "null"),
      c: String(cascade.extractedCore.preferred_slot ?? "null"),
    },
    {
      label: "missing_fields",
      h: hybridMissing.length ? hybridMissing.join(", ") : "[]",
      c: cascadeMissing.length ? cascadeMissing.join(", ") : "[]",
    },
  ];

  const diffs: BenchmarkDiffItem[] = fields.map((f) => ({
    field: f.label,
    hybrid_value: f.h,
    cascade_value: f.c,
    matches: f.h.toLowerCase() === f.c.toLowerCase(),
  }));

  const matchesCount = diffs.filter((d) => d.matches).length;

  const hybridCost =
    hybrid.jevTelemetry.estimated_cost_usd +
    (hybrid.deepseekMeta.inputTokens / 1_000_000) * 0.15 +
    (hybrid.deepseekMeta.outputTokens / 1_000_000) * 0.60;

  const cascadeCost =
    cascade.jevTelemetry.estimated_cost_usd +
    (cascade.deepseekMeta.inputTokens / 1_000_000) * 0.15 +
    (cascade.deepseekMeta.outputTokens / 1_000_000) * 0.60;

  return {
    agreement_rate: Number((matchesCount / diffs.length).toFixed(2)),
    hybrid_total_ms: hybrid.wallMs,
    cascade_total_ms: cascade.wallMs,
    hybrid_cost_usd: Number(hybridCost.toFixed(7)),
    cascade_cost_usd: Number(cascadeCost.toFixed(7)),
    cascade_escalated: cascade.deepseekMeta.cascadeEscalated,
    cascade_fired_rules: cascade.firedNames,
    diffs,
  };
}

function createIsolatedFailureRecord(params: {
  callId: string;
  rawItem: unknown;
  engineMode: EngineMode;
  errorMessage: string;
  elapsedMs: number;
}): ProcessedCallRecord {
  return {
    record_id: `REC-ISO-${params.callId}-${crypto.randomUUID().slice(0, 6)}`,
    processed_at: new Date().toISOString(),
    total_processing_ms: params.elapsedMs,
    engine_mode: params.engineMode,
    language: "en",
    received: null,
    duration_sec: null,
    transcript_sha256: hashCallPayload(params.rawItem),
    extracted: {
      call_id: params.callId,
      caller_name: null,
      phone: null,
      email: null,
      address: null,
      category: ["other"],
      urgency: "normal",
      appointment_requested: false,
      preferred_slot: null,
      summary: `Call ${params.callId} isolated for manual operator review due to processing/schema error.`,
      missing_fields: ["manual_transcript_inspection"],
    },
    status: "needs_review",
    outcome_headline: `Fault-Isolated to needs_review (${params.errorMessage.slice(0, 90)}) — batch continued safely`,
    routing_actions: ["flag_needs_review", "suppress_reply_unreachable"],
    booked_slot: null,
    proposed_slots: [],
    reply_draft: null,
    on_call_alert: null,
    office_ticket: null,
    jev_telemetry: null,
    deepseek_telemetry: null,
    benchmark_comparison: null,
    idempotent_replay: false,
    original_processed_at: null,
    error_isolated: params.errorMessage,
    raw_call:
      params.rawItem && typeof params.rawItem === "object"
        ? (params.rawItem as Record<string, unknown>)
        : { raw: String(params.rawItem) },
  };
}
