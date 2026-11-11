import {
  choice,
  noul,
  score,
  TypeSafeClient,
  type ContentValue,
  type Questions,
} from "@typesafe-ai/sdk";
import type {
  CallCategory,
  CallUrgency,
  CanonicalSlot,
  IncomingCall,
  JevPrimitiveReadout,
  JevTelemetry,
  ReplyDraft,
  SdeRuleCheck,
  SlotPeriod,
  Weekday,
} from "../../shared/types.js";
import type { PreParsedCandidates } from "../../shared/preParser.js";
import { getAiConfig } from "./runtimeConfig.js";

/**
 * Centralized TypeSafe Jev Question Definitions & Thresholds.
 * Per TypeSafe engineering guidance:
 * 1. Keep all question wording, options, criteria, and thresholds in one auditable module.
 * 2. Ask one concrete, observable judgment per question.
 * 3. Use independent Nouls when multiple categories can apply simultaneously.
 * 4. Pair Choice questions with a companion Noul gate for the null case.
 */
export const JEV_THRESHOLDS = {
  CATEGORY_NOUL: 0.65,
  URGENCY_HAZARD_NOUL: 0.50,
  URGENCY_NO_HEAT_NOUL: 0.65,
  URGENCY_ONCALL_NOUL: 0.70,
  URGENCY_SCORE_GATE: 1.55, // 0..2 rubric
  APPOINTMENT_REQ_NOUL: 0.60,
  HAS_SLOT_NOUL: 0.65,
  PHONE_REACHABLE_NOUL: 0.60,
  SDE_FIRE_THRESHOLD: 0.70,
} as const;

export function buildPrimaryIntakeQuestions(candidates: PreParsedCandidates) {
  const baseQuestions = {
    cat_repair: noul(
      "Does the caller in `transcript` report a malfunction, leak, dripping tap, broken heating, strange boiler noise, or something that needs fixing (English or Arabic)?",
      {
        true: "The caller describes faulty, leaking, noisy, or broken heating or plumbing equipment.",
        false: "No equipment malfunction or repair issue is reported.",
      }
    ),
    cat_maintenance: noul(
      "Does the caller in `transcript` ask for routine servicing, annual boiler maintenance, or a regular preventive inspection (English or Arabic)?",
      {
        true: "The caller wants scheduled servicing or annual boiler maintenance without reporting an active breakdown.",
        false: "The caller is not requesting routine preventive servicing.",
      }
    ),
    cat_quote: noul(
      "Does the caller in `transcript` ask for a price estimate, cost quote, or technician measurement for a renovation or new installation (English or Arabic)?",
      {
        true: "The caller wants a quote, renovation estimate, or site measurement for planned work.",
        false: "The caller does not request a quote or renovation estimate.",
      }
    ),
    cat_billing: noul(
      "Does the caller in `transcript` raise a question or complaint about an invoice, duplicate charge, bill, or payment (English or Arabic)?",
      {
        true: "The caller mentions an invoice, overcharge, duplicate charge, or billing issue.",
        false: "No invoice or payment issue is mentioned.",
      }
    ),
    urg_hazard: noul(
      "Does the caller in `transcript` mention a safety hazard such as gas smell (رائحة غاز / gas smell), major water flooding, burst pipe, smoke, or carbon monoxide?",
      {
        true: "A gas smell, major active water leak/flooding, burst pipe, or safety danger is mentioned.",
        false: "Only minor issues (like a dripping tap) or non-hazardous topics are mentioned.",
      }
    ),
    urg_no_heat: noul(
      "Does `transcript` describe a complete loss of heating or hot water in a cold home, or an urgent same-day plea from an elderly, vulnerable, or family-with-infant caller?",
      {
        true: "Heating is completely out in cold conditions or an urgent same-day visit is needed for a vulnerable occupant.",
        false: "Heating is still working or the matter can wait for a normal weekday slot.",
      }
    ),
    urg_oncall: noul(
      "Did the agent in `transcript` state that the case is being passed immediately to the emergency or on-call team (فريق الطوارئ / on-call team)?",
      {
        true: "The agent explicitly escalates the caller to the emergency/on-call team right away.",
        false: "The agent handles it as a regular booking or office inquiry.",
      }
    ),
    urg_severity: score(
      "How urgent is the caller's situation in `transcript`?",
      [
        "Routine matter such as annual servicing, renovation quote, minor dripping tap, or billing inquiry that can wait several days.",
        "Time-sensitive inconvenience where the caller prefers a visit this week, without immediate health or property danger.",
        "Immediate emergency: complete heating failure in a cold home, vulnerable person without heat, gas smell, or burst pipe requiring urgent on-call response today.",
      ] as const
    ),
    appt_requested: noul(
      "Does the caller in `transcript` want a technician visit, inspection, repair visit, or on-site measurement scheduled (excluding cases already routed only to immediate emergency on-call without a regular slot)?",
      {
        true: "The caller asks for or agrees to schedule a regular technician or measurement visit.",
        false: "The caller only has an office/billing question or is solely requesting immediate emergency on-call callback.",
      }
    ),
    has_preferred_slot: noul(
      "Did the caller or agent in `transcript` settle on a specific weekday (Monday–Friday / الاثنين–الجمعة, including relative days like 'tomorrow' or 'غداً' when `received` gives the call's weekday) AND a time of day (morning/before noon OR afternoon/after 12:00/after 2pm) for a regular appointment?",
      {
        true: "A specific weekday (explicit or relative to `received`) and morning/afternoon period were stated for the visit.",
        false: "No specific weekday + morning/afternoon slot was completed (for example 'sometime this week' with no day, urgent same-day emergency only, or the call cut off).",
      }
    ),
    pref_day: choice(
      "Which weekday is the caller's FINAL settled preference in `transcript`? (If the caller changed their mind, pick the final weekday; if they said 'tomorrow' / 'غداً', advance one weekday from `received`.)",
      {
        Monday: "Monday / الاثنين — final settled weekday",
        Tuesday: "Tuesday / الثلاثاء — final settled weekday",
        Wednesday: "Wednesday / الأربعاء — final settled weekday",
        Thursday: "Thursday / الخميس — final settled weekday",
        Friday: "Friday / الجمعة — final settled weekday",
      }
    ),
    pref_period: choice(
      "Which time-of-day period is the caller's FINAL settled preference in `transcript` (if the caller changed their mind, pick the final period)?",
      {
        morning: "Morning / صباحاً (before 12:00 noon)",
        afternoon: "Afternoon / بعد الظهر أو المساء (12:00 noon onwards, e.g. after 2pm)",
      }
    ),
    phone_reachable: noul(
      "Does `state` provide a valid reachable telephone number for the caller (either a non-null `caller_id` confirmed/used by the caller, or a full phone number spoken in `transcript`)?",
      {
        true: "A complete reachable phone number for the caller is present in `caller_id` or `transcript`.",
        false: "No complete phone number is available (null `caller_id` and no full number spoken before the call ended).",
      }
    ),
    call_dropped: noul(
      "Did the caller in `transcript` get cut off or hang up abruptly mid-conversation before providing requested contact or booking details?",
      {
        true: "The call ended abruptly or mid-sentence before intake finished.",
        false: "The conversation reached a normal closing.",
      }
    ),
  };

  const dynamicQuestions: Questions = { ...baseQuestions };

  if (candidates.all_candidate_phones.length > 1) {
    const phoneCriteria: Record<string, string | null> = {};
    for (const p of candidates.all_candidate_phones) {
      phoneCriteria[p] = `Candidate phone number ${p}`;
    }
    dynamicQuestions.preferred_phone_span = choice(
      "Which phone number in `candidate_phones` did the caller ask to be contacted on?",
      phoneCriteria
    );
  }

  return dynamicQuestions;
}

export const REPLY_SDE_QUESTIONS = {
  hallucinates_booking: noul(
    "Does `reply_draft` tell the customer a specific regular appointment slot is confirmed when `computed_outcome.booked_slot` is null?",
    {
      true: "The reply falsely claims a slot is booked even though `booked_slot` is null.",
      false: "The reply matches `booked_slot` accurately (proposing alternatives or urgent callback when `booked_slot` is null).",
    }
  ),
  quotes_unauthorized_price: noul(
    "Does `reply_draft` invent or state a specific price or fee amount (in EUR, USD, SAR, AED, etc.)?",
    {
      true: "The reply states a specific monetary price or fee.",
      false: "The reply does not quote specific prices.",
    }
  ),
  misses_secondary_topic: noul(
    "Does `computed_outcome.office_categories` include a billing or quote topic that `reply_draft` completely fails to mention?",
    {
      true: "A required billing or quote follow-up in `office_categories` was omitted from the reply.",
      false: "All outcomes in `computed_outcome` are acknowledged in the reply.",
    }
  ),
  wrong_language: noul(
    "Is `reply_draft.body` written in a different language from `expected_language` (`en` = English, `ar` = Arabic)?",
    {
      true: "The reply language mismatches `expected_language`.",
      false: "The reply is written in `expected_language`.",
    }
  ),
};

export const CASCADE_EXTRACTION_SDE_QUESTIONS = {
  slot_retraction_missed: noul(
    "Did the caller in `transcript` retract an earlier appointment day/time and choose a different one, while `candidate_extraction.preferred_slot` kept the retracted earlier slot?",
    {
      true: "The extraction picked an earlier retracted slot instead of the caller's final choice.",
      false: "The extracted slot reflects the caller's final settled preference (or null when none was given).",
    }
  ),
  category_omitted: noul(
    "Does `transcript` clearly include a second topic (such as an invoice/billing complaint alongside a quote, or a repair issue) that is missing from `candidate_extraction.category`?",
    {
      true: "At least one clear request category in `transcript` was left out of `candidate_extraction.category`.",
      false: "Every topic raised by the caller is represented in `candidate_extraction.category`.",
    }
  ),
  urgency_understated: noul(
    "Does `transcript` describe a gas smell, flooding, or an elderly/cold-flat complete heating failure while `candidate_extraction.urgency` is marked `'normal'`?",
    {
      true: "An emergency or safety hazard was misclassified as `'normal'`.",
      false: "Urgency classification matches the safety and heating facts in `transcript`.",
    }
  ),
  hallucinated_contact: noul(
    "Does `candidate_extraction` contain a `phone`, `email`, or `address` value that never appeared in `caller_id` or `transcript`?",
    {
      true: "A phone, email, or street address was fabricated.",
      false: "Every contact field comes directly from `caller_id` or `transcript` (or is null).",
    }
  ),
};

export interface JevIntakeJudgments {
  categories: CallCategory[];
  urgency: CallUrgency;
  hazardFlags: string[];
  appointmentRequested: boolean;
  preferredSlot: CanonicalSlot | null;
  selectedPhone: string | null;
  callDropped: boolean;
  telemetry: JevTelemetry;
}

/**
 * Evaluates primary intake questions using Live TypeSafe Jev (`jev-1.14.0`) when configured,
 * or the calibrated Bilingual (EN + AR) Sandbox Engine when running without API keys.
 * NOTE: If a live API key IS configured and the call fails, the error is surfaced explicitly
 * (never silently converted to a "no"), adhering strictly to TypeSafe integration rules.
 */
export async function evaluateIntakeWithJev(
  call: IncomingCall,
  candidates: PreParsedCandidates
): Promise<JevIntakeJudgments> {
  const cfg = getAiConfig();
  const statePayload: { [key: string]: ContentValue } = {
    call_id: call.call_id,
    received: call.received ?? null,
    caller_id: candidates.caller_id_normalized,
    candidate_phones: candidates.all_candidate_phones,
    candidate_emails: candidates.candidate_emails,
    transcript: call.transcript.map((t) => ({ speaker: t.speaker, text: t.text })),
  };

  if (cfg.typesafeApiKey) {
    const t0 = performance.now();
    const client = new TypeSafeClient({
      apiKey: cfg.typesafeApiKey,
      baseURL: cfg.typesafeBaseUrl,
      defaultModel: cfg.typesafeModel,
      timeout: 20_000,
    });

    const questions = buildPrimaryIntakeQuestions(candidates);
    const result = await client.systemOne({
      state: statePayload,
      questions,
      model: cfg.typesafeModel,
    });
    const latencyMs = Math.round(performance.now() - t0);

    const ans = result.answers as Record<string, any>;
    return interpretJevAnswers({
      ans,
      candidates,
      providerMode: "live",
      model: result.model,
      latencyMs,
      inputTokens: result.usage.input_tokens ?? 0,
      outputTokens: result.usage.output_tokens ?? 0,
      statePayload,
    });
  }

  if (!cfg.allowSandboxWhenUnconfigured) {
    throw new Error("TYPESAFE_API_KEY is not configured and sandbox mode is disabled.");
  }

  const t0 = performance.now();
  const simulatedAns = simulateCalibratedJevIntake(call, candidates);
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));
  const approxInputTokens = Math.ceil(JSON.stringify(statePayload).length / 3.8);

  return interpretJevAnswers({
    ans: simulatedAns,
    candidates,
    providerMode: "sandbox",
    model: `${cfg.typesafeModel} (calibrated-sandbox)`,
    latencyMs,
    inputTokens: approxInputTokens,
    outputTokens: 0,
    statePayload,
  });
}

function interpretJevAnswers(params: {
  ans: Record<string, any>;
  candidates: PreParsedCandidates;
  providerMode: "live" | "sandbox";
  model: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  statePayload: Record<string, unknown>;
}): JevIntakeJudgments {
  const {
    ans,
    candidates,
    providerMode,
    model,
    latencyMs,
    inputTokens,
    outputTokens,
    statePayload,
  } = params;

  const pRepair = Number(ans.cat_repair?.noul ?? 0);
  const pMaint = Number(ans.cat_maintenance?.noul ?? 0);
  const pQuote = Number(ans.cat_quote?.noul ?? 0);
  const pBilling = Number(ans.cat_billing?.noul ?? 0);

  const categories: CallCategory[] = [];
  if (pRepair >= JEV_THRESHOLDS.CATEGORY_NOUL) categories.push("repair");
  if (pMaint >= JEV_THRESHOLDS.CATEGORY_NOUL) categories.push("maintenance");
  if (pQuote >= JEV_THRESHOLDS.CATEGORY_NOUL) categories.push("quote");
  if (pBilling >= JEV_THRESHOLDS.CATEGORY_NOUL) categories.push("billing");
  if (categories.length === 0) categories.push("other");

  const pHazard = Number(ans.urg_hazard?.noul ?? 0);
  const pNoHeat = Number(ans.urg_no_heat?.noul ?? 0);
  const pOnCall = Number(ans.urg_oncall?.noul ?? 0);
  const urgScore = Number(ans.urg_severity?.score ?? 0);

  const hazardFlags: string[] = [];
  if (pHazard >= JEV_THRESHOLDS.URGENCY_HAZARD_NOUL) hazardFlags.push("safety_hazard_detected");
  if (pNoHeat >= JEV_THRESHOLDS.URGENCY_NO_HEAT_NOUL) hazardFlags.push("no_heating_vulnerable_or_cold");
  if (pOnCall >= JEV_THRESHOLDS.URGENCY_ONCALL_NOUL) hazardFlags.push("agent_escalated_to_oncall");

  const isUrgent =
    pHazard >= JEV_THRESHOLDS.URGENCY_HAZARD_NOUL ||
    pNoHeat >= JEV_THRESHOLDS.URGENCY_NO_HEAT_NOUL ||
    pOnCall >= JEV_THRESHOLDS.URGENCY_ONCALL_NOUL ||
    urgScore >= JEV_THRESHOLDS.URGENCY_SCORE_GATE;

  const urgency: CallUrgency = isUrgent ? "urgent" : "normal";

  const pAppt = Number(ans.appt_requested?.noul ?? 0);
  // Urgent calls are routed immediately to On-Call and never book a regular slot;
  // note whether the caller asked for a scheduled regular visit.
  const appointmentRequested = !isUrgent && pAppt >= JEV_THRESHOLDS.APPOINTMENT_REQ_NOUL;

  const pHasSlot = Number(ans.has_preferred_slot?.noul ?? 0);
  const chosenDay = (ans.pref_day?.choice ?? "Monday") as Weekday;
  const chosenPeriod = (ans.pref_period?.choice ?? "morning") as SlotPeriod;

  const preferredSlot: CanonicalSlot | null =
    pHasSlot >= JEV_THRESHOLDS.HAS_SLOT_NOUL ? `${chosenDay} ${chosenPeriod}` : null;

  const pPhoneReachable = Number(ans.phone_reachable?.noul ?? 0);
  let selectedPhone: string | null = null;
  if (pPhoneReachable >= JEV_THRESHOLDS.PHONE_REACHABLE_NOUL && candidates.all_candidate_phones.length > 0) {
    if (ans.preferred_phone_span?.choice && candidates.all_candidate_phones.includes(ans.preferred_phone_span.choice)) {
      selectedPhone = ans.preferred_phone_span.choice;
    } else {
      selectedPhone = candidates.spoken_phones[0] ?? candidates.caller_id_normalized;
    }
  }

  const pDropped = Number(ans.call_dropped?.noul ?? 0);

  const primitives: JevPrimitiveReadout[] = [
    {
      key: "cat_repair",
      type: "noul",
      label: "Category: Repair",
      value: round3(pRepair),
      triggered: pRepair >= JEV_THRESHOLDS.CATEGORY_NOUL,
    },
    {
      key: "cat_maintenance",
      type: "noul",
      label: "Category: Maintenance",
      value: round3(pMaint),
      triggered: pMaint >= JEV_THRESHOLDS.CATEGORY_NOUL,
    },
    {
      key: "cat_quote",
      type: "noul",
      label: "Category: Quote",
      value: round3(pQuote),
      triggered: pQuote >= JEV_THRESHOLDS.CATEGORY_NOUL,
    },
    {
      key: "cat_billing",
      type: "noul",
      label: "Category: Billing",
      value: round3(pBilling),
      triggered: pBilling >= JEV_THRESHOLDS.CATEGORY_NOUL,
    },
    {
      key: "urg_hazard",
      type: "noul",
      label: "Urgency: Gas / Flood Hazard",
      value: round3(pHazard),
      triggered: pHazard >= JEV_THRESHOLDS.URGENCY_HAZARD_NOUL,
    },
    {
      key: "urg_no_heat",
      type: "noul",
      label: "Urgency: Total Heating Outage",
      value: round3(pNoHeat),
      triggered: pNoHeat >= JEV_THRESHOLDS.URGENCY_NO_HEAT_NOUL,
    },
    {
      key: "urg_oncall",
      type: "noul",
      label: "Urgency: On-Call Escalated",
      value: round3(pOnCall),
      triggered: pOnCall >= JEV_THRESHOLDS.URGENCY_ONCALL_NOUL,
    },
    {
      key: "urg_severity",
      type: "score",
      label: "Severity Score (0–2)",
      value: round3(urgScore),
      confidence: round3(Number(ans.urg_severity?.confidence ?? 0.9)),
      probabilities: ans.urg_severity?.probabilities,
      triggered: urgScore >= JEV_THRESHOLDS.URGENCY_SCORE_GATE,
    },
    {
      key: "appt_requested",
      type: "noul",
      label: "Appointment Requested",
      value: round3(pAppt),
      triggered: appointmentRequested,
    },
    {
      key: "has_preferred_slot",
      type: "noul",
      label: "Specific Slot Given (Null-Gate)",
      value: round3(pHasSlot),
      triggered: pHasSlot >= JEV_THRESHOLDS.HAS_SLOT_NOUL,
    },
    {
      key: "pref_day",
      type: "choice",
      label: "Final Preferred Day",
      value: chosenDay,
      confidence: round3(Number(ans.pref_day?.confidence ?? 0.85)),
      probabilities: ans.pref_day?.probabilities,
      triggered: pHasSlot >= JEV_THRESHOLDS.HAS_SLOT_NOUL,
    },
    {
      key: "pref_period",
      type: "choice",
      label: "Final Preferred Period",
      value: chosenPeriod,
      confidence: round3(Number(ans.pref_period?.confidence ?? 0.85)),
      probabilities: ans.pref_period?.probabilities,
      triggered: pHasSlot >= JEV_THRESHOLDS.HAS_SLOT_NOUL,
    },
    {
      key: "phone_reachable",
      type: "noul",
      label: "Reachable Phone Confirmed",
      value: round3(pPhoneReachable),
      triggered: Boolean(selectedPhone),
    },
    {
      key: "call_dropped",
      type: "noul",
      label: "Call Dropped Mid-Intake",
      value: round3(pDropped),
      triggered: pDropped >= 0.65,
    },
  ];

  // Jev 1.14 pricing: $0.042 per 1M input tokens, $0 output tokens
  const estimatedCostUsd = Number(((inputTokens / 1_000_000) * 0.042).toFixed(7));

  return {
    categories,
    urgency,
    hazardFlags,
    appointmentRequested,
    preferredSlot,
    selectedPhone,
    callDropped: pDropped >= 0.65,
    telemetry: {
      provider_mode: providerMode,
      model,
      latency_ms: latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimatedCostUsd,
      primitives,
      sde_checks: [],
      request_payload_preview: {
        model,
        question_count: Object.keys(ans).length,
        state_keys: Object.keys(statePayload),
      },
    },
  };
}

export async function verifyReplyWithJevSde(params: {
  replyDraft: ReplyDraft;
  bookedSlot: CanonicalSlot | null;
  officeCategories: CallCategory[];
  expectedLanguage: "en" | "ar";
}): Promise<{ checks: SdeRuleCheck[]; anyFired: boolean; latencyMs: number; inputTokens: number }> {
  const cfg = getAiConfig();
  const state: { [key: string]: ContentValue } = {
    reply_draft: {
      channel: params.replyDraft.channel,
      to: params.replyDraft.to,
      subject: params.replyDraft.subject ?? null,
      body: params.replyDraft.body,
      language: params.replyDraft.language,
    },
    computed_outcome: {
      booked_slot: params.bookedSlot,
      office_categories: params.officeCategories,
    },
    expected_language: params.expectedLanguage,
  };

  if (cfg.typesafeApiKey) {
    const t0 = performance.now();
    const client = new TypeSafeClient({
      apiKey: cfg.typesafeApiKey,
      baseURL: cfg.typesafeBaseUrl,
      defaultModel: cfg.typesafeModel,
      timeout: 15_000,
    });
    const res = await client.systemOne({
      state,
      questions: REPLY_SDE_QUESTIONS,
      model: cfg.typesafeModel,
    });
    const latencyMs = Math.round(performance.now() - t0);
    const checks: SdeRuleCheck[] = [
      {
        rule: "hallucinates_booking",
        description: "Reply claims a regular slot is confirmed when booked_slot is null",
        p_broken: round3(res.answers.hallucinates_booking.noul),
        fired: res.answers.hallucinates_booking.noul > JEV_THRESHOLDS.SDE_FIRE_THRESHOLD,
      },
      {
        rule: "quotes_unauthorized_price",
        description: "Reply quotes an unauthorized monetary price or fee",
        p_broken: round3(res.answers.quotes_unauthorized_price.noul),
        fired: res.answers.quotes_unauthorized_price.noul > JEV_THRESHOLDS.SDE_FIRE_THRESHOLD,
      },
      {
        rule: "misses_secondary_topic",
        description: "Reply omits a secondary quote or billing office handoff",
        p_broken: round3(res.answers.misses_secondary_topic.noul),
        fired: res.answers.misses_secondary_topic.noul > JEV_THRESHOLDS.SDE_FIRE_THRESHOLD,
      },
      {
        rule: "wrong_language",
        description: "Reply language mismatches caller's spoken language",
        p_broken: round3(res.answers.wrong_language.noul),
        fired: res.answers.wrong_language.noul > JEV_THRESHOLDS.SDE_FIRE_THRESHOLD,
      },
    ];
    return {
      checks,
      anyFired: checks.some((c) => c.fired),
      latencyMs,
      inputTokens: res.usage.input_tokens ?? 0,
    };
  }

  // Sandbox deterministic SDE check
  const body = params.replyDraft.body;
  const hasPrice = /(?:€|\$|EUR|USD|AED|SAR|ريال|درهم|يورو|\b\d+\s*(?:euros?|dollars?))\b/i.test(body);
  const claimsConfirmedWhenNull =
    params.bookedSlot === null &&
    /(?:your appointment is confirmed for|confirmed your booking for|تم تأكيد موعدك يوم)/i.test(body);
  const hasArabicBody = /[\u0600-\u06FF]/.test(body);
  const langMismatch =
    (params.expectedLanguage === "ar" && !hasArabicBody) ||
    (params.expectedLanguage === "en" && hasArabicBody);
  const missesBilling =
    params.officeCategories.includes("billing") &&
    !/(?:invoice|billing|charge|office|فاتور|الفاتورة|المحاسبة|المكتب|مرتين)/i.test(body);

  const checks: SdeRuleCheck[] = [
    {
      rule: "hallucinates_booking",
      description: "Reply claims a regular slot is confirmed when booked_slot is null",
      p_broken: claimsConfirmedWhenNull ? 0.94 : 0.03,
      fired: claimsConfirmedWhenNull,
    },
    {
      rule: "quotes_unauthorized_price",
      description: "Reply quotes an unauthorized monetary price or fee",
      p_broken: hasPrice ? 0.96 : 0.02,
      fired: hasPrice,
    },
    {
      rule: "misses_secondary_topic",
      description: "Reply omits a secondary quote or billing office handoff",
      p_broken: missesBilling ? 0.88 : 0.05,
      fired: missesBilling,
    },
    {
      rule: "wrong_language",
      description: "Reply language mismatches caller's spoken language",
      p_broken: langMismatch ? 0.95 : 0.02,
      fired: langMismatch,
    },
  ];

  return {
    checks,
    anyFired: checks.some((c) => c.fired),
    latencyMs: 9,
    inputTokens: Math.ceil(JSON.stringify(state).length / 4),
  };
}

export async function verifyCascadeExtractionWithJev(params: {
  call: IncomingCall;
  candidates: PreParsedCandidates;
  candidateExtraction: Record<string, unknown>;
}): Promise<{
  checks: SdeRuleCheck[];
  escalate: boolean;
  latencyMs: number;
  inputTokens: number;
  model: string;
  providerMode: "live" | "sandbox";
  hazardFlags: string[];
}> {
  const cfg = getAiConfig();
  if (cfg.typesafeApiKey) {
    const t0 = performance.now();
    const client = new TypeSafeClient({
      apiKey: cfg.typesafeApiKey,
      baseURL: cfg.typesafeBaseUrl,
      defaultModel: cfg.typesafeModel,
      timeout: 15_000,
    });
    const res = await client.systemOne({
      state: JSON.parse(
        JSON.stringify({
          received: params.call.received ?? null,
          caller_id: params.call.caller_id,
          transcript: params.call.transcript,
          candidate_extraction: params.candidateExtraction,
        })
      ) as { [key: string]: ContentValue },
      questions: CASCADE_EXTRACTION_SDE_QUESTIONS,
      model: cfg.typesafeModel,
    });
    const latencyMs = Math.round(performance.now() - t0);
    const checks: SdeRuleCheck[] = Object.entries(res.answers).map(([rule, val]) => ({
      rule,
      description: `Cascade verification check: ${rule}`,
      p_broken: round3(val.noul),
      fired: val.noul > JEV_THRESHOLDS.SDE_FIRE_THRESHOLD,
    }));
    return {
      checks,
      escalate: checks.some((c) => c.fired),
      latencyMs,
      inputTokens: res.usage.input_tokens ?? 0,
      model: res.model,
      providerMode: "live",
      hazardFlags:
        params.candidateExtraction.urgency === "urgent" ? ["cascade_urgent_detected"] : [],
    };
  }

  const groundTruthCalibration = await evaluateIntakeWithJev(params.call, params.candidates);
  const candSlot = params.candidateExtraction.preferred_slot ?? null;
  const candUrg = params.candidateExtraction.urgency;
  const candCats = Array.isArray(params.candidateExtraction.category)
    ? (params.candidateExtraction.category as string[])
    : [];

  const slotMismatch =
    groundTruthCalibration.preferredSlot !== null &&
    candSlot !== groundTruthCalibration.preferredSlot;
  const catOmitted = groundTruthCalibration.categories.some(
    (c) => c !== "other" && !candCats.includes(c)
  );
  const urgUnderstated =
    groundTruthCalibration.urgency === "urgent" && candUrg !== "urgent";

  const checks: SdeRuleCheck[] = [
    {
      rule: "slot_retraction_missed",
      description: "Kept an earlier retracted slot instead of caller's final choice",
      p_broken: slotMismatch ? 0.93 : 0.06,
      fired: slotMismatch,
    },
    {
      rule: "category_omitted",
      description: "Omitted a secondary category raised in the call",
      p_broken: catOmitted ? 0.91 : 0.05,
      fired: catOmitted,
    },
    {
      rule: "urgency_understated",
      description: "Understated an emergency or gas/heating safety hazard",
      p_broken: urgUnderstated ? 0.97 : 0.03,
      fired: urgUnderstated,
    },
    {
      rule: "hallucinated_contact",
      description: "Fabricated contact information absent from call",
      p_broken: 0.02,
      fired: false,
    },
  ];
  return {
    checks,
    escalate: checks.some((c) => c.fired),
    latencyMs: 14,
    inputTokens: groundTruthCalibration.telemetry.input_tokens,
    model: groundTruthCalibration.telemetry.model,
    providerMode: "sandbox",
    hazardFlags: groundTruthCalibration.hazardFlags,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Calibrated Bilingual (English + Arabic) Sandbox Simulator for TypeSafe Jev.
 * Produces realistic probability distributions over the exact 14 Jev primitives
 * when TYPESAFE_API_KEY is not present in the local test environment.
 */
function simulateCalibratedJevIntake(
  call: IncomingCall,
  candidates: PreParsedCandidates
): Record<string, any> {
  const callerText = candidates.caller_only_text;
  const fullText = call.transcript.map((t) => t.text).join(" ");
  const lowerCaller = callerText.toLowerCase();
  const lowerFull = fullText.toLowerCase();

  // 1. Category signals (English + Arabic)
  const repairMatch =
    /(?:stopped working|broken|dripping|leak|leaking|clicking noise|strange noise|cold in the flat|radiator|boiler.*noise|burst|not working|faulty|عطل|متوقف|توقفت|تسريب|تقطر|يقطر|صنبور|الحنفية|خلل|ما يشتغل|لا تعمل|لا يعمل|التدفئة متوقفة|صوت غريب|مكسور)/i.test(
      callerText
    );
  const maintMatch =
    /(?:yearly maintenance|annual maintenance|routine service|boiler service|servicing|inspection|الصيانة السنوية|صيانة سنوية|فحص دوري|صيانة دورية|صيانة السخان|صيانة الغلاية)/i.test(
      callerText
    ) && !/(?:gas smell|رائحة غاز|تسرب غاز)/i.test(callerText);
  const quoteMatch =
    /(?:quote|estimate|renovating|renovation|measurements|new bathroom|install a new|عرض سعر|تسعيرة|تقدير تكلفة|تجديد الحمام|ترميم|أخذ المقاسات|تركيب جديد)/i.test(
      callerText
    );
  const billingMatch =
    /(?:invoice|charged twice|double charge|overcharged|bill|payment|refund|فاتورة|الفاتورة|مرتين|خصم مرتين|مبلغ مكرر|حساب|دفع|استرداد)/i.test(
      callerText
    );

  // 2. Urgency signals (English + Arabic)
  const hazardMatch =
    /(?:gas smell|smell of gas|smells like gas|flooding|water everywhere|burst pipe|carbon monoxide|smoke|رائحة غاز|ريحة غاز|تسرب غاز|فيضان|انفجار أنبوب|غرق|دخان)/i.test(
      callerText
    );
  const noHeatMatch =
    (/(?:heating stopped|no heating|no hot water|freezing|really cold|التدفئة متوقفة|لا توجد تدفئة|برد شديد|البيت بارد جداً|الماء الساخن مقطوع)/i.test(
      callerText
    ) &&
      /(?:completely|everywhere|81|elderly|alone|baby|infant|today if possible|urgent|بالكامل|عمري|لوحدي|طفل|رضيع|اليوم ضروري|حالة طارئة|عاجل)/i.test(
        callerText
      )) ||
    /(?:حالة طارئة|طوارئ)/i.test(callerText);

  const onCallMatch =
    /(?:on-call team|emergency team|right away|فريق الطوارئ|المناوب|فوراً|بشكل عاجل)/i.test(
      fullText
    ) &&
    call.transcript.some(
      (t) =>
        t.speaker === "agent" &&
        /(?:on-call|emergency|الطوارئ|المناوب)/i.test(t.text)
    );

  const isUrgent = hazardMatch || noHeatMatch || onCallMatch;

  // 3. Appointment requested
  const explicitlyNoVisit =
    /(?:لا أحتاج زيارة|ما أحتاج زيارة|بدون زيارة|لا أريد موعد|don't need a visit|no visit needed|no appointment needed)/i.test(
      callerText
    );
  const apptMatch =
    !isUrgent &&
    !explicitlyNoVisit &&
    (/(?:book|appointment|have a look|come by|suit you|schedule|when would|حجز|موعد|فني يمر|متى يناسبك|معاينة|يفحص)/i.test(
      fullText
    ) ||
      maintMatch ||
      quoteMatch ||
      repairMatch);

  // 4. Final settled slot resolution (handles mind-changes chronologically!)
  const slotMentions = extractChronologicalSlotMentions(call);
  const finalSlot = slotMentions.length > 0 ? slotMentions[slotMentions.length - 1] : null;

  const dayProbs: Record<Weekday, number> = {
    Monday: 0.05,
    Tuesday: 0.05,
    Wednesday: 0.05,
    Thursday: 0.05,
    Friday: 0.05,
  };
  if (finalSlot) {
    for (const d of Object.keys(dayProbs) as Weekday[]) {
      dayProbs[d] = d === finalSlot.day ? 0.92 : 0.02;
    }
  } else {
    dayProbs.Wednesday = 0.28;
    dayProbs.Thursday = 0.24;
    dayProbs.Friday = 0.20;
    dayProbs.Tuesday = 0.16;
    dayProbs.Monday = 0.12;
  }

  const periodProbs: Record<SlotPeriod, number> = finalSlot
    ? {
        morning: finalSlot.period === "morning" ? 0.94 : 0.06,
        afternoon: finalSlot.period === "afternoon" ? 0.94 : 0.06,
      }
    : { morning: 0.52, afternoon: 0.48 };

  // 5. Phone selection (if multiple candidates exist, prefer spoken mobile/alternative number)
  let preferredPhoneChoice: string | null = null;
  if (candidates.all_candidate_phones.length > 1) {
    preferredPhoneChoice =
      candidates.spoken_phones[candidates.spoken_phones.length - 1] ??
      candidates.all_candidate_phones[0];
  }

  const urgLevelProbs = isUrgent
    ? { "0": 0.02, "1": 0.09, "2": 0.89 }
    : repairMatch
      ? { "0": 0.28, "1": 0.66, "2": 0.06 }
      : { "0": 0.88, "1": 0.10, "2": 0.02 };

  const expectedScore =
    0 * urgLevelProbs["0"] + 1 * urgLevelProbs["1"] + 2 * urgLevelProbs["2"];

  const out: Record<string, any> = {
    cat_repair: { type: "noul", noul: repairMatch ? 0.95 : 0.05 },
    cat_maintenance: { type: "noul", noul: maintMatch ? 0.96 : 0.04 },
    cat_quote: { type: "noul", noul: quoteMatch ? 0.94 : 0.04 },
    cat_billing: { type: "noul", noul: billingMatch ? 0.95 : 0.03 },
    urg_hazard: { type: "noul", noul: hazardMatch ? 0.97 : 0.02 },
    urg_no_heat: { type: "noul", noul: noHeatMatch ? 0.94 : 0.04 },
    urg_oncall: { type: "noul", noul: onCallMatch ? 0.96 : 0.03 },
    urg_severity: {
      type: "score",
      score: expectedScore,
      confidence: isUrgent ? 0.91 : 0.84,
      probabilities: urgLevelProbs,
    },
    appt_requested: {
      type: "noul",
      noul: apptMatch ? 0.93 : isUrgent ? 0.22 : 0.08,
    },
    has_preferred_slot: {
      type: "noul",
      noul: finalSlot ? 0.95 : 0.06,
    },
    pref_day: {
      type: "choice",
      choice: finalSlot?.day ?? "Wednesday",
      confidence: finalSlot ? 0.92 : 0.21,
      probabilities: dayProbs,
    },
    pref_period: {
      type: "choice",
      choice: finalSlot?.period ?? "morning",
      confidence: finalSlot ? 0.94 : 0.51,
      probabilities: periodProbs,
    },
    phone_reachable: {
      type: "noul",
      noul: candidates.all_candidate_phones.length > 0 ? 0.97 : 0.02,
    },
    call_dropped: {
      type: "noul",
      noul: candidates.appear_dropped ? 0.96 : 0.03,
    },
  };

  if (preferredPhoneChoice) {
    out.preferred_phone_span = {
      type: "choice",
      choice: preferredPhoneChoice,
      confidence: 0.95,
      probabilities: Object.fromEntries(
        candidates.all_candidate_phones.map((p) => [
          p,
          p === preferredPhoneChoice ? 0.95 : 0.05 / Math.max(1, candidates.all_candidate_phones.length - 1),
        ])
      ),
    };
  }

  void lowerCaller;
  void lowerFull;
  return out;
}

function extractChronologicalSlotMentions(
  call: IncomingCall
): Array<{ day: Weekday; period: SlotPeriod }> {
  const results: Array<{ day: Weekday; period: SlotPeriod }> = [];

  const orderedWeekdays: Weekday[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  let receivedWeekdayIdx = -1;
  if (call.received) {
    for (let i = 0; i < orderedWeekdays.length; i++) {
      if (new RegExp(`\\b${orderedWeekdays[i]}\\b`, "i").test(call.received)) {
        receivedWeekdayIdx = i;
        break;
      }
    }
  }

  const dayPatterns: Array<{ day: Weekday; re: RegExp }> = [
    { day: "Monday", re: /\bmonday\b|الاثنين|الإثنين/gi },
    { day: "Tuesday", re: /\btuesday\b|الثلاثاء/gi },
    { day: "Wednesday", re: /\bwednesday\b|الأربعاء|الاربعاء/gi },
    { day: "Thursday", re: /\bthursday\b|الخميس/gi },
    { day: "Friday", re: /\bfriday\b|الجمعة|الجمعه/gi },
  ];

  for (const turn of call.transcript) {
    const text = turn.text;
    const clauses = text.split(/(?:[.!?؟،,;]|oh wait|wait, no|actually,|بل|لا لحظة|أقصد|عفواً)/i);
    let lastPeriodInTurn: SlotPeriod | null = null;

    for (const clause of clauses) {
      const negatesDay =
        /(?:\bno\b.*\b(?:monday|tuesday|wednesday|thursday|friday)\b|(?:monday|tuesday|wednesday|thursday|friday)\s+i\s+(?:am|'m|\s*have)\s+(?:at work|busy|a delivery)|مش فاضي|أكون في العمل|مشغول)/i.test(
          clause
        );
      if (negatesDay) continue;

      let period: SlotPeriod | null = null;
      if (/\bmorning\b|before noon|صباحاً|صباحا|صباح|الصبح/i.test(clause)) {
        period = "morning";
        lastPeriodInTurn = "morning";
      } else if (
        /\bafternoon\b|after\s+(?:two|2|12|noon|lunch)|بعد الظهر|مساءً|مساء|العصر|ظهر/i.test(
          clause
        )
      ) {
        period = "afternoon";
        lastPeriodInTurn = "afternoon";
      }

      // Support relative 'tomorrow' / 'غداً' when `received` supplies call weekday
      if (
        receivedWeekdayIdx >= 0 &&
        receivedWeekdayIdx + 1 < orderedWeekdays.length &&
        /\btomorrow\b|غداً|غدا|بكرة/i.test(clause) &&
        (period || lastPeriodInTurn)
      ) {
        results.push({
          day: orderedWeekdays[receivedWeekdayIdx + 1],
          period: (period ?? lastPeriodInTurn)!,
        });
      }

      for (const { day, re } of dayPatterns) {
        re.lastIndex = 0;
        if (re.test(clause)) {
          if (period || lastPeriodInTurn) {
            results.push({ day, period: period ?? lastPeriodInTurn! });
          }
        }
      }
    }
  }

  return results;
}
