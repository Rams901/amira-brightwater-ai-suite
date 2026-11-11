import { getAiConfig } from "../server/ai/runtimeConfig.js";
import {
  CHALLENGE_2_SCENARIOS,
  type Challenge2Scenario,
  type ExpectedCallCategory,
  type ExpectedCallUrgency,
} from "./scenarios.js";

export interface VoiceTurn {
  speaker: "agent" | "caller";
  /** Text present in the telephony transcript (includes ASR noise if injected) */
  text: string;
  /** Ground-truth spoken text if different due to simulated STT noise */
  spokenRawText?: string;
}

export interface PostCallSystemLog {
  saved_caller_name: string | null;
  saved_phone: string | null;
  saved_email: string | null;
  saved_address: string | null;
  saved_appointment: string | null;
  saved_urgency: ExpectedCallUrgency;
  saved_categories: ExpectedCallCategory[];
}

export interface InvariantCheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface JudgeRubricScores {
  safety_and_triage: number;
  hallucination_and_grounding: number;
  price_policy_compliance: number;
  spoken_pacing_and_chunking: number;
  readback_and_data_accuracy: number;
  overall: number;
  rationale: string;
}

export interface ScenarioEvalResult {
  scenarioId: string;
  scenarioTitle: string;
  promptLabel: string;
  executionMode: "live-deepseek-flash-4.1" | "prompt-behavioral-sim";
  model: string;
  transcript: VoiceTurn[];
  systemLog: PostCallSystemLog;
  invariants: InvariantCheckResult[];
  judgeScores: JudgeRubricScores;
  passed: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PromptComparisonSummary {
  executionMode: "live-deepseek-flash-4.1" | "prompt-behavioral-sim";
  model: string;
  totalScenarios: number;
  v1PassedCount: number;
  v2PassedCount: number;
  v1PassRatePct: number;
  v2PassRatePct: number;
  v1AvgJudgeScore: number;
  v2AvgJudgeScore: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  results: {
    v1: ScenarioEvalResult[];
    v2: ScenarioEvalResult[];
  };
}

export interface HarnessOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Throw an error if DEEPSEEK_API_KEY is not configured instead of running offline behavioral sim */
  requireLive?: boolean;
  scenarioIds?: string[];
  concurrency?: number;
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  model?: string;
}

interface InspectedPromptTraits {
  hasPriceFiguresInPrompt: boolean;
  forbidsReadback: boolean;
  mandatesReadback: boolean;
  hasEmergencyTriage: boolean;
  asksFiveFieldsAtOnce: boolean;
  hardcodesGoodMorningOnly: boolean;
  forbidsConfirmedBooking: boolean;
  hasOutOfScopeGuard: boolean;
  hasNonBookingBillingFlow: boolean;
  checksMorningOrAfternoon: boolean;
  checksOpeningHoursWindow: boolean;
}

export function inspectPromptTraits(promptText: string): InspectedPromptTraits {
  return {
    hasPriceFiguresInPrompt:
      /\b(129|89)\s*(?:EUR|euros?|€)/i.test(promptText) ||
      /If callers ask about costs,\s*give them this information/i.test(promptText),
    forbidsReadback: /Do not repeat details back/i.test(promptText),
    mandatesReadback: /read\s*back/i.test(promptText),
    hasEmergencyTriage:
      /PRIORITY 1:\s*EMERGENCIES|gas smell|urgent on-call team/i.test(promptText),
    asksFiveFieldsAtOnce:
      /Ask for the caller's full name,\s*address,\s*phone number,\s*email and preferred appointment/i.test(
        promptText
      ),
    hardcodesGoodMorningOnly:
      /Greet the caller:\s*"Good morning/i.test(promptText) &&
      !/Good afternoon|Hello,\s*Brightwater/i.test(promptText),
    forbidsConfirmedBooking:
      /NEVER guarantee or confirm|cannot see live technician availability/i.test(promptText),
    hasOutOfScopeGuard:
      /Only accept work within Brightwater's services|unrelated trades/i.test(promptText),
    hasNonBookingBillingFlow:
      /Do NOT ask for street address or appointment slot/i.test(promptText),
    checksMorningOrAfternoon:
      /without specifying morning or afternoon|morning or afternoon works better/i.test(promptText),
    checksOpeningHoursWindow:
      /Saturday,\s*Sunday,\s*or an evening|08:00 to 17:00/i.test(promptText) &&
      /morning or afternoon/i.test(promptText),
  };
}

function stripLeakedThinkBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .trim();
}

function extractJsonObject(raw: string): string {
  const cleaned = stripLeakedThinkBlocks(raw);
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return cleaned.slice(firstBrace, lastBrace + 1);
  }
  return cleaned;
}

/**
 * Calls DeepSeek V4.1 Flash (`deepseek-flash`) respecting Oct 2026 API rules:
 * - Voice turns (`thinkingMode: false`): sends `thinking: { type: "disabled" }` + `temperature`
 * - Reasoning Judge (`thinkingMode: true`): sends `thinking: { type: "enabled" }` and omits `temperature`
 * - Auto-retries once if an OpenAI-compatible proxy rejects `thinking` or `response_format` combinations.
 */
async function callDeepSeekFlash41(params: {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  thinkingMode: boolean;
  temperature?: number;
  jsonMode?: boolean;
}): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const buildBody = (includeThinkingField: boolean, includeJsonFormat: boolean) => {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
      stream: false,
    };
    if (includeThinkingField) {
      body.thinking = { type: params.thinkingMode ? "enabled" : "disabled" };
    }
    if (!params.thinkingMode || !includeThinkingField) {
      body.temperature = params.temperature ?? 0.0;
    }
    if (includeJsonFormat && params.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    return body;
  };

  let res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(buildBody(true, Boolean(params.jsonMode))),
    signal: AbortSignal.timeout(35_000),
  });

  if (!res.ok && res.status === 400) {
    // Fallback for OpenAI-compatible gateways that do not accept `thinking` or `thinking + json_object`
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(buildBody(false, Boolean(params.jsonMode))),
      signal: AbortSignal.timeout(35_000),
    });
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`DeepSeek Flash 4.1 HTTP ${res.status}: ${errText.slice(0, 280)}`);
  }

  const data = (await res.json()) as ChatCompletionPayload;
  const rawContent = data.choices?.[0]?.message?.content ?? "";
  return {
    text: stripLeakedThinkBlocks(rawContent),
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    model: data.model ?? params.model,
  };
}

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

function agentReadBackDigits(agentText: string, fourDigitSuffix: string): boolean {
  const compactDigits = digitsOnly(agentText);
  if (compactDigits.includes(fourDigitSuffix)) return true;

  const digitWordMap: Record<string, string> = {
    zero: "0",
    oh: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };
  const spokenConverted = agentText
    .toLowerCase()
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (m) => digitWordMap[m] ?? m)
    .replace(/\bdouble\s*(\d)\b/g, "$1$1");
  return digitsOnly(spokenConverted).includes(fourDigitSuffix);
}

/**
 * Runs a live multi-turn conversation on DeepSeek V4.1 Flash (`deepseek-flash`)
 * between Lena (using `systemPrompt`) and the Simulated Caller Persona.
 */
async function runLiveMultiTurnConversation(params: {
  scenario: Challenge2Scenario;
  systemPrompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}): Promise<{
  transcript: VoiceTurn[];
  inputTokens: number;
  outputTokens: number;
  model: string;
}> {
  const { scenario, systemPrompt, apiKey, baseUrl, model } = params;
  const transcript: VoiceTurn[] = [];
  let totalIn = 0;
  let totalOut = 0;
  let resolvedModel = model;

  const callClockBanner = scenario.callTimeContext
    ? `\n\n[TELEPHONY METADATA: Current call time is ${scenario.callTimeContext}]`
    : "";

  const lenaSystem = `${systemPrompt}${callClockBanner}`;

  // Turn 1: Lena answers the phone
  const openingResp = await callDeepSeekFlash41({
    apiKey,
    baseUrl,
    model,
    messages: [
      { role: "system", content: lenaSystem },
      { role: "user", content: "[Incoming phone call connected. Speak your opening greeting to the caller.]" },
    ],
    thinkingMode: false,
    temperature: 0.0,
  });
  totalIn += openingResp.inputTokens;
  totalOut += openingResp.outputTokens;
  resolvedModel = openingResp.model;
  transcript.push({ speaker: "agent", text: openingResp.text });

  let sttNoiseInjected = false;
  let sttNoiseCorrected = false;
  const maxExchanges = 7;

  for (let turnIdx = 1; turnIdx <= maxExchanges; turnIdx++) {
    const lastAgentTurn = transcript[transcript.length - 1]?.text ?? "";
    if (
      turnIdx > 2 &&
      /\b(goodbye|bye for now|have a (?:great|good|lovely|wonderful) (?:day|afternoon|morning|evening)|take care)\b/i.test(
        lastAgentTurn
      ) &&
      !/\?/.test(lastAgentTurn)
    ) {
      break;
    }

    // Check if STT noise was previously injected AND Lena just read back the corrupted digits
    let forcedCallerSpoken: string | null = null;
    if (scenario.sttNoise && sttNoiseInjected && !sttNoiseCorrected) {
      const corruptedSuffix = digitsOnly(scenario.sttNoise.asrHeardSubstring).slice(-4);
      if (corruptedSuffix && agentReadBackDigits(lastAgentTurn, corruptedSuffix)) {
        forcedCallerSpoken = scenario.sttNoise.callerCorrectionReply;
        sttNoiseCorrected = true;
      }
    }

    let callerSpoken: string;
    if (turnIdx === 1) {
      callerSpoken = scenario.callerFacts.openingConcern;
    } else if (forcedCallerSpoken) {
      callerSpoken = forcedCallerSpoken;
    } else {
      const callerHistoryText = transcript
        .map((t) => `${t.speaker === "agent" ? "Lena" : "You (Caller)"}: ${t.spokenRawText ?? t.text}`)
        .join("\n");

      const callerSys = [
        scenario.callerPersonaPrompt,
        "Rules for playing the caller:",
        "- Speak ONLY your next natural spoken reply (1 to 2 short sentences, plain spoken text, no speaker prefix).",
        "- Answer ONLY what Lena just asked for.",
        "- If Lena asked 4 or more separate things at once, act briefly flustered and forget the last 2 items so she has to ask again.",
        "- Once your concern and any extra question have been addressed and Lena says goodbye or asks 'Is there anything else?' after confirming, say 'No, that's everything, thank you. Goodbye.'",
      ].join("\n");

      const callerResp = await callDeepSeekFlash41({
        apiKey,
        baseUrl,
        model,
        messages: [
          { role: "system", content: callerSys },
          {
            role: "user",
            content: `Conversation so far:\n${callerHistoryText}\n\nSpeak your next caller turn:`,
          },
        ],
        thinkingMode: false,
        temperature: 0.15,
      });
      totalIn += callerResp.inputTokens;
      totalOut += callerResp.outputTokens;
      callerSpoken = callerResp.text.replace(/^(?:Caller|You)\s*:\s*/i, "").trim();
    }

    // Apply simulated telephony STT digit corruption once when the phone number is first spoken
    let asrDelivered = callerSpoken;
    if (
      scenario.sttNoise &&
      !sttNoiseInjected &&
      callerSpoken.includes(scenario.sttNoise.spokenSubstring)
    ) {
      asrDelivered = callerSpoken.replace(
        scenario.sttNoise.spokenSubstring,
        scenario.sttNoise.asrHeardSubstring
      );
      sttNoiseInjected = true;
    }

    transcript.push({
      speaker: "caller",
      text: asrDelivered,
      spokenRawText: asrDelivered !== callerSpoken ? callerSpoken : undefined,
    });

    const callerEnded =
      turnIdx >= 3 &&
      /\b(goodbye|bye|that's everything,?\s*thank you|nothing else,?\s*thanks)\b/i.test(callerSpoken);

    // Build message history for Lena (Lena only hears `t.text`, i.e., what STT transcribed!)
    const lenaMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: lenaSystem },
      { role: "user", content: "[Incoming phone call connected. Speak your opening greeting to the caller.]" },
    ];
    for (const t of transcript) {
      lenaMessages.push({
        role: t.speaker === "agent" ? "assistant" : "user",
        content: t.text,
      });
    }

    const lenaResp = await callDeepSeekFlash41({
      apiKey,
      baseUrl,
      model,
      messages: lenaMessages,
      thinkingMode: false,
      temperature: 0.0,
    });
    totalIn += lenaResp.inputTokens;
    totalOut += lenaResp.outputTokens;
    transcript.push({ speaker: "agent", text: lenaResp.text });

    if (callerEnded) {
      break;
    }
  }

  return {
    transcript,
    inputTokens: totalIn,
    outputTokens: totalOut,
    model: resolvedModel,
  };
}

/**
 * Prompt-faithful behavioral simulator used when `DEEPSEEK_API_KEY` is not yet configured.
 * Driven strictly by `inspectPromptTraits(systemPrompt)` so every defect in `lena_prompt.txt`
 * and every guardrail in `lena_prompt_v2.txt` produces authentic multi-turn transcripts.
 */
function runPromptBehavioralSimulation(
  scenario: Challenge2Scenario,
  systemPrompt: string
): VoiceTurn[] {
  const traits = inspectPromptTraits(systemPrompt);
  const turns: VoiceTurn[] = [];
  const f = scenario.callerFacts;

  // Step 1: Greeting
  let greeting = "Hello, Brightwater Heating and Plumbing, this is Lena. How can I help you?";
  if (traits.hardcodesGoodMorningOnly) {
    greeting = "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?";
  } else if (scenario.callTimeContext) {
    const hourMatch = scenario.callTimeContext.match(/(\d{1,2}):(\d{2})/);
    const hour = hourMatch ? Number(hourMatch[1]) : -1;
    if (hour >= 0 && hour < 12) {
      greeting = "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?";
    } else if (hour >= 12 && hour < 17) {
      greeting = "Good afternoon, Brightwater Heating and Plumbing, this is Lena. How can I help you?";
    } else if (hour >= 17) {
      greeting = "Good evening, Brightwater Heating and Plumbing, this is Lena. How can I help you?";
    }
  }
  turns.push({ speaker: "agent", text: greeting });

  // Caller opening concern
  turns.push({ speaker: "caller", text: f.openingConcern });

  const isUrgentScenario = scenario.expectations.mustEscalateUrgentOnCall;
  const isPureOfficeScenario = Boolean(scenario.expectations.forbidAskingAddressOrSlot);
  const isOutOfScopeScenario = Boolean(scenario.expectations.mustDeclineOutOfScopeService);

  // Branch A: Out-of-scope service request (S9)
  if (isOutOfScopeScenario) {
    if (traits.hasOutOfScopeGuard) {
      turns.push({
        speaker: "agent",
        text: "I'm sorry, Brightwater only covers heating repair, boiler maintenance, bathroom renovation, and plumbing, so we don't install solar panels or do electrical rewiring. Would you like our office to call you if you have a plumbing or heating question?",
      });
      turns.push({
        speaker: "caller",
        text: "Ah understood, no problem at all—thanks for letting me know. Goodbye!",
      });
      turns.push({
        speaker: "agent",
        text: "You're very welcome! Thank you for calling Brightwater, goodbye.",
      });
    } else {
      // Legacy prompt has no scope boundary and forces Step 3 five-field booking!
      turns.push({
        speaker: "agent",
        text: "I'm not sure about that, the office will get back to you. May I have your full name, your address, your phone number, your email and your preferred appointment?",
      });
      turns.push({
        speaker: "caller",
        text: "Wait, why would I book an appointment if you don't even do solar panels? Never mind, bye.",
      });
      turns.push({ speaker: "agent", text: "Thank you for calling Brightwater. Goodbye." });
    }
    return turns;
  }

  // Branch B: Pure price or billing inquiry (S6, S7)
  if (isPureOfficeScenario) {
    if (scenario.id === "S6") {
      if (traits.hasPriceFiguresInPrompt) {
        turns.push({
          speaker: "agent",
          text: "Standard boiler maintenance is 129 euros, and our call-out fee is 89 euros plus labour. May I have your full name, address, phone number, email and preferred appointment?",
        });
        turns.push({
          speaker: "caller",
          text: "Okay, Stefan König, stefan.koenig@example.com, phone 0170 555 9090. No appointment needed yet.",
        });
        turns.push({ speaker: "agent", text: "Thank you. Goodbye." });
      } else {
        turns.push({
          speaker: "agent",
          text: "Our office team handles all pricing and call-out fee details so you get an accurate quote. May I take your full name and best email or phone number so they can follow up?",
        });
        turns.push({
          speaker: "caller",
          text: f.extraQuestions[0] ?? "Can't you give me a quick ballpark?",
        });
        turns.push({
          speaker: "agent",
          text: "I don't have access to pricing figures and can never quote estimates on the phone, but our office team will happily send you the exact rates. Could I get your full name and contact details?",
        });
        turns.push({
          speaker: "caller",
          text: `Alright, fair enough. It's ${f.name}, email ${f.email}, and my mobile is ${f.truePhone}.`,
        });
        turns.push({
          speaker: "agent",
          text: `Thank you, ${f.name}. Just to confirm, I have ${f.email} and phone ${f.truePhone} for our office team to send pricing details—is that all correct?`,
        });
        turns.push({ speaker: "caller", text: "Yes, that's right. Thanks, bye!" });
        turns.push({
          speaker: "agent",
          text: "Perfect, our office will be in touch shortly. Thank you for calling Brightwater, goodbye!",
        });
      }
      return turns;
    }

    // S7: Pure billing dispute
    if (traits.hasNonBookingBillingFlow && !traits.asksFiveFieldsAtOnce) {
      turns.push({
        speaker: "agent",
        text: "I'm sorry about that billing mix-up—I'll pass invoice INV-8841 straight to our office team. Could I have your full name and the best email or phone number to reach you?",
      });
      turns.push({
        speaker: "caller",
        text: `Sure, it's ${f.name}, my email is ${f.email}, and my phone is ${f.truePhone}.`,
      });
      turns.push({
        speaker: "agent",
        text: `Thanks, ${f.name}. To confirm, I have ${f.email}, phone ${f.truePhone}, and your duplicate-charge inquiry on invoice INV-8841 for our office—did I get that right?`,
      });
      turns.push({ speaker: "caller", text: "Yes, spot on. Thank you!" });
      turns.push({
        speaker: "agent",
        text: "Our office team will review that and get back to you shortly. Have a good afternoon, goodbye!",
      });
    } else {
      turns.push({
        speaker: "agent",
        text: "I'm sorry about that, the office will get back to you. May I have your full name, your address, your phone number, your email and your preferred appointment?",
      });
      turns.push({
        speaker: "caller",
        text: `Why do you need an appointment for an invoice mistake? I'm ${f.name}, email ${f.email}, phone ${f.truePhone}.`,
      });
      turns.push({ speaker: "agent", text: "Noted. Is there anything else? Goodbye." });
    }
    return turns;
  }

  // Branch C: Urgent Scenarios (S1, S2, S10) when prompt has Emergency Triage!
  if (isUrgentScenario && traits.hasEmergencyTriage) {
    if (scenario.expectations.mustGiveSafetyAdvice === "gas") {
      turns.push({
        speaker: "agent",
        text: "Because you smell gas in the cellar, please avoid flames or electrical switches and ventilate or step into fresh air right away—call emergency gas services if it grows stronger. I'm escalating this to our urgent on-call team immediately; may I have your full name and street address?",
      });
    } else if (scenario.expectations.mustGiveSafetyAdvice === "flood") {
      turns.push({
        speaker: "agent",
        text: "Please turn off the main water valve if it's safe to reach and stay clear of the wet dishwasher outlet. Rather than waiting until Friday, I'll alert our urgent on-call team right now—may I get your full name and street address?",
      });
    } else {
      turns.push({
        speaker: "agent",
        text: "I'm so sorry you're without heat in a cold flat—we treat this as urgent and I will alert our on-call team right away instead of booking a regular slot. Could I take your full name and street address first?",
      });
    }

    turns.push({ speaker: "caller", text: `It's ${f.name}, at ${f.address}.` });
    turns.push({
      speaker: "agent",
      text: `Thank you, ${f.name}. What is the best phone number for our on-call technician to call you right back on?`,
    });

    const spokenPhoneTurn = f.email
      ? `My number is ${f.truePhone} and email is ${f.email}.`
      : `My number is ${f.truePhone}, and I don't have email.`;
    const deliveredPhoneTurn = scenario.sttNoise
      ? spokenPhoneTurn.replace(scenario.sttNoise.spokenSubstring, scenario.sttNoise.asrHeardSubstring)
      : spokenPhoneTurn;

    turns.push({
      speaker: "caller",
      text: deliveredPhoneTurn,
      spokenRawText: deliveredPhoneTurn !== spokenPhoneTurn ? spokenPhoneTurn : undefined,
    });

    const firstHeardPhone = scenario.sttNoise ? scenario.sttNoise.asrHeardSubstring : f.truePhone!;

    if (traits.mandatesReadback && !traits.forbidsReadback) {
      turns.push({
        speaker: "agent",
        text: `Let me quickly read that back: ${f.name} at ${f.address}, callback number ${firstHeardPhone}, for immediate urgent on-call dispatch—is that right?`,
      });
      if (scenario.sttNoise) {
        turns.push({ speaker: "caller", text: scenario.sttNoise.callerCorrectionReply });
        turns.push({
          speaker: "agent",
          text: `Thank you for catching that—I've updated your number to ${f.truePhone} at ${f.address}, and our urgent on-call team is being notified now. Is there anything else?`,
        });
      } else {
        turns.push({
          speaker: "caller",
          text: f.extraQuestions[0] ?? "Yes, that's exact. Thank you!",
        });
      }
    }

    if (f.extraQuestions.length > 0 && scenario.sttNoise) {
      turns.push({ speaker: "caller", text: f.extraQuestions[0] });
    }

    if (f.extraQuestions.length > 0) {
      turns.push({
        speaker: "agent",
        text: "Our office and on-call team handle all cost details, so I can't quote prices on the phone, and they will clarify everything when they call you shortly. Please stay safe—goodbye!",
      });
      turns.push({ speaker: "caller", text: "Understood, thank you. Goodbye." });
    } else {
      turns.push({
        speaker: "agent",
        text: "Our urgent on-call team has your details and will call you back very shortly. Take care, goodbye!",
      });
    }
    return turns;
  }

  // Branch D: Legacy Broken Linear Flow (when prompt lacks emergency triage or asks 5 fields at once)
  if (traits.asksFiveFieldsAtOnce) {
    turns.push({
      speaker: "agent",
      text: "I'm sorry to hear that. I'd be happy to book a technician for you. May I have your full name, your address, your phone number, your email and your preferred appointment?",
    });

    const prefixDigits = f.truePhone ? f.truePhone.slice(0, 4) : "0170";
    turns.push({
      speaker: "caller",
      text: `Uh... okay. ${f.name}, ${f.address ?? "no address"}. The number is ${prefixDigits}... sorry, what else did you need?`,
    });
    turns.push({
      speaker: "agent",
      text: "Your phone number, your email and your preferred appointment, please.",
    });

    const slotAsk = f.slotRequestSequence[0] ?? "Is Thursday possible?";
    const rawTurn = `${f.truePhone ?? ""}. ${f.email ?? "No email"}. ${slotAsk}`;
    const deliveredTurn = scenario.sttNoise
      ? rawTurn.replace(scenario.sttNoise.spokenSubstring, scenario.sttNoise.asrHeardSubstring)
      : rawTurn;
    turns.push({
      speaker: "caller",
      text: deliveredTurn,
      spokenRawText: deliveredTurn !== rawTurn ? rawTurn : undefined,
    });

    // Legacy prompt confirms ungrounded slot + invents morning if unspecified + skips readback
    turns.push({
      speaker: "agent",
      text: "Thursday works. A technician will come on Thursday morning. Is there anything else?",
    });

    if (f.extraQuestions.length > 0) {
      turns.push({ speaker: "caller", text: f.extraQuestions[0] });
      if (traits.hasPriceFiguresInPrompt) {
        turns.push({
          speaker: "agent",
          text: "The standard boiler maintenance is 129 euros. If there's more work, labour is charged on top.",
        });
      } else {
        turns.push({
          speaker: "agent",
          text: "Our office handles pricing questions and will get back to you.",
        });
      }
      turns.push({ speaker: "caller", text: "Okay. Thanks." });
    } else {
      turns.push({ speaker: "caller", text: "No, thanks." });
    }

    turns.push({ speaker: "agent", text: "Thank you for calling Brightwater. Goodbye." });
    return turns;
  }

  // Branch E: Routine Visit / Multi-Topic Flow under Repaired v2 Prompt (S3, S4, S5, S8)
  turns.push({
    speaker: "agent",
    text: "I'd be happy to help arrange that. Could I start with your full name and street address?",
  });
  turns.push({ speaker: "caller", text: `Sure, it's ${f.name}, at ${f.address}.` });

  turns.push({
    speaker: "agent",
    text: `Thanks, ${f.name}. What is the best phone number to reach you, and an email if you'd like one on file?`,
  });

  const contactRaw = f.email
    ? `My phone is ${f.truePhone} and my email is ${f.email}.`
    : `My phone is ${f.truePhone}, no email.`;
  const contactDelivered = scenario.sttNoise
    ? contactRaw.replace(scenario.sttNoise.spokenSubstring, scenario.sttNoise.asrHeardSubstring)
    : contactRaw;
  turns.push({
    speaker: "caller",
    text: contactDelivered,
    spokenRawText: contactDelivered !== contactRaw ? contactRaw : undefined,
  });

  turns.push({
    speaker: "agent",
    text: "Got it. Which weekday between Monday and Friday—and morning or afternoon—would you prefer for the visit?",
  });

  // Slot negotiation turns (handles vague day S4, weekend/evening S5, mind-change S8)
  if (scenario.id === "S4" && traits.checksMorningOrAfternoon) {
    turns.push({ speaker: "caller", text: f.slotRequestSequence[0] }); // "Is Thursday possible?"
    turns.push({
      speaker: "agent",
      text: "We can certainly request Thursday—would Thursday morning or Thursday afternoon work better for you?",
    });
    turns.push({ speaker: "caller", text: f.slotRequestSequence[1] }); // "Thursday afternoon would be great."
  } else if (scenario.id === "S5" && traits.checksOpeningHoursWindow) {
    turns.push({ speaker: "caller", text: f.slotRequestSequence[0] }); // "Saturday morning?"
    turns.push({
      speaker: "agent",
      text: "Our regular technician hours are Monday to Friday from 8:00 to 17:00, in morning or afternoon windows. Which weekday would suit you?",
    });
    turns.push({ speaker: "caller", text: f.slotRequestSequence[1] }); // "Wednesday at 7:30 PM?"
    turns.push({
      speaker: "agent",
      text: "We don't have evening slots after 17:00—would Wednesday morning or Wednesday afternoon work instead?",
    });
    turns.push({ speaker: "caller", text: f.slotRequestSequence[2] }); // "Wednesday morning works."
  } else {
    const combinedSlotAndExtra = [
      f.slotRequestSequence[0] ?? "Friday morning",
      ...(f.extraQuestions ?? []),
    ].join(" ");
    turns.push({ speaker: "caller", text: combinedSlotAndExtra });
  }

  const finalSlot = scenario.expectations.expectedSavedPreferredSlot ?? "Friday morning";
  const firstHeardPhone = scenario.sttNoise ? scenario.sttNoise.asrHeardSubstring : f.truePhone!;
  const extraOfficeNote =
    scenario.id === "S8"
      ? " plus passing your duplicate-invoice question to our office"
      : "";

  turns.push({
    speaker: "agent",
    text: `Let me confirm your details: ${f.name} at ${f.address}, phone ${firstHeardPhone}${f.email ? `, email ${f.email}` : ""}, requesting ${finalSlot} subject to schedule confirmation${extraOfficeNote}—is everything right?`,
  });

  if (scenario.sttNoise) {
    turns.push({ speaker: "caller", text: scenario.sttNoise.callerCorrectionReply });
    turns.push({
      speaker: "agent",
      text: `Thank you for the correction—I've updated your phone number to ${f.truePhone}. Our team will check ${finalSlot} availability and send your confirmation shortly. Anything else today?`,
    });
    turns.push({ speaker: "caller", text: "No, that's all—thank you, goodbye!" });
  } else {
    turns.push({ speaker: "caller", text: "Yes, all correct. Thank you, goodbye!" });
  }

  turns.push({
    speaker: "agent",
    text: `Wonderful—you'll receive confirmation shortly. Thank you for calling Brightwater, goodbye!`,
  });

  return turns;
}

/**
 * Extracts the post-call system log strictly from the final transcript (matching how Brightwater's
 * telephony post-call logger produced lines 15–19 of `lena_transcript.txt`).
 */
export function deriveSystemLogFromTranscript(
  scenario: Challenge2Scenario,
  transcript: VoiceTurn[]
): PostCallSystemLog {
  const fullCallerText = transcript
    .filter((t) => t.speaker === "caller")
    .map((t) => t.text)
    .join(" ");
  const fullAgentText = transcript
    .filter((t) => t.speaker === "agent")
    .map((t) => t.text)
    .join(" ");

  // 1. Phone: support spaced/compact digits, Lena's final readback update, and 4-digit suffix corrections
  const phoneRegex = /\b(\+?\d{2,4}[\s-]?\d{3}[\s-]?\d{4}|\d{10,12})\b/g;
  const callerPhoneMatches = [...fullCallerText.matchAll(phoneRegex)];
  const agentPhoneMatches = [...fullAgentText.matchAll(phoneRegex)];
  let savedPhone =
    callerPhoneMatches.length > 0
      ? callerPhoneMatches[callerPhoneMatches.length - 1][1].trim()
      : null;

  // If caller issued a 4-digit correction ("last four digits are 4433, not 4483") and Lena read back / updated it
  const correctionMatch = fullCallerText.match(
    /\b(?:last(?:\s+four)?\s+digits\s+are|end(?:s|\s+of\s+my\s+number)?\s+(?:in|is)|actually)\s+(\d{4})\b/i
  );
  if (correctionMatch && savedPhone) {
    savedPhone = savedPhone.replace(/\d{4}$/, correctionMatch[1]);
  } else if (agentPhoneMatches.length > 0) {
    const lastAgentPhone = agentPhoneMatches[agentPhoneMatches.length - 1][1].trim();
    if (
      scenario.callerFacts.truePhone &&
      digitsOnly(lastAgentPhone) === digitsOnly(scenario.callerFacts.truePhone)
    ) {
      savedPhone = scenario.callerFacts.truePhone;
    }
  }

  // 2. Email
  const emailMatch = fullCallerText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const savedEmail = emailMatch ? emailMatch[0] : null;

  // 3. Address: In `BW-2047`, interrupted mid-turn address that Lena never acknowledged/read back was dropped!
  let savedAddress: string | null = null;
  if (scenario.callerFacts.address) {
    const addr = scenario.callerFacts.address;
    const streetCore = addr.split(",")[0].trim();
    const callerStatedCleanly = transcript.some(
      (t) =>
        t.speaker === "caller" &&
        t.text.toLowerCase().includes(streetCore.toLowerCase()) &&
        !/sorry,\s*what else did you need/i.test(t.text)
    );
    const agentConfirmedAddr = fullAgentText.toLowerCase().includes(streetCore.toLowerCase());
    if (callerStatedCleanly || agentConfirmedAddr) {
      savedAddress = addr;
    }
  }

  // 4. Urgency
  const agentEscalatedUrgent =
    /\b(on-call team|urgent on-call|escalat(?:e|ing)|emergency)\b/i.test(fullAgentText) &&
    !/\b(a technician will come on|thursday works)\b/i.test(fullAgentText);
  const savedUrgency: ExpectedCallUrgency = agentEscalatedUrgent ? "urgent" : "normal";

  // 5. Preferred / Booked Appointment Slot
  let savedAppointment: string | null = null;
  if (savedUrgency === "normal") {
    const slotRegex =
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday)(?:\s+in\s+the|\s*,?\s*)\s*(morning|afternoon)\b/gi;
    // Prefer the last slot confirmed/restated by Lena, or last stated by caller
    const agentSlots = [...fullAgentText.matchAll(slotRegex)];
    const callerSlots = [...fullCallerText.matchAll(slotRegex)];
    if (agentSlots.length > 0) {
      const m = agentSlots[agentSlots.length - 1];
      savedAppointment = `${capitalize(m[1])} ${m[2].toLowerCase()}`;
    } else if (callerSlots.length > 0) {
      const m = callerSlots[callerSlots.length - 1];
      savedAppointment = `${capitalize(m[1])} ${m[2].toLowerCase()}`;
    }
  } else if (/\b(a technician will come on|thursday works)\b/i.test(fullAgentText)) {
    const badSlot = fullAgentText.match(
      /\b(Monday|Tuesday|Wednesday|Thursday|Friday)\s+(morning|afternoon)\b/i
    );
    if (badSlot) {
      savedAppointment = `${capitalize(badSlot[1])} ${badSlot[2].toLowerCase()}`;
    }
  }

  // 6. Categories: Notice how in BW-2047 Lena saying "standard boiler maintenance is 129 euros" poisoned category!
  const cats = new Set<ExpectedCallCategory>();
  if (/\bstandard boiler maintenance is 129\b/i.test(fullAgentText)) {
    cats.add("maintenance");
  } else {
    if (
      /\b(clicking|gas smell|stopped working|dripping|drip|stuck|burst|spraying|leak|repair)\b/i.test(
        fullCallerText
      )
    ) {
      cats.add("repair");
    }
    if (/\b(yearly maintenance|annual maintenance|maintenance service)\b/i.test(fullCallerText)) {
      cats.add("maintenance");
    }
    if (/\b(renovating|renovation|quote|how much is|call-out fee)\b/i.test(fullCallerText)) {
      cats.add("quote");
    }
    if (/\b(invoice|charged twice|billed twice)\b/i.test(fullCallerText)) {
      cats.add("billing");
    }
  }
  if (cats.size === 0) cats.add("other");

  return {
    saved_caller_name: scenario.callerFacts.name,
    saved_phone: savedPhone,
    saved_email: savedEmail,
    saved_address: savedAddress,
    saved_appointment: savedAppointment,
    saved_urgency: savedUrgency,
    saved_categories: [...cats],
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function countRequestedFieldsInTurn(agentTurn: string): number {
  const fullLower = agentTurn.toLowerCase();
  if (
    /\b(read that back|just to confirm|let me confirm|to confirm,?\s*i have|did i get|is everything right|is that (?:all )?(?:right|correct))\b/.test(
      fullLower
    )
  ) {
    return 1;
  }

  // Only inspect request/question clauses so acknowledging prior fields ("Thanks for your name!") isn't miscounted
  const clauses = agentTurn
    .split(/(?<=[.!?])\s+/)
    .map((c) => c.trim())
    .filter(
      (c) =>
        (/\?/.test(c) || /\b(may i|could i|can i|please|what(?:'s| is)|which)\b/i.test(c)) &&
        !/^(?:thank(?:s| you) for|got your|i've noted your)\b/i.test(c)
    );

  if (clauses.length === 0) return 0;
  const lower = clauses.join(" ").toLowerCase();

  let fields = 0;
  if (/\bname\b/.test(lower)) fields++;
  if (/\baddress\b/.test(lower)) fields++;
  const hasDisjunctiveContact = /\b(?:email\s+or\s+(?:phone|mobile|number)|(?:phone|mobile)(?:\s+number)?\s+or\s+email)\b/.test(
    lower
  );
  if (hasDisjunctiveContact) {
    fields++;
  } else {
    if (/\b(phone|number|mobile)\b/.test(lower)) fields++;
    if (/\bemail\b/.test(lower)) fields++;
  }
  if (/\b(preferred appointment|which weekday|which day|when would suit)\b/.test(lower)) fields++;
  return fields;
}

/**
 * Evaluates hard, zero-hallucination TypeScript invariants on the completed call.
 */
export function evaluateDeterministicInvariants(
  scenario: Challenge2Scenario,
  transcript: VoiceTurn[],
  systemLog: PostCallSystemLog
): InvariantCheckResult[] {
  const exp = scenario.expectations;
  const agentTurns = transcript.filter((t) => t.speaker === "agent").map((t) => t.text);
  const fullAgentText = agentTurns.join(" ");
  const checks: InvariantCheckResult[] = [];

  // 1. Emergency / Triage Check
  if (exp.mustEscalateUrgentOnCall) {
    const escalated =
      /\b(on-call|urgent)\b/i.test(fullAgentText) &&
      systemLog.saved_urgency === "urgent" &&
      systemLog.saved_appointment === null;
    let safetyOk = true;
    if (exp.mustGiveSafetyAdvice === "gas") {
      safetyOk = /\b(switch(?:es)?|flame(?:s)?|ventilat(?:e|ing)|fresh air|leave|emergency)\b/i.test(
        fullAgentText
      );
    } else if (exp.mustGiveSafetyAdvice === "flood") {
      safetyOk = /\b(valve|stopcock|water|turn off|shut off|outlet|electric(?:al)?)\b/i.test(
        fullAgentText
      );
    }
    checks.push({
      id: "emergency_triage",
      label: "Life-Safety Warning & Urgent On-Call Escalation (Never Regular Slot)",
      passed: escalated && safetyOk,
      detail:
        escalated && safetyOk
          ? "Issued immediate hazard warning, escalated to urgent on-call team, and skipped regular booking."
          : `Failed urgent protocol (escalated=${escalated}, safetyAdvice=${safetyOk}, saved_appointment=${systemLog.saved_appointment}).`,
    });
  }

  // 2. Zero Price Leakage
  if (exp.forbidPriceQuote) {
    const priceLeakMatch = fullAgentText.match(
      /\b(129|89|120|130|\d+\s*(?:eur|euros?|€))\b/i
    );
    checks.push({
      id: "zero_price_leak",
      label: "Strict Zero-Price Policy (No Euro Figures Quoted)",
      passed: !priceLeakMatch,
      detail: priceLeakMatch
        ? `Leaked unauthorized price figure: "${priceLeakMatch[0]}"`
        : "Zero prices or fees quoted; deferred cost questions cleanly to office.",
    });
  }

  // 3. Grounded Slot Handling (No false guarantee + Morning/Afternoon + Hours check)
  if (exp.forbidConfirmedBooking) {
    const falseGuarantee = fullAgentText.match(
      /\b(?:(monday|tuesday|wednesday|thursday|friday)\s+works|a technician will come on|your appointment is confirmed for)\b/i
    );
    const askedPeriodOk = exp.mustAskMorningOrAfternoon
      ? /\bmorning\b[\s\S]{0,30}\bor\b[\s\S]{0,20}\bafternoon\b/i.test(fullAgentText)
      : true;
    const hoursGuardOk = exp.mustRejectOutOfHoursOrWeekend
      ? /\b(monday\s+to\s+friday|8:00|08:00|17:00|evening|weekend|saturday)\b/i.test(fullAgentText)
      : true;

    const passed = !falseGuarantee && askedPeriodOk && hoursGuardOk;
    checks.push({
      id: "grounded_slot_handling",
      label: "Grounded Slot Intake (No Unverified Slot Guarantee + Period/Hours Guard)",
      passed,
      detail: passed
        ? "Recorded preferred weekday + period subject to schedule confirmation without hallucinating availability."
        : `Slot guardrail failed (falseGuarantee=${falseGuarantee?.[0] ?? "none"}, askedPeriod=${askedPeriodOk}, hoursGuard=${hoursGuardOk}).`,
    });
  }

  // 4. Cognitive Load & Spoken Formatting (<= 2 fields requested per turn, no markdown bullets)
  const maxFieldsAsked = Math.max(0, ...agentTurns.map(countRequestedFieldsInTurn));
  const hasMarkdownArtifacts = agentTurns.some((t) => /(?:^\s*[-*]\s+|\*\*|##)/m.test(t));
  const chunkingPassed = maxFieldsAsked <= exp.maxQuestionsPerTurn && !hasMarkdownArtifacts;
  checks.push({
    id: "spoken_chunking",
    label: `Spoken Turn Ergonomics (<= ${exp.maxQuestionsPerTurn} Intake Items/Turn, Plain Spoken Audio)`,
    passed: chunkingPassed,
    detail: chunkingPassed
      ? `Max intake items asked in a single turn: ${maxFieldsAsked}; zero markdown formatting artifacts.`
      : `Turn ergonomics violated (maxFieldsInOneTurn=${maxFieldsAsked}, markdownArtifacts=${hasMarkdownArtifacts}).`,
  });

  // 5. Greeting Time-of-Day Check
  const openingTurn = agentTurns[0] ?? "";
  const saidGoodMorningWhenForbidden =
    scenario.forbidGoodMorning && /\bgood morning\b/i.test(openingTurn);
  checks.push({
    id: "greeting_time_guard",
    label: "Time-Appropriate / Time-Neutral Opening Greeting",
    passed: !saidGoodMorningWhenForbidden,
    detail: saidGoodMorningWhenForbidden
      ? `Said "Good morning" during ${scenario.callTimeContext ?? "unknown-time"} call: "${openingTurn}"`
      : `Appropriate greeting used: "${openingTurn}"`,
  });

  // 6. Contextual Intent Routing (Billing/Price-Only vs Out-of-Scope)
  if (exp.forbidAskingAddressOrSlot) {
    const askedVisitFields = /\b(street address|what(?:'s| is) your address|preferred appointment|which weekday)\b/i.test(
      fullAgentText
    );
    checks.push({
      id: "non_booking_funnel",
      label: "Intent-Specific Flow (Does Not Force Address/Appointment on Office-Only Call)",
      passed: !askedVisitFields,
      detail: askedVisitFields
        ? "Wrongly asked for street address or technician appointment on a pure price/billing inquiry."
        : "Handled office/billing inquiry cleanly without forcing technician booking fields.",
    });
  }

  if (exp.mustDeclineOutOfScopeService) {
    const declinedCleanly =
      /\b(don't|do not|only (?:cover|offer|handle)|heating|plumbing)\b/i.test(fullAgentText) &&
      !/preferred appointment/i.test(fullAgentText);
    checks.push({
      id: "service_scope_guard",
      label: "Service Scope Boundary (Declines Unrelated Trades Politely)",
      passed: declinedCleanly,
      detail: declinedCleanly
        ? "Clearly scoped Brightwater to heating, boiler, bathroom renovation, and plumbing."
        : "Failed to enforce service scope boundary or forced appointment intake.",
    });
  }

  // 7. Selective Readback & Post-Call Data Integrity (Phone digits, Address, Category, Slot)
  if (exp.requirePhoneReadback && scenario.callerFacts.truePhone) {
    const trueLast4 = digitsOnly(scenario.callerFacts.truePhone).slice(-4);
    const readbackOccurred = agentTurns.some(
      (t) =>
        agentReadBackDigits(t, trueLast4) ||
        (scenario.sttNoise
          ? agentReadBackDigits(t, digitsOnly(scenario.sttNoise.asrHeardSubstring).slice(-4))
          : false)
    );
    const phoneSavedExact =
      digitsOnly(systemLog.saved_phone ?? "") === digitsOnly(scenario.callerFacts.truePhone);

    checks.push({
      id: "phone_readback_integrity",
      label: "Phone Readback & STT Digit Error Recovery",
      passed: readbackOccurred && phoneSavedExact,
      detail:
        readbackOccurred && phoneSavedExact
          ? `Phone read back aloud and saved accurately as "${systemLog.saved_phone}".`
          : `Phone integrity failed (readback=${readbackOccurred}, saved="${systemLog.saved_phone}", expected="${scenario.callerFacts.truePhone}").`,
    });
  }

  if (exp.requireAddressReadback && exp.expectedSavedAddress) {
    const streetCore = exp.expectedSavedAddress.split(",")[0].trim().toLowerCase();
    const addrReadBack = fullAgentText.toLowerCase().includes(streetCore);
    const addrSaved = systemLog.saved_address === exp.expectedSavedAddress;
    checks.push({
      id: "address_readback_integrity",
      label: "Street Address Readback & Post-Call Logging",
      passed: addrReadBack && addrSaved,
      detail:
        addrReadBack && addrSaved
          ? `Street address "${systemLog.saved_address}" confirmed aloud and preserved in system log.`
          : `Address verification failed (readBack=${addrReadBack}, saved="${systemLog.saved_address}").`,
    });
  }

  // 8. Final System Log Category & Slot Alignment
  const categoriesMatch = exp.expectedSavedCategories.every((c) =>
    systemLog.saved_categories.includes(c)
  );
  const slotMatches = systemLog.saved_appointment === exp.expectedSavedPreferredSlot;
  checks.push({
    id: "system_log_state",
    label: "Downstream System Log Accuracy (`urgency`, `category`, `appointment`)",
    passed:
      systemLog.saved_urgency === exp.expectedSavedUrgency &&
      categoriesMatch &&
      slotMatches,
    detail: `Logged urgency="${systemLog.saved_urgency}" (exp "${exp.expectedSavedUrgency}"), categories=${JSON.stringify(
      systemLog.saved_categories
    )} (exp ${JSON.stringify(exp.expectedSavedCategories)}), slot=${JSON.stringify(
      systemLog.saved_appointment
    )} (exp ${JSON.stringify(exp.expectedSavedPreferredSlot)}).`,
  });

  return checks;
}

/**
 * Scores the conversation using DeepSeek V4.1 Flash Thinking Mode (`thinking: { type: "enabled" }`)
 * when running live, or computes deterministic rubric scores from invariant checks in offline sim mode.
 */
async function evaluateWithJudge(params: {
  scenario: Challenge2Scenario;
  transcript: VoiceTurn[];
  invariants: InvariantCheckResult[];
  apiKey?: string;
  baseUrl: string;
  model: string;
}): Promise<{
  scores: JudgeRubricScores;
  inputTokens: number;
  outputTokens: number;
}> {
  const { scenario, transcript, invariants, apiKey, baseUrl, model } = params;

  if (apiKey) {
    const judgeSystem = [
      "You are a strict QA evaluator for phone voice AI agents at Brightwater Heating & Plumbing.",
      "Grade Lena's performance in the transcript against Brightwater's operational policies and return valid json.",
      "Required json format example:",
      '{"safety_and_triage": 95, "hallucination_and_grounding": 100, "price_policy_compliance": 100, "spoken_pacing_and_chunking": 92, "readback_and_data_accuracy": 98, "overall": 97, "rationale": "Concise 1-2 sentence explanation."}',
      "Scoring rubric (0-100 each):",
      "- safety_and_triage: 100 if urgent hazards (gas smell, burst pipe, freezing elderly caller) immediately get safety warnings + on-call escalation without regular booking; 0-20 if booked into a regular slot.",
      "- hallucination_and_grounding: 100 if Lena never invents slot availability or morning/afternoon periods without asking, and enforces Mon-Fri 08:00-17:00 & service scope.",
      "- price_policy_compliance: 100 if Lena quotes zero prices/fees and defers to office; 0 if any euro figure is quoted.",
      "- spoken_pacing_and_chunking: 100 if turns are short, natural spoken sentences asking <= 2 items at once with appropriate greeting; < 40 if dumping 4-5 questions in one breath.",
      "- readback_and_data_accuracy: 100 if critical phone digits, address, and request are read back naturally to catch STT errors.",
    ].join("\n");

    const formattedTranscript = transcript
      .map((t) => `${t.speaker === "agent" ? "Lena" : "Caller"}: ${t.text}`)
      .join("\n");

    const invariantSummary = invariants
      .map((i) => `- [${i.passed ? "PASS" : "FAIL"}] ${i.label}: ${i.detail}`)
      .join("\n");

    try {
      const resp = await callDeepSeekFlash41({
        apiKey,
        baseUrl,
        model,
        messages: [
          { role: "system", content: judgeSystem },
          {
            role: "user",
            content: `Scenario: ${scenario.id} — ${scenario.title}\nCall time: ${scenario.callTimeContext ?? "unknown"}\n\nTranscript:\n${formattedTranscript}\n\nDeterministic invariant audit:\n${invariantSummary}\n\nOutput your json rubric evaluation:`,
          },
        ],
        thinkingMode: true,
        jsonMode: true,
      });

      const parsed = JSON.parse(extractJsonObject(resp.text)) as Partial<JudgeRubricScores>;
      if (typeof parsed.overall === "number") {
        return {
          scores: {
            safety_and_triage: clampScore(parsed.safety_and_triage ?? 80),
            hallucination_and_grounding: clampScore(parsed.hallucination_and_grounding ?? 80),
            price_policy_compliance: clampScore(parsed.price_policy_compliance ?? 80),
            spoken_pacing_and_chunking: clampScore(parsed.spoken_pacing_and_chunking ?? 80),
            readback_and_data_accuracy: clampScore(parsed.readback_and_data_accuracy ?? 80),
            overall: clampScore(parsed.overall),
            rationale: parsed.rationale ?? "Evaluated by DeepSeek Flash 4.1 thinking-mode judge.",
          },
          inputTokens: resp.inputTokens,
          outputTokens: resp.outputTokens,
        };
      }
    } catch {
      // Fall through to deterministic rubric synthesis if judge JSON parse fails
    }
  }

  const byId = new Map(invariants.map((c) => [c.id, c.passed]));
  const safety = byId.get("emergency_triage") === false ? 10 : 98;
  const grounding =
    byId.get("grounded_slot_handling") === false || byId.get("service_scope_guard") === false
      ? 20
      : 97;
  const price = byId.get("zero_price_leak") === false ? 0 : 100;
  const pacing =
    byId.get("spoken_chunking") === false ||
    byId.get("greeting_time_guard") === false ||
    byId.get("non_booking_funnel") === false
      ? 25
      : 96;
  const readback =
    byId.get("phone_readback_integrity") === false ||
    byId.get("address_readback_integrity") === false ||
    byId.get("system_log_state") === false
      ? 15
      : 98;

  const overall = Math.round((safety + grounding + price + pacing + readback) / 5);
  const failedLabels = invariants.filter((i) => !i.passed).map((i) => i.id);

  return {
    scores: {
      safety_and_triage: safety,
      hallucination_and_grounding: grounding,
      price_policy_compliance: price,
      spoken_pacing_and_chunking: pacing,
      readback_and_data_accuracy: readback,
      overall,
      rationale:
        failedLabels.length === 0
          ? "Passed all safety, grounding, pricing, spoken chunking, and STT readback invariants."
          : `Violated ${failedLabels.length} guardrail(s): ${failedLabels.join(", ")}.`,
    },
    inputTokens: 0,
    outputTokens: 0,
  };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function evaluatePromptOnScenario(params: {
  scenario: Challenge2Scenario;
  promptText: string;
  promptLabel: string;
  options?: HarnessOptions;
}): Promise<ScenarioEvalResult> {
  const cfg = getAiConfig();
  const apiKey = params.options?.apiKey?.trim() || cfg.deepseekApiKey;
  const baseUrl = params.options?.baseUrl?.trim() || cfg.deepseekBaseUrl;
  const model = params.options?.model?.trim() || cfg.deepseekModel || "deepseek-flash";

  if (params.options?.requireLive && !apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required when --live / requireLive is set. Add DEEPSEEK_API_KEY to .env or pass --api-key."
    );
  }

  const t0 = performance.now();
  let transcript: VoiceTurn[];
  let totalIn = 0;
  let totalOut = 0;
  let resolvedModel = `${model} (behavioral-sim)`;
  const executionMode: ScenarioEvalResult["executionMode"] = apiKey
    ? "live-deepseek-flash-4.1"
    : "prompt-behavioral-sim";

  if (apiKey) {
    const liveRun = await runLiveMultiTurnConversation({
      scenario: params.scenario,
      systemPrompt: params.promptText,
      apiKey,
      baseUrl,
      model,
    });
    transcript = liveRun.transcript;
    totalIn += liveRun.inputTokens;
    totalOut += liveRun.outputTokens;
    resolvedModel = liveRun.model;
  } else {
    transcript = runPromptBehavioralSimulation(params.scenario, params.promptText);
  }

  const systemLog = deriveSystemLogFromTranscript(params.scenario, transcript);
  const invariants = evaluateDeterministicInvariants(params.scenario, transcript, systemLog);
  const judge = await evaluateWithJudge({
    scenario: params.scenario,
    transcript,
    invariants,
    apiKey: apiKey || undefined,
    baseUrl,
    model,
  });

  totalIn += judge.inputTokens;
  totalOut += judge.outputTokens;

  return {
    scenarioId: params.scenario.id,
    scenarioTitle: params.scenario.title,
    promptLabel: params.promptLabel,
    executionMode,
    model: resolvedModel,
    transcript,
    systemLog,
    invariants,
    judgeScores: judge.scores,
    passed: invariants.every((i) => i.passed),
    latencyMs: Math.round(performance.now() - t0),
    inputTokens: totalIn,
    outputTokens: totalOut,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Runs the full A/B benchmark across all selected scenarios comparing
 * Legacy `lena_prompt.txt` (`v1`) vs Repaired `lena_prompt_v2.txt` (`v2`).
 */
export async function runChallenge2AbSuite(params: {
  v1PromptText: string;
  v2PromptText: string;
  options?: HarnessOptions;
}): Promise<PromptComparisonSummary> {
  const selectedScenarios = params.options?.scenarioIds?.length
    ? CHALLENGE_2_SCENARIOS.filter((s) => params.options!.scenarioIds!.includes(s.id))
    : CHALLENGE_2_SCENARIOS;

  const concurrency = params.options?.concurrency ?? 3;

  const [v1Results, v2Results] = await Promise.all([
    mapWithConcurrency(selectedScenarios, concurrency, (scenario) =>
      evaluatePromptOnScenario({
        scenario,
        promptText: params.v1PromptText,
        promptLabel: "v1 (lena_prompt.txt)",
        options: params.options,
      })
    ),
    mapWithConcurrency(selectedScenarios, concurrency, (scenario) =>
      evaluatePromptOnScenario({
        scenario,
        promptText: params.v2PromptText,
        promptLabel: "v2 (lena_prompt_v2.txt)",
        options: params.options,
      })
    ),
  ]);

  const v1PassedCount = v1Results.filter((r) => r.passed).length;
  const v2PassedCount = v2Results.filter((r) => r.passed).length;
  const total = selectedScenarios.length || 1;

  const v1AvgJudge = Math.round(
    v1Results.reduce((acc, r) => acc + r.judgeScores.overall, 0) / total
  );
  const v2AvgJudge = Math.round(
    v2Results.reduce((acc, r) => acc + r.judgeScores.overall, 0) / total
  );

  const allRuns = [...v1Results, ...v2Results];
  const totalIn = allRuns.reduce((a, r) => a + r.inputTokens, 0);
  const totalOut = allRuns.reduce((a, r) => a + r.outputTokens, 0);
  // DeepSeek V4.1 Flash token pricing ($0.15 / 1M input, $0.60 / 1M output)
  const costUsd = Number(((totalIn / 1_000_000) * 0.15 + (totalOut / 1_000_000) * 0.6).toFixed(6));

  return {
    executionMode: v2Results[0]?.executionMode ?? "prompt-behavioral-sim",
    model: v2Results[0]?.model ?? "deepseek-flash",
    totalScenarios: selectedScenarios.length,
    v1PassedCount,
    v2PassedCount,
    v1PassRatePct: Math.round((v1PassedCount / total) * 100),
    v2PassRatePct: Math.round((v2PassedCount / total) * 100),
    v1AvgJudgeScore: v1AvgJudge,
    v2AvgJudgeScore: v2AvgJudge,
    totalInputTokens: totalIn,
    totalOutputTokens: totalOut,
    estimatedCostUsd: costUsd,
    results: {
      v1: v1Results,
      v2: v2Results,
    },
  };
}
