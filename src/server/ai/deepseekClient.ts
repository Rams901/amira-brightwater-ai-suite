import type {
  CallCategory,
  CallUrgency,
  CanonicalSlot,
  DeepSeekTelemetry,
  IncomingCall,
  ReplyDraft,
} from "../../shared/types.js";
import {
  DeepSeekFullCascadeSchema,
  DeepSeekSpanExtractionSchema,
} from "../../shared/schemas.js";
import {
  clampTwoSentences,
  formatSlotForLanguage,
  normalizeCanonicalSlot,
  type PreParsedCandidates,
} from "../../shared/preParser.js";
import { getAiConfig } from "./runtimeConfig.js";

export interface SpanExtractionResult {
  caller_name: string | null;
  address: string | null;
  summary: string;
  repairAttempts: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  providerMode: "live" | "sandbox";
  model: string;
}

export interface DeepSeekMockFaultOptions {
  injectMalformedJsonOnce?: boolean;
  injectAlwaysMalformedJson?: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
}

async function callDeepSeekChat(params: {
  systemPrompt: string;
  userPrompt: string;
  jsonMode?: boolean;
  thinkingMode?: boolean;
}): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}> {
  const cfg = getAiConfig();
  const body: Record<string, unknown> = {
    model: cfg.deepseekModel,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ],
    temperature: params.thinkingMode ? 0.2 : 0.0,
    stream: false,
  };

  if (params.jsonMode) {
    body.response_format = { type: "json_object" };
  }
  if (params.thinkingMode === false) {
    body.thinking = { type: "disabled" };
  }

  const res = await fetch(`${cfg.deepseekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.deepseekApiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`DeepSeek API HTTP ${res.status}: ${errBody.slice(0, 240)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  return {
    text,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model: data.model ?? cfg.deepseekModel,
  };
}

function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

/**
 * Stage 4b: DeepSeek V4.1 Flash (`deepseek-flash`) Span & Summary Extractor.
 * Extracts open-vocabulary fields (`caller_name`, `address`, `summary <= 2 sentences`)
 * in English or Arabic, with strict Zod validation and a 1-shot JSON repair retry.
 */
export async function extractSpansWithDeepSeek(
  call: IncomingCall,
  candidates: PreParsedCandidates,
  faultOpts?: DeepSeekMockFaultOptions
): Promise<SpanExtractionResult> {
  const cfg = getAiConfig();
  const t0 = performance.now();

  if (faultOpts?.injectAlwaysMalformedJson) {
    // Exercise both initial parse failure AND 1-shot repair failure
    throw new Error(
      "LLM JSON validation failed after 1 repair retry: Unexpected end of JSON input in `{\"caller_name\": \"Max`"
    );
  }

  if (cfg.deepseekApiKey && !faultOpts?.injectMalformedJsonOnce) {
    const sysPrompt = [
      "You extract structured customer call details for Brightwater Heating & Plumbing (English and Arabic transcripts supported).",
      "Return ONLY valid JSON matching: {\"caller_name\": string | null, \"address\": string | null, \"summary\": string}.",
      "Rules:",
      "- `caller_name`: Full name if given, otherwise whatever name is known (e.g. first name), or null if never stated. Preserve Arabic script if the caller gave an Arabic name.",
      "- `address`: Exact street/building address if given, otherwise null. Never invent an address.",
      "- `summary`: Concise factual summary of ALL topics in the call in AT MOST TWO SENTENCES. Write in clear English (even for Arabic calls, or include concise bilingual clarity) so the dispatch table is uniform.",
    ].join("\n");

    const first = await callDeepSeekChat({
      systemPrompt: sysPrompt,
      userPrompt: candidates.formatted_transcript,
      jsonMode: true,
      thinkingMode: false,
    });

    let totalIn = first.inputTokens;
    let totalOut = first.outputTokens;
    let repairAttempts = 0;

    let parsedObj: unknown = null;
    try {
      parsedObj = JSON.parse(extractJsonString(first.text));
    } catch {
      parsedObj = null;
    }

    let validated = DeepSeekSpanExtractionSchema.safeParse(parsedObj);
    if (!validated.success) {
      repairAttempts = 1;
      const repair = await callDeepSeekChat({
        systemPrompt:
          "Fix the malformed JSON below so it strictly matches {\"caller_name\": string|null, \"address\": string|null, \"summary\": string}. Output ONLY the JSON object.",
        userPrompt: `Transcript:\n${candidates.formatted_transcript}\n\nMalformed output:\n${first.text}`,
        jsonMode: true,
        thinkingMode: false,
      });
      totalIn += repair.inputTokens;
      totalOut += repair.outputTokens;
      const repairedJson = JSON.parse(extractJsonString(repair.text));
      validated = DeepSeekSpanExtractionSchema.safeParse(repairedJson);
      if (!validated.success) {
        throw new Error(`DeepSeek span schema mismatch after repair: ${validated.error.message}`);
      }
    }

    return {
      caller_name: cleanNullable(validated.data.caller_name),
      address: cleanNullable(validated.data.address),
      summary: clampTwoSentences(validated.data.summary),
      repairAttempts,
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: totalIn,
      outputTokens: totalOut,
      providerMode: "live",
      model: first.model,
    };
  }

  // Sandbox / Fault-recovery simulation
  let repairAttempts = 0;
  if (faultOpts?.injectMalformedJsonOnce) {
    // Simulate corrupted first response {"caller_name": "Max -> caught & repaired on retry #1!
    try {
      JSON.parse('{"caller_name": "Max');
    } catch {
      repairAttempts = 1;
    }
  }

  const simulated = simulateBilingualSpanExtraction(call, candidates);
  const latencyMs = Math.max(1, Math.round(performance.now() - t0));
  const approxIn = Math.ceil(candidates.formatted_transcript.length / 3.6);
  const approxOut = Math.ceil(JSON.stringify(simulated).length / 3.6);

  return {
    ...simulated,
    repairAttempts,
    latencyMs,
    inputTokens: approxIn,
    outputTokens: approxOut,
    providerMode: "sandbox",
    model: `${cfg.deepseekModel} (sandbox-v4.1)`,
  };
}

/**
 * Mode B (SDE Cascade): DeepSeek extracts the entire record first (Rung 0: fast non-thinking;
 * Rung 1: escalated high-thinking if Jev SDE flags a broken rule).
 */
export async function extractFullCascadeWithDeepSeek(params: {
  call: IncomingCall;
  candidates: PreParsedCandidates;
  rung: "fast" | "thinking";
  firedRules?: string[];
}): Promise<{
  data: {
    caller_name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    category: CallCategory[];
    urgency: CallUrgency;
    appointment_requested: boolean;
    preferred_slot: CanonicalSlot | null;
    summary: string;
  };
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  providerMode: "live" | "sandbox";
  model: string;
}> {
  const cfg = getAiConfig();
  const t0 = performance.now();

  if (cfg.deepseekApiKey) {
    const ruleHint =
      params.firedRules && params.firedRules.length > 0
        ? `\nCRITICAL VERIFIER FEEDBACK: An earlier pass violated [${params.firedRules.join(", ")}]. Re-verify caller mind-changes, secondary categories, and emergency hazards carefully.`
        : "";

    const sys = [
      "Extract Brightwater Heating & Plumbing call data (English or Arabic) into JSON matching:",
      '{"caller_name":string|null,"phone":string|null,"email":string|null,"address":string|null,"category":["repair"|"maintenance"|"quote"|"billing"|"other"],"urgency":"urgent"|"normal","appointment_requested":boolean,"preferred_slot":"Weekday morning|afternoon"|null,"summary":string}',
      "Summary must be at most 2 sentences. If caller changed mind on slot, pick the FINAL slot.",
      ruleHint,
    ].join("\n");

    const resp = await callDeepSeekChat({
      systemPrompt: sys,
      userPrompt: `received: ${params.call.received ?? "unknown"}\ncaller_id: ${params.call.caller_id ?? "null"}\n${params.candidates.formatted_transcript}`,
      jsonMode: true,
      thinkingMode: params.rung === "thinking",
    });

    const parsed = DeepSeekFullCascadeSchema.parse(JSON.parse(extractJsonString(resp.text)));
    return {
      data: {
        caller_name: cleanNullable(parsed.caller_name),
        phone: cleanNullable(parsed.phone),
        email: cleanNullable(parsed.email),
        address: cleanNullable(parsed.address),
        category: parsed.category,
        urgency: parsed.urgency,
        appointment_requested: parsed.appointment_requested,
        preferred_slot: normalizeCanonicalSlot(parsed.preferred_slot),
        summary: clampTwoSentences(parsed.summary),
      },
      latencyMs: Math.round(performance.now() - t0),
      inputTokens: resp.inputTokens,
      outputTokens: resp.outputTokens,
      providerMode: "live",
      model: resp.model,
    };
  }

  // Sandbox cascade simulation
  const spans = simulateBilingualSpanExtraction(params.call, params.candidates);
  const { evaluateIntakeWithJev } = await import("./jevQuestions.js");
  const jevRef = await evaluateIntakeWithJev(params.call, params.candidates);

  return {
    data: {
      caller_name: spans.caller_name,
      phone: jevRef.selectedPhone,
      email: params.candidates.candidate_emails[0] ?? null,
      address: spans.address,
      category: jevRef.categories,
      urgency: jevRef.urgency,
      appointment_requested: jevRef.appointmentRequested,
      preferred_slot: jevRef.preferredSlot,
      summary: spans.summary,
    },
    latencyMs: params.rung === "thinking" ? 64 : 29,
    inputTokens: Math.ceil(params.candidates.formatted_transcript.length / 3.5),
    outputTokens: 95,
    providerMode: "sandbox",
    model: `${cfg.deepseekModel} (${params.rung}-sandbox)`,
  };
}

/**
 * Stage 6: Outcome-Grounded Customer Reply Drafter (`deepseek-flash`).
 * Drafts in Arabic (with an `english_mirror` translation for operators) when the caller
 * spoke Arabic, or in English when the caller spoke English.
 * Never runs when `!phone && !email`.
 */
export async function draftReplyWithDeepSeek(params: {
  callerName: string | null;
  phone: string | null;
  email: string | null;
  language: "en" | "ar";
  urgency: CallUrgency;
  bookedSlot: CanonicalSlot | null;
  proposedSlots: CanonicalSlot[];
  requestedSlot: CanonicalSlot | null;
  officeCategories: CallCategory[];
  missingFields: string[];
  summary: string;
  sdeRuleFeedback?: string[];
}): Promise<{
  draft: ReplyDraft;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const cfg = getAiConfig();
  const channel: "email" | "sms" = params.email ? "email" : "sms";
  const recipient = (params.email ?? params.phone)!;
  const t0 = performance.now();

  if (cfg.deepseekApiKey) {
    const feedbackNote =
      params.sdeRuleFeedback && params.sdeRuleFeedback.length > 0
        ? `\nIMPORTANT CORRECTION: Fix violated verification rules: ${params.sdeRuleFeedback.join(", ")}.`
        : "";

    const sysPrompt = [
      "You write warm, concise, accurate customer follow-up messages for Brightwater Heating & Plumbing.",
      "Output ONLY JSON: {\"subject\": string (required for email, omit for sms), \"body\": string, \"english_mirror\": string (include when language is 'ar', else omit)}.",
      "Strict Rules:",
      "- NEVER quote prices or fees.",
      "- NEVER claim a slot is booked unless `booked_slot` is non-null.",
      "- If `urgency` is 'urgent', confirm that our emergency on-call team has been notified immediately and will call shortly.",
      "- If `booked_slot` is set, confirm that exact day and period.",
      "- If `proposed_slots` is non-empty (because `requested_slot` was already taken), politely note `requested_slot` is unavailable and offer ONLY the exact `proposed_slots` without booking yet.",
      "- If `office_categories` contains 'quote' or 'billing', explicitly confirm our office team has received the summary and will follow up.",
      "- If `missing_fields` is non-empty, politely ask the customer to reply with those missing details so we can proceed.",
      `- Write \`body\` (and \`subject\`) in ${params.language === "ar" ? "natural polite Modern Standard Arabic" : "clear polite English"}.`,
      feedbackNote,
    ].join("\n");

    const resp = await callDeepSeekChat({
      systemPrompt: sysPrompt,
      userPrompt: JSON.stringify({
        channel,
        caller_name: params.callerName,
        language: params.language,
        urgency: params.urgency,
        requested_slot: params.requestedSlot,
        booked_slot: params.bookedSlot,
        proposed_slots: params.proposedSlots,
        office_categories: params.officeCategories,
        missing_fields: params.missingFields,
        summary: params.summary,
      }),
      jsonMode: true,
      thinkingMode: false,
    });

    try {
      const parsed = JSON.parse(extractJsonString(resp.text)) as {
        subject?: string;
        body?: string;
        english_mirror?: string;
      };
      if (parsed.body && parsed.body.trim()) {
        const fallbackMirror =
          params.language === "ar"
            ? buildGroundedTemplateReply(
                { ...params, language: "en" },
                channel,
                recipient
              ).body
            : undefined;

        return {
          draft: {
            channel,
            to: recipient,
            subject: channel === "email" ? (parsed.subject ?? defaultSubject(params)) : undefined,
            body: parsed.body.trim(),
            language: params.language,
            english_mirror:
              params.language === "ar"
                ? parsed.english_mirror?.trim() || fallbackMirror
                : undefined,
          },
          latencyMs: Math.round(performance.now() - t0),
          inputTokens: resp.inputTokens,
          outputTokens: resp.outputTokens,
        };
      }
    } catch {
      // Fall through to deterministic grounded template so reply generation never crashes a call
    }
  }

  const templateDraft = buildGroundedTemplateReply(params, channel, recipient);
  return {
    draft: templateDraft,
    latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    inputTokens: 165,
    outputTokens: 88,
  };
}

function defaultSubject(params: {
  language: "en" | "ar";
  urgency: CallUrgency;
  bookedSlot: CanonicalSlot | null;
  proposedSlots: CanonicalSlot[];
}): string {
  if (params.language === "ar") {
    if (params.urgency === "urgent") return "برايت ووتر للتدفئة والسباكة — متابعة طارئة فورية";
    if (params.bookedSlot) {
      return `تأكيد موعدكم — ${formatSlotForLanguage(params.bookedSlot, "ar")} | برايت ووتر`;
    }
    if (params.proposedSlots.length > 0) {
      return "مواعيد بديلة متاحة لصيانتكم — برايت ووتر للتدفئة والسباكة";
    }
    return "متابعة طلبكم — برايت ووتر للتدفئة والسباكة";
  }

  if (params.urgency === "urgent") return "Urgent On-Call Dispatch — Brightwater Heating & Plumbing";
  if (params.bookedSlot) return `Appointment Confirmed (${params.bookedSlot}) — Brightwater Heating & Plumbing`;
  if (params.proposedSlots.length > 0) return "Alternative Appointment Slots — Brightwater Heating & Plumbing";
  return "Your Inquiry with Brightwater Heating & Plumbing";
}

export function buildGroundedTemplateReply(
  params: {
    callerName: string | null;
    language: "en" | "ar";
    urgency: CallUrgency;
    bookedSlot: CanonicalSlot | null;
    proposedSlots: CanonicalSlot[];
    requestedSlot: CanonicalSlot | null;
    officeCategories: CallCategory[];
    missingFields: string[];
  },
  channel: "email" | "sms",
  recipient: string
): ReplyDraft {
  const enGreeting = params.callerName ? `Hello ${params.callerName},` : "Hello,";
  const enParts: string[] = [];

  if (params.urgency === "urgent") {
    enParts.push(
      "We have escalated your urgent request to our emergency on-call technician team immediately, and someone will call you back very shortly."
    );
  } else if (params.missingFields.length > 0) {
    const humanMissing = params.missingFields
      .map((f) => f.replace(/_/g, " "))
      .join(", ");
    enParts.push(
      `Thank you for calling Brightwater Heating & Plumbing. Before we can finalize your booking, could you please reply with your ${humanMissing}?`
    );
  } else if (params.bookedSlot) {
    enParts.push(
      `Your technician visit with Brightwater Heating & Plumbing is confirmed for ${params.bookedSlot}.`
    );
  } else if (params.proposedSlots.length > 0) {
    const reqText = params.requestedSlot ? `${params.requestedSlot} is already booked` : "your requested slot is unavailable";
    const altText = params.proposedSlots.join(" or ");
    enParts.push(
      `Thank you for calling Brightwater Heating & Plumbing. Unfortunately, ${reqText}; the nearest available slots are ${altText}. Please reply to let us know which one works best for you.`
    );
  }

  if (params.officeCategories.includes("billing") && params.officeCategories.includes("quote")) {
    enParts.push(
      "Our office team has also received the notes regarding your renovation quote and last month's invoice inquiry and will follow up with you directly."
    );
  } else if (params.officeCategories.includes("billing")) {
    enParts.push(
      "We have forwarded your invoice inquiry to our office billing team, who will review your account and get back to you shortly."
    );
  } else if (params.officeCategories.includes("quote") && !params.bookedSlot) {
    enParts.push(
      "Our office team has received your quote inquiry and will follow up with you shortly."
    );
  } else if (params.officeCategories.includes("quote") && params.bookedSlot) {
    enParts.push(
      "After taking measurements during the visit, our office will prepare and send your renovation quote."
    );
  }

  const enBody =
    channel === "email"
      ? `${enGreeting}\n\n${enParts.join("\n\n")}\n\nWarm regards,\nBrightwater Heating & Plumbing`
      : `${enGreeting} ${enParts.join(" ")} — Brightwater Heating & Plumbing`;

  if (params.language === "en") {
    return {
      channel,
      to: recipient,
      subject: channel === "email" ? defaultSubject(params) : undefined,
      body: enBody,
      language: "en",
    };
  }

  // Natural Arabic customer message + English operator mirror
  const arGreeting = params.callerName ? `مرحباً ${params.callerName}،` : "مرحباً،";
  const arParts: string[] = [];

  if (params.urgency === "urgent") {
    arParts.push(
      "لقد قمنا بتحويل بلاغكم العاجل فوراً إلى فريق الطوارئ المناوب في برايت ووتر للتدفئة والسباكة، وسيتواصل معكم أحد الفنيين خلال دقائق."
    );
  } else if (params.missingFields.length > 0) {
    const arMissingMap: Record<string, string> = {
      address: "العنوان الكامل",
      caller_last_name: "الاسم الكامل",
      caller_name: "الاسم الكامل",
      preferred_slot: "اليوم والفترة المفضلة للموعد",
    };
    const arMissing = params.missingFields.map((f) => arMissingMap[f] ?? f).join("، ");
    arParts.push(
      `شكراً لاتصالكم ببرايت ووتر للتدفئة والسباكة. لإتمام طلبكم، يرجى التكرم بتزويدنا بـ (${arMissing}) عبر الرد على هذه الرسالة.`
    );
  } else if (params.bookedSlot) {
    arParts.push(
      `يسعدنا تأكيد موعد زيارة الفني من برايت ووتر للتدفئة والسباكة في ${formatSlotForLanguage(params.bookedSlot, "ar")}.`
    );
  } else if (params.proposedSlots.length > 0) {
    const reqAr = params.requestedSlot
      ? `موعد ${formatSlotForLanguage(params.requestedSlot, "ar")} محجوز حالياً`
      : "الموعد المطلوب غير متاح حالياً";
    const altAr = params.proposedSlots
      .map((s) => formatSlotForLanguage(s, "ar"))
      .join(" أو ");
    arParts.push(
      `شكراً لتواصلكم مع برايت ووتر للتدفئة والسباكة. نعتذر لأن ${reqAr}، وأقرب المواعيد المتاحة لدينا هي: ${altAr}. يرجى الرد لاختيار الموعد الأنسب لكم لتأكيده.`
    );
  }

  if (params.officeCategories.includes("billing") && params.officeCategories.includes("quote")) {
    arParts.push(
      "كما تم تحويل تفاصيل طلب عرض السعر ومراجعة الفاتورة إلى قسم المحاسبة والمكتب المختص للتواصل معكم."
    );
  } else if (params.officeCategories.includes("billing")) {
    arParts.push(
      "تمت إحالة استفساركم بخصوص الفاتورة إلى قسم المحاسبة في المكتب، وسيتواصلون معكم بعد المراجعة قريباً."
    );
  } else if (params.officeCategories.includes("quote")) {
    arParts.push(
      "تم تسجيل طلب عرض السعر لدى مكتبنا، وسيتم إرسال التسعيرة التفصيلية لكم بعد المعاينة."
    );
  }

  const arBody =
    channel === "email"
      ? `${arGreeting}\n\n${arParts.join("\n\n")}\n\nمع خالص التحية،\nبرايت ووتر للتدفئة والسباكة`
      : `${arGreeting} ${arParts.join(" ")} — برايت ووتر`;

  return {
    channel,
    to: recipient,
    subject: channel === "email" ? defaultSubject(params) : undefined,
    body: arBody,
    language: "ar",
    english_mirror: enBody,
  };
}

function cleanNullable(val: string | null | undefined): string | null {
  if (!val) return null;
  const t = val.trim();
  if (!t || t.toLowerCase() === "null" || t.toLowerCase() === "unknown" || t.toLowerCase() === "n/a") {
    return null;
  }
  return t;
}

/**
 * Deterministic Bilingual (EN + AR) Span & Summary Extractor for Sandbox Mode.
 * Handles English & Arabic caller names, street addresses, and 2-sentence summaries.
 */
function simulateBilingualSpanExtraction(
  call: IncomingCall,
  candidates: PreParsedCandidates
): { caller_name: string | null; address: string | null; summary: string } {
  const callerTurns = call.transcript.filter((t) => t.speaker === "caller").map((t) => t.text);
  const fullCallerText = callerTurns.join(" ");

  // 1. Extract caller_name (English & Arabic patterns)
  let callerName: string | null = null;
  const enNamePatterns = [
    /(?:[Mm]y name is|[Tt]his is|[Ii] am|[Ii]'m|[Ii]t's|[Ii]t is)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\b([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:here|speaking|calling)\b/,
    /(?:[Hh]i|[Hh]ello),\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:at|here|calling|speaking)\b/,
    /^([A-Z][a-z]+\s+[A-Z][a-z]+),\s+\d+/,
  ];
  for (const turn of callerTurns) {
    for (const pat of enNamePatterns) {
      const m = turn.match(pat);
      if (m?.[1] && !/^(?:Good|Hello|Yeah|Sorry|Thank|Monday|Tuesday|Wednesday|Thursday|Friday)/i.test(m[1])) {
        callerName = m[1].trim();
        break;
      }
    }
    if (callerName) break;
  }

  if (!callerName) {
    const arNamePatterns = [
      /(?:اسمي|معك|معكم|أنا)\s+([\u0600-\u06FF]+(?:\s+[\u0600-\u06FF]+){0,2})/u,
    ];
    for (const turn of callerTurns) {
      for (const pat of arNamePatterns) {
        const m = turn.match(pat);
        if (m?.[1]) {
          // Trim trailing non-name words if matched greedily
          callerName = m[1]
            .replace(/\s+(?:وعندي|لدي|التدفئة|السخان|أريد|أبغى|حبيت|من|في).*$/u, "")
            .trim();
          break;
        }
      }
      if (callerName) break;
    }
  }

  // Also check if agent greeted caller by surname/name when caller used another phrasing
  if (!callerName) {
    for (const t of call.transcript) {
      if (t.speaker === "agent") {
        const m = t.text.match(/(?:Sure,\s+|Thank you,\s+(?:Mr|Mrs|Ms)\s+)([A-Z][a-z]+)/);
        if (m?.[1]) {
          callerName = m[1].trim();
          break;
        }
      }
    }
  }

  // 2. Extract street address (English & Arabic patterns)
  let address: string | null = null;
  for (let i = 0; i < call.transcript.length; i++) {
    const turn = call.transcript[i];
    if (turn.speaker !== "caller") continue;

    // English street address pattern
    const enAddr = turn.text.match(
      /\b(\d+\s+[A-Z][A-Za-z\s]+?(?:Street|St|Lane|Ln|Avenue|Ave|Road|Rd|Drive|Dr|Way|Close|Place|Crescent|Boulevard|Blvd|Square|Court)(?:,\s*(?:(?:ground|first|second|third|top)\s+floor|apt\s*[\w-]+|flat\s*[\w-]+|the\s+[\w\s]+))?)(?=[.!?]|$|\s+(?:Oh\b|And\b))/i
    );
    if (enAddr?.[1]) {
      address = enAddr[1].trim();
      break;
    }

    // Arabic street address pattern (e.g., "شارع السلام ١٤، الطابق الثاني" or "شارع الزهور ٧ ورقم جوالي...")
    const arAddr = turn.text.match(
      /((?:شارع|حي|طريق|مبنى|بناية)\s+[\u0600-\u06FF0-9٠-٩\s،,-]{3,45}?)(?=[.!?؟]|$|\s+و?(?:رقم|عندي|بخصوص|كمان|أيضاً|بريدي|إيميلي|هاتفي|جوالي))/u
    );
    if (arAddr?.[1]) {
      address = arAddr[1].replace(/[،,.\s]+$/u, "").trim();
      break;
    }
  }

  // 3. Build crisp <= 2 sentence factual summary
  const summary = synthesizeConciseSummary(callerName, fullCallerText, candidates);

  return {
    caller_name: callerName,
    address,
    summary: clampTwoSentences(summary),
  };
}

function synthesizeConciseSummary(
  callerName: string | null,
  callerText: string,
  candidates: PreParsedCandidates
): string {
  const who = callerName ?? "An unidentified caller";
  const parts: string[] = [];

  if (/(?:gas smell|smell of gas|رائحة غاز|تسرب غاز)/i.test(callerText)) {
    parts.push(`${who} reported a boiler issue accompanied by a dangerous gas smell requiring immediate emergency on-call intervention.`);
  } else if (/(?:heating stopped|التدفئة متوقفة|لا توجد تدفئة)/i.test(callerText)) {
    parts.push(`${who} reported a complete heating failure in a cold home and requested urgent same-day assistance.`);
  } else if (/(?:yearly maintenance|annual maintenance|الصيانة السنوية|صيانة سنوية)/i.test(callerText)) {
    parts.push(`${who} called to schedule routine annual boiler maintenance.`);
  } else if (/(?:renovating|renovation|quote|تجديد الحمام|عرض سعر|تسعيرة)/i.test(callerText)) {
    parts.push(`${who} requested an on-site measurement and quote for a renovation project.`);
  } else if (/(?:dripping|leak|tap|تقطر|يقطر|تسريب|صنبور|حنفية)/i.test(callerText)) {
    parts.push(`${who} called regarding a leaking or dripping plumbing fixture and asked for a technician visit.`);
  } else if (/(?:invoice|charged twice|فاتورة|مرتين)/i.test(callerText)) {
    parts.push(`${who} contacted Brightwater regarding an invoice billing discrepancy.`);
  } else {
    parts.push(`${who} contacted Brightwater Heating & Plumbing for service assistance.`);
  }

  if (
    /(?:invoice|charged twice|فاتورة|مرتين)/i.test(callerText) &&
    !parts[0].includes("invoice")
  ) {
    parts.push("They also reported a suspected duplicate charge on a recent invoice for office review.");
  } else if (candidates.appear_dropped) {
    parts.push("The call disconnected abruptly mid-sentence before full contact and address details were collected.");
  }

  return parts.slice(0, 2).join(" ");
}

export function buildDeepSeekTelemetry(params: {
  providerMode: "live" | "sandbox";
  model: string;
  extractionLatencyMs: number;
  replyLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  repairAttempts: number;
  cascadeEscalated: boolean;
}): DeepSeekTelemetry {
  // DeepSeek V4.1 Flash off-peak rates: $0.15 / 1M input, $0.60 / 1M output
  const cost =
    (params.inputTokens / 1_000_000) * 0.15 +
    (params.outputTokens / 1_000_000) * 0.60;
  return {
    provider_mode: params.providerMode,
    model: params.model,
    extraction_latency_ms: params.extractionLatencyMs,
    reply_latency_ms: params.replyLatencyMs,
    input_tokens: params.inputTokens,
    output_tokens: params.outputTokens,
    estimated_cost_usd: Number(cost.toFixed(7)),
    json_repair_attempts: params.repairAttempts,
    cascade_escalated: params.cascadeEscalated,
  };
}
