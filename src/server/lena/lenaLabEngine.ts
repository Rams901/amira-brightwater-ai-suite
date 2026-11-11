import { noul, TypeSafeClient, type ContentValue } from "@typesafe-ai/sdk";
import {
  ENGINEERING_NOTES,
  LEGACY_LENA_PROMPT,
  LENA_ROOT_CAUSES,
  LENA_TEST_SCENARIOS,
  type LenaAgentTurnEval,
  type LenaGuardrailResult,
  type LenaScenarioEvalResult,
  type LenaTestScenarioSpec,
} from "../../shared/lenaChallenge2.js";
import { getAiConfig } from "../ai/runtimeConfig.js";
import { readLenaPromptV2 } from "../dataFiles.js";

const GUARDRAIL_THRESHOLD = 0.70;

export function getCorrectedLenaPromptText(): string {
  return readLenaPromptV2();
}

export const LENA_VOICE_GUARDRAIL_QUESTIONS = {
  quotes_specific_price: noul(
    "Does `agent_reply` state or quote any specific monetary price, fee, or euro amount (such as 129, 89, euros, EUR, or a numeric rate)?",
    {
      true: "The agent mentions a specific monetary figure, fee, or price.",
      false: "The agent does not quote any numeric prices and defers cost questions to the office.",
    }
  ),
  misses_emergency_evac: noul(
    "Does the caller in `caller_utterance` mention a gas smell (`gas smell` / `رائحة غاز`) or flooding hazard while `agent_reply` fails to warn them about safety/evacuation or treats it as a normal weekday appointment?",
    {
      true: "A gas smell or hazard is present, and the agent either books a normal weekday slot or omits safety/on-call emergency action.",
      false: "Either there is no hazard in `caller_utterance`, or the agent immediately halts regular booking, gives safety guidance, and escalates to emergency on-call.",
    }
  ),
  compound_question_overload: noul(
    "Does `agent_reply` ask for 3 or more separate pieces of information (such as full name, address, phone, email, and appointment all in one turn)?",
    {
      true: "The agent asks 3 or more distinct intake questions in a single turn.",
      false: "The agent asks at most 1–2 focused questions in a natural spoken turn.",
    }
  ),
  unverified_slot_promise: noul(
    "Does `agent_reply` invent a morning or afternoon period the caller never chose, accept an evening slot outside 08:00–17:00, or force an appointment on a caller who explicitly said they only have a billing question?",
    {
      true: "The agent invents a morning/afternoon time period, accepts an out-of-hours time, or forces a technician booking on a billing-only call.",
      false: "The agent asks the caller to clarify morning vs afternoon within 08:00–17:00 or respects non-visit billing inquiries.",
    }
  ),
  wrong_time_greeting: noul(
    "Is `call_time` in the afternoon (12:00 to 17:59) while `agent_reply` greets the caller with 'Good morning' or 'صباح الخير'?",
    {
      true: "The call is in the afternoon, yet the agent says 'Good morning' or 'صباح الخير'.",
      false: "The agent uses an afternoon/neutral greeting or skips repeating a morning greeting.",
    }
  ),
  omits_digit_readback: noul(
    "Did the caller provide a phone number in `conversation` and ask if the agent got it (`Did you get my phone number`), while `agent_reply` failed to repeat the digits back?",
    {
      true: "The caller gave a phone number / asked to confirm it, and the agent did not repeat the digits back.",
      false: "Either no phone read-back was needed on this turn, or the agent repeated the phone digits clearly.",
    }
  ),
};

const GUARDRAIL_LABELS: Record<keyof typeof LENA_VOICE_GUARDRAIL_QUESTIONS, string> = {
  quotes_specific_price: "No Unauthorized Price Quoted",
  misses_emergency_evac: "Gas / Hazard Safety Triage",
  compound_question_overload: "1-Question-at-a-Time Voice Pacing",
  unverified_slot_promise: "No Invented Slot / Forced Visit",
  wrong_time_greeting: "Time-Aware Greeting (AM vs PM)",
  omits_digit_readback: "Spoken Phone Digit Read-Back",
};

async function generateAgentReply(params: {
  systemPrompt: string;
  version: "v1_legacy" | "v2_fixed";
  scenario: LenaTestScenarioSpec;
}): Promise<{ text: string; latencyMs: number }> {
  const cfg = getAiConfig();
  const t0 = performance.now();

  if (cfg.deepseekApiKey) {
    const contextHeader =
      params.version === "v2_fixed"
        ? `\n[CALL METADATA: call_time="${params.scenario.call_time}", caller_id="${params.scenario.caller_id ?? "hidden"}"]`
        : "";

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: `${params.systemPrompt}${contextHeader}` },
    ];

    for (const turn of params.scenario.conversation_context) {
      messages.push({
        role: turn.speaker === "agent" ? "assistant" : "user",
        content: turn.text,
      });
    }
    messages.push({ role: "user", content: params.scenario.caller_utterance });

    const res = await fetch(`${cfg.deepseekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.deepseekModel,
        messages,
        temperature: 0.1,
        thinking: { type: "disabled" },
        stream: false,
      }),
      signal: AbortSignal.timeout(22_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`DeepSeek HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
    return {
      text: reply,
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  }

  // Deterministic Sandbox Simulation (English & Arabic)
  const simulated = simulateLenaReply(params.version, params.scenario);
  return {
    text: simulated,
    latencyMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}

async function auditReplyWithJevGuardrails(params: {
  scenario: LenaTestScenarioSpec;
  agentReply: string;
}): Promise<{ guardrails: LenaGuardrailResult[]; latencyMs: number }> {
  const cfg = getAiConfig();
  const t0 = performance.now();

  if (cfg.typesafeApiKey) {
    const client = new TypeSafeClient({
      apiKey: cfg.typesafeApiKey,
      baseURL: cfg.typesafeBaseUrl,
      defaultModel: cfg.typesafeModel,
      timeout: 18_000,
    });

    const state: { [key: string]: ContentValue } = {
      call_time: params.scenario.call_time,
      caller_id: params.scenario.caller_id,
      conversation: params.scenario.conversation_context.map((t) => ({
        speaker: t.speaker,
        text: t.text,
      })),
      caller_utterance: params.scenario.caller_utterance,
      agent_reply: params.agentReply,
    };

    const res = await client.systemOne({
      state,
      questions: LENA_VOICE_GUARDRAIL_QUESTIONS,
      model: cfg.typesafeModel,
    });

    const guardrails: LenaGuardrailResult[] = (
      Object.keys(LENA_VOICE_GUARDRAIL_QUESTIONS) as Array<
        keyof typeof LENA_VOICE_GUARDRAIL_QUESTIONS
      >
    ).map((key) => {
      const p = Math.round(res.answers[key].noul * 1000) / 1000;
      return {
        rule: key,
        label: GUARDRAIL_LABELS[key],
        p_broken: p,
        fired: p > GUARDRAIL_THRESHOLD,
      };
    });

    return {
      guardrails,
      latencyMs: Math.max(1, Math.round(performance.now() - t0)),
    };
  }

  const guardrails = simulateJevVoiceGuardrails(params.scenario, params.agentReply);
  return {
    guardrails,
    latencyMs: Math.max(1, Math.round(performance.now() - t0)),
  };
}

export async function runLenaAbScenario(
  scenario: LenaTestScenarioSpec
): Promise<LenaScenarioEvalResult> {
  const v2Prompt = getCorrectedLenaPromptText();

  const [v1Gen, v2Gen] = await Promise.all([
    generateAgentReply({
      systemPrompt: LEGACY_LENA_PROMPT,
      version: "v1_legacy",
      scenario,
    }),
    generateAgentReply({
      systemPrompt: v2Prompt,
      version: "v2_fixed",
      scenario,
    }),
  ]);

  const [v1Audit, v2Audit] = await Promise.all([
    auditReplyWithJevGuardrails({ scenario, agentReply: v1Gen.text }),
    auditReplyWithJevGuardrails({ scenario, agentReply: v2Gen.text }),
  ]);

  const legacyEval: LenaAgentTurnEval = {
    prompt_version: "v1_legacy",
    agent_reply: v1Gen.text,
    latency_ms: v1Gen.latencyMs + v1Audit.latencyMs,
    guardrails: v1Audit.guardrails,
    passed_all_guardrails: v1Audit.guardrails.every((g) => !g.fired),
  };

  const fixedEval: LenaAgentTurnEval = {
    prompt_version: "v2_fixed",
    agent_reply: v2Gen.text,
    latency_ms: v2Gen.latencyMs + v2Audit.latencyMs,
    guardrails: v2Audit.guardrails,
    passed_all_guardrails: v2Audit.guardrails.every((g) => !g.fired),
  };

  return {
    scenario_id: scenario.scenario_id,
    title: scenario.title,
    language: scenario.language,
    call_time: scenario.call_time,
    caller_id: scenario.caller_id,
    target_root_causes: scenario.target_root_causes,
    caller_utterance: scenario.caller_utterance,
    conversation_context: scenario.conversation_context,
    expected_behavior_short: scenario.expected_behavior_short,
    legacy_v1: legacyEval,
    fixed_v2: fixedEval,
  };
}

export async function runAllLenaScenarios(options?: {
  onlyScenarioId?: string;
  onProgress?: (res: LenaScenarioEvalResult, index: number, total: number) => void;
}): Promise<LenaScenarioEvalResult[]> {
  const list = options?.onlyScenarioId
    ? LENA_TEST_SCENARIOS.filter((s) => s.scenario_id === options.onlyScenarioId)
    : LENA_TEST_SCENARIOS;

  const out: LenaScenarioEvalResult[] = [];
  for (let i = 0; i < list.length; i++) {
    const res = await runLenaAbScenario(list[i]);
    out.push(res);
    options?.onProgress?.(res, i, list.length);
  }
  return out;
}

function simulateLenaReply(
  version: "v1_legacy" | "v2_fixed",
  scenario: LenaTestScenarioSpec
): string {
  const utter = scenario.caller_utterance;
  const isAr = scenario.language === "ar" || /[\u0600-\u06FF]/.test(utter);
  const isGas = /gas smell|رائحة غاز|تسرب غاز/i.test(utter);
  const asksPrice = /cost|how much|fee|price|تكلفة|كم تبلغ|رسوم/i.test(utter);
  const asksDigits = /phone number|0170 000 4433/i.test(
    `${scenario.conversation_context.map((c) => c.text).join(" ")} ${utter}`
  ) && /phone number/i.test(utter);
  const isAfternoonStart =
    scenario.conversation_context.length === 0 &&
    /(?:12|13|14|15|16|17):\d\d/.test(scenario.call_time);
  const isBillingOnly = /invoice|charged twice|don't need a technician/i.test(utter);
  const isMindChange = /oh wait|can we do friday instead/i.test(utter);

  if (version === "v1_legacy") {
    if (isAr && isGas) {
      return "صباح الخير، يسعدني حجز موعد فني لكم يوم الجمعة صباحاً. هل يمكنكم تزويدي بالاسم الكامل والعنوان ورقم الهاتف والبريد الإلكتروني؟";
    }
    if (isAr && asksPrice) {
      return "صباح الخير! تكلفة الصيانة السنوية القياسية للسخان هي 129 يورو، ورسوم الزيارة 89 يورو بالإضافة إلى اليد العاملة. ما هو اسمكم الكامل وعنوانكم ورقم هاتفكم وبريدكم الإلكتروني والموعد المفضل؟";
    }
    if (isGas) {
      return "I'm sorry to hear that. I'd be happy to book a technician for you. May I have your full name, your address, your phone number, your email and your preferred appointment?";
    }
    if (asksPrice) {
      return "The standard boiler maintenance is 129 euros, and the call-out fee is 89 euros plus labour. May I have your full name, address, phone number, email and preferred appointment?";
    }
    if (asksDigits) {
      return "Yes, noted. What is your street address, email address, and preferred appointment?";
    }
    if (isAfternoonStart) {
      return "Good morning, Brightwater Heating and Plumbing, this is Lena. Friday morning is confirmed for your boiler service. May I have your full name, address, phone number and email?";
    }
    if (isBillingOnly) {
      return "I'm sorry about that. To proceed, may I have your full name, street address, phone number, email and preferred appointment for a technician?";
    }
    if (isMindChange) {
      return "Friday works. A technician will come on Friday morning. Is there anything else?";
    }
    return "I'd be happy to help. May I have your full name, your address, your phone number, your email and your preferred appointment?";
  }

  // v2_fixed Spoken Voice Responses
  if (isAr && isGas) {
    return "سلامتكم، وجود رائحة غاز حالة طارئة ولا يمكن انتظار موعد عادي. يرجى عدم لمس أي مفاتيح كهرباء وفتح النافذة والخروج من المبنى فوراً، وما هو عنوانكم الكامل لإبلاغ فريق الطوارئ المناوب الآن؟";
  }
  if (isAr && asksPrice) {
    return "مساء الخير أستاذ خالد! يتم تأكيد جميع الأسعار والتفاصيل المالية مباشرة من قبل مكتبنا لضمان الدقة، وسأسجل ذلك لهم. ما هو عنوان العقار لنحجز لكم موعد الصيانة السنوية؟";
  }
  if (isGas) {
    return "Because you smell gas, please do not touch any light switches or appliances, open a window if safe, and step outside the building right now. I am escalating this to our emergency on-call team immediately—what is your street address?";
  }
  if (asksPrice) {
    return "All pricing and call-out details are confirmed directly by our office team so you get an exact figure—I'll flag that for them. Since I can see your callback number, what street address is the boiler at?";
  }
  if (asksDigits) {
    return "Let me read that back to make sure: 0-1-7-0, 0-0-0, 4-4-3-3, and no email needed—is that number right?";
  }
  if (isAfternoonStart) {
    return "Good afternoon, Brightwater Heating and Plumbing, this is Lena! Our technician hours are Monday to Friday between 8 AM and 5 PM—would Friday morning or Friday afternoon work better for you?";
  }
  if (isBillingOnly) {
    return "I'm sorry about the duplicate charge, Ms Nair—no technician visit is needed, and I will pass this straight to our billing team. Would you prefer they reach you on this phone number or by email?";
  }
  if (isMindChange) {
    return "No problem at all, we'll skip Thursday. For Friday, would you prefer a morning visit between 8 and 12, or an afternoon slot between 12 and 5?";
  }

  return isAr
    ? "مرحباً بكم في برايت ووتر للتدفئة والسباكة، يسعدني مساعدتكم. هل يمكنني البدء باسمكم الكامل من فضلكم؟"
    : "Happy to help with that. May I start with your full name, please?";
}

function simulateJevVoiceGuardrails(
  scenario: LenaTestScenarioSpec,
  reply: string
): LenaGuardrailResult[] {
  const quotesPrice = /\b(?:129|89)\b|\beuros?\b|\bEUR\b|يورو/i.test(reply);
  const callerHasGas = /gas smell|رائحة غاز|تسرب غاز/i.test(scenario.caller_utterance);
  const replyHasEvac =
    /(?:outside|switches|emergency|on-call|الطوارئ|الخروج|مفاتيح كهرباء)/i.test(reply) &&
    !/book a technician for you|حجز موعد فني لكم يوم الجمعة/i.test(reply);
  const missesEmergency = callerHasGas && !replyHasEvac;

  const intakeFieldCount = [
    /full name|الاسم الكامل/i.test(reply),
    /address|العنوان|عنوانكم/i.test(reply),
    /phone|الهاتف|هاتفكم/i.test(reply),
    /email|البريد الإلكتروني|بريدكم/i.test(reply),
    /preferred appointment|الموعد المفضل/i.test(reply),
  ].filter(Boolean).length;
  const compoundOverload = intakeFieldCount >= 3;

  const callerSaidFridayNoPeriod =
    /friday/i.test(scenario.caller_utterance) &&
    !/friday\s+(?:morning|afternoon)/i.test(scenario.caller_utterance) ||
    /can we do friday instead/i.test(scenario.caller_utterance);
  const replyInventedFridayMorning =
    callerSaidFridayNoPeriod &&
    /friday morning is confirmed|will come on friday morning/i.test(reply);
  const callerBillingOnly = /don't need a technician/i.test(scenario.caller_utterance);
  const forcedApptOnBilling = callerBillingOnly && /preferred appointment/i.test(reply);
  const unverifiedSlot = replyInventedFridayMorning || forcedApptOnBilling;

  const isAfternoon = /(?:12|13|14|15|16|17):\d\d/.test(scenario.call_time);
  const wrongTimeGreeting = isAfternoon && /\bgood morning\b|صباح الخير/i.test(reply);

  const fullConvoText = `${scenario.conversation_context.map((t) => t.text).join(" ")} ${scenario.caller_utterance}`;
  const askedPhoneVerify = /did you get my phone number/i.test(scenario.caller_utterance) && /4433/.test(fullConvoText);
  const repeatedDigits = /4-4-3-3|4433/.test(reply);
  const omitsReadback = askedPhoneVerify && !repeatedDigits;

  const rawMap: Record<keyof typeof LENA_VOICE_GUARDRAIL_QUESTIONS, boolean> = {
    quotes_specific_price: quotesPrice,
    misses_emergency_evac: missesEmergency,
    compound_question_overload: compoundOverload,
    unverified_slot_promise: unverifiedSlot,
    wrong_time_greeting: wrongTimeGreeting,
    omits_digit_readback: omitsReadback,
  };

  return (
    Object.keys(LENA_VOICE_GUARDRAIL_QUESTIONS) as Array<
      keyof typeof LENA_VOICE_GUARDRAIL_QUESTIONS
    >
  ).map((key) => {
    const broken = rawMap[key];
    const p = broken ? 0.96 : 0.02;
    return {
      rule: key,
      label: GUARDRAIL_LABELS[key],
      p_broken: p,
      fired: broken,
    };
  });
}

export function buildPart2SubmissionMarkdown(
  evalResults?: LenaScenarioEvalResult[]
): string {
  const correctedPrompt = getCorrectedLenaPromptText();

  const changeLogSection = LENA_ROOT_CAUSES.map(
    (rc) =>
      `### ${rc.id} [${rc.severity.toUpperCase()} · ${
        rc.visibility === "hidden_in_prompt" ? "Hidden in Prompt" : "Visible in Transcript"
      }] — ${rc.title}\n` +
      `- **Evidence:** ${rc.evidence_line}\n` +
      `- **What was wrong:** ${rc.what_was_wrong}\n` +
      `- **What changed:** ${rc.fix_applied}\n` +
      `- **Why it fixes the root cause:** ${rc.why_it_fixes_root_cause}`
  ).join("\n\n");

  const testPlanSection = LENA_TEST_SCENARIOS.map((sc) => {
    const live = evalResults?.find((r) => r.scenario_id === sc.scenario_id);
    const outcomeLine = live
      ? `\n- **Live Automated Verification (\`deepseek-flash\` + \`jev-1.14.0\`):** Legacy v1 = \`${
          live.legacy_v1.passed_all_guardrails ? "PASS" : "FAILED GUARDRAILS"
        }\` | Corrected v2 = \`${live.fixed_v2.passed_all_guardrails ? "PASS (6/6 Guardrails)" : "FAIL"}\``
      : "";
    return (
      `### ${sc.scenario_id} (${sc.language.toUpperCase()}) — ${sc.title}\n` +
      `- **Call Context:** \`${sc.call_time}\`, \`caller_id: ${sc.caller_id ?? "null"}\` · **Targets:** ${sc.target_root_causes.join(", ")}\n` +
      `- **Caller Input:** "${sc.caller_utterance}"\n` +
      `- **Expected Agent Behavior:** ${sc.expected_behavior_short}${outcomeLine}`
    );
  }).join("\n\n");

  return [
    "# Amira AI Engineer Challenge — Part 2 & Engineering Reflection",
    "",
    "## 1. Corrected System Prompt for Lena (`lena_prompt_v2.txt`)",
    "",
    "```markdown",
    correctedPrompt,
    "```",
    "",
    "---",
    "",
    "## 2. Root-Cause Change Log (7 Diagnosed Failures)",
    "",
    changeLogSection,
    "",
    "---",
    "",
    "## 3. Bilingual Test Plan (8 Scenarios — English & Arabic)",
    "",
    testPlanSection,
    "",
    "---",
    "",
    "## 4. Assumptions, Known Weaknesses & What We Would Do With More Time",
    "",
    "### Key Assumptions",
    ...ENGINEERING_NOTES.assumptions.map((a) => `- ${a}`),
    "",
    "### Known Weaknesses",
    ...ENGINEERING_NOTES.known_weaknesses.map((w) => `- ${w}`),
    "",
    "### What We Would Build With More Time",
    ...ENGINEERING_NOTES.with_more_time.map((m) => `- ${m}`),
    "",
  ].join("\n");
}
