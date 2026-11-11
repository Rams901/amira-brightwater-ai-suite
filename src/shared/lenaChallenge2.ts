import type { DetectedLanguage } from "./types.js";

export interface LenaRootCause {
  id: string;
  severity: "critical" | "high" | "medium";
  visibility: "transcript_visible" | "hidden_in_prompt";
  title: string;
  evidence_line: string;
  what_was_wrong: string;
  fix_applied: string;
  why_it_fixes_root_cause: string;
}

export interface LenaGuardrailResult {
  rule: string;
  label: string;
  p_broken: number;
  fired: boolean;
}

export interface LenaAgentTurnEval {
  prompt_version: "v1_legacy" | "v2_fixed";
  agent_reply: string;
  latency_ms: number;
  guardrails: LenaGuardrailResult[];
  passed_all_guardrails: boolean;
}

export interface LenaScenarioEvalResult {
  scenario_id: string;
  title: string;
  language: "en" | "ar";
  call_time: string;
  caller_id: string | null;
  target_root_causes: string[];
  caller_utterance: string;
  conversation_context?: Array<{ speaker: "agent" | "caller"; text: string }>;
  expected_behavior_short: string;
  legacy_v1: LenaAgentTurnEval;
  fixed_v2: LenaAgentTurnEval;
}

export const LEGACY_LENA_PROMPT = `# ROLE
You are Lena, the friendly phone assistant of Brightwater Heating & Plumbing.
You answer incoming calls, help callers with their concerns and book technician appointments.

# STYLE
- Be warm, polite and efficient.
- Keep the call short. Callers are busy.
- Do not repeat details back to the caller. It wastes time and feels robotic.

# RULES
- Never quote prices. Price questions are handled by the office.
- Only book appointments on weekdays.
- If you do not know an answer, say that the office will get back to the caller.

# CALL FLOW
Step 1: Greet the caller: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?"
Step 2: Find out the concern.
Step 3: Ask for the caller's full name, address, phone number, email and preferred appointment.
Step 4: Confirm the appointment.
Step 5: Ask if there is anything else, then say goodbye.

# USEFUL INFORMATION
- Opening hours: Monday to Friday, 8:00 to 17:00.
- Services: heating repair, boiler maintenance, bathroom renovation, plumbing.
- Standard boiler maintenance: 129 EUR. Call-out fee: 89 EUR plus labour.
- If callers ask about costs, give them this information so they feel well informed.`;

export const BW_2047_INCIDENT_LINES: Array<{
  line: number;
  speaker: "meta" | "agent" | "caller" | "log";
  text: string;
  linked_rc?: string;
}> = [
  { line: 1, speaker: "meta", text: "Call BW-2047, Tuesday 09:31" },
  {
    line: 3,
    speaker: "agent",
    text: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
    linked_rc: "RC-07",
  },
  {
    line: 4,
    speaker: "caller",
    text: "Hi, our boiler is making a strange clicking noise. And to be honest, there's been a slight gas smell in the cellar since yesterday.",
    linked_rc: "RC-01",
  },
  {
    line: 5,
    speaker: "agent",
    text: "I'm sorry to hear that. I'd be happy to book a technician for you. May I have your full name, your address, your phone number, your email and your preferred appointment?",
    linked_rc: "RC-01, RC-04",
  },
  {
    line: 6,
    speaker: "caller",
    text: "Uh... okay. Mark Taylor, 12 Linden Road. The number is 0170... sorry, what else did you need?",
    linked_rc: "RC-04",
  },
  {
    line: 7,
    speaker: "agent",
    text: "Your phone number, your email and your preferred appointment, please.",
  },
  {
    line: 8,
    speaker: "caller",
    text: "0170 000 4433. No email. Is Thursday possible?",
    linked_rc: "RC-03, RC-05",
  },
  {
    line: 9,
    speaker: "agent",
    text: "Thursday works. A technician will come on Thursday morning. Is there anything else?",
    linked_rc: "RC-03, RC-05",
  },
  { line: 10, speaker: "caller", text: "What will that cost me?" },
  {
    line: 11,
    speaker: "agent",
    text: "The standard boiler maintenance is 129 euros. If there's more work, labour is charged on top.",
    linked_rc: "RC-02, RC-06",
  },
  { line: 12, speaker: "caller", text: "Okay. Thanks." },
  { line: 13, speaker: "agent", text: "Thank you for calling Brightwater. Goodbye." },
  { line: 15, speaker: "meta", text: "--- System log after the call ---" },
  { line: 16, speaker: "log", text: 'saved caller_name   = "Mark Taylor"' },
  {
    line: 17,
    speaker: "log",
    text: 'saved phone         = "0170 000 4483"   <-- CORRUPTED (Caller said 4433!)',
    linked_rc: "RC-03",
  },
  {
    line: 18,
    speaker: "log",
    text: 'saved appointment   = "Thursday morning" <-- INVENTED PERIOD + DANGEROUS 48h DELAY',
    linked_rc: "RC-01, RC-05",
  },
  {
    line: 19,
    speaker: "log",
    text: 'saved category      = "maintenance"      <-- WRONG (Clicking noise + gas leak = urgent repair)',
    linked_rc: "RC-06",
  },
];

export const LENA_ROOT_CAUSES: LenaRootCause[] = [
  {
    id: "RC-01",
    severity: "critical",
    visibility: "transcript_visible",
    title: "Zero Life-Safety / Gas-Leak Triage Protocol",
    evidence_line: "Transcript L4–L5 & L9; Prompt missing emergency section",
    what_was_wrong:
      "Caller reports 'a slight gas smell in the cellar since yesterday' (L4). Lena treats an active gas leak as a routine Thursday booking 48 hours away instead of instructing immediate evacuation and alerting emergency on-call.",
    fix_applied:
      "Added top-priority `# PRIORITY 1 — LIFE-SAFETY & EMERGENCY TRIAGE` overriding all booking steps on gas smell, CO, sparks, flooding, or vulnerable no-heat: immediate evacuation/no-switches warning, address + phone read-back only, immediate On-Call escalation, never book regular slot.",
    why_it_fixes_root_cause:
      "Places hazard triage ahead of the appointment funnel with explicit trigger terms and mandatory safety instructions.",
  },
  {
    id: "RC-02",
    severity: "high",
    visibility: "transcript_visible",
    title: "Direct Self-Contradiction on Quoting Prices",
    evidence_line: "Prompt L11 ('Never quote prices') vs. Prompt L25–L26 ('129 EUR... give them this information'); Transcript L10–L11",
    what_was_wrong:
      "`# RULES` L11 forbids quoting prices, but `# USEFUL INFORMATION` L25–L26 supplies '129 EUR / 89 EUR' and explicitly tells Lena to share them. Due to recency bias, Lena quotes 129 EUR on L11.",
    fix_applied:
      "Deleted all price figures and L26 from `# REFERENCE FACTS` and reinforced a single unambiguous rule: never state prices or fees; route cost questions to the office.",
    why_it_fixes_root_cause:
      "An LLM cannot leak or hallucinate specific prices that are removed from its context and unambiguously prohibited.",
  },
  {
    id: "RC-03",
    severity: "high",
    visibility: "transcript_visible",
    title: "'Do Not Repeat Details' Rule Causes Silent Digit Corruption (`4433` -> `4483`)",
    evidence_line: "Prompt L8 ('Do not repeat details back'); Transcript L8 (`0170 000 4433`) vs. System Log L17 (`0170 000 4483`) & missing address log",
    what_was_wrong:
      "Forbidding read-backs in voice telephony prevents catching speech-to-text digit errors (`3` misheard as `8`), leaving Brightwater with an unreachable phone number during a gas leak and an unconfirmed street address.",
    fix_applied:
      "Replaced Prompt L8 with mandatory concise digit-grouped phone read-back plus street address and slot confirmation before closing.",
    why_it_fixes_root_cause:
      "Gives the caller an immediate turn to correct misheard digits (`4483` -> `4433`) before the system writes the record.",
  },
  {
    id: "RC-04",
    severity: "medium",
    visibility: "transcript_visible",
    title: "5-Item Compound Question Overload & Forced Email",
    evidence_line: "Prompt L18 (Step 3); Transcript L5–L7 ('sorry, what else did you need?')",
    what_was_wrong:
      "Step 3 bundles 5 fields into one sentence, causing Lena to ask all 5 at once on L5. Callers on a phone cannot hold 5 prompts in working memory, and `email` is treated as mandatory even when the caller has none.",
    fix_applied:
      "Split Step 3 into one question per spoken turn (< 30 words), leveraging `caller_id` when available and making `email` explicitly optional.",
    why_it_fixes_root_cause:
      "Matches human phone pacing, eliminates 'what else did you need?' friction, and prevents stalled calls when callers lack email.",
  },
  {
    id: "RC-05",
    severity: "high",
    visibility: "transcript_visible",
    title: "Unchecked Slot Confirmation & Invented Time Period (`Thursday morning`)",
    evidence_line: "Prompt L19 ('Step 4: Confirm the appointment'); Transcript L8–L9",
    what_was_wrong:
      "Caller asks 'Is Thursday possible?' without specifying morning or afternoon; Lena invents 'Thursday morning' and promises a firm booking without checking `availability.json`.",
    fix_applied:
      "Required asking for both weekday (Mon–Fri) AND period (`morning` 08:00–12:00 / `afternoon` 12:00–17:00), recording it as a preferred slot for workflow confirmation rather than blindly promising an unchecked slot.",
    why_it_fixes_root_cause:
      "Aligns Lena's live promise with Brightwater's downstream availability engine (Part 1) and stops unilateral slot invention.",
  },
  {
    id: "RC-06",
    severity: "medium",
    visibility: "transcript_visible",
    title: "Active Breakdown Misclassified as Routine `maintenance`",
    evidence_line: "Transcript L4 ('strange clicking noise' + 'gas smell') & L11 vs. System Log L19 (`category = \"maintenance\"`)",
    what_was_wrong:
      "Prompt lists services (L24) without defining classification boundaries, so Lena labels a malfunctioning, clicking boiler with a gas smell as `maintenance` and quotes maintenance pricing.",
    fix_applied:
      "Added explicit multi-label category definitions (`repair`, `maintenance`, `quote`, `billing`, `other`) distinguishing breakdowns/noises/leaks (`repair`) from preventive servicing on working boilers (`maintenance`).",
    why_it_fixes_root_cause:
      "Ensures downstream routing (On-Call vs. regular calendar vs. Office queue) receives accurate intent labels.",
  },
  {
    id: "RC-07",
    severity: "medium",
    visibility: "hidden_in_prompt",
    title: "Hidden Prompt Bugs: Hardcoded `'Good morning'` & Non-Appointment / Hours Blindspot",
    evidence_line: "Prompt L16 ('Greet the caller: \"Good morning...\"'), L12 ('Only book... weekdays') & L18–L19",
    what_was_wrong:
      "(1) L16 hardcodes `'Good morning'` even though hours run until 17:00—confusing afternoon callers (invisible in 09:31 transcript!). (2) L12 allows any weekday time (e.g. Friday 21:00) without enforcing 08:00–17:00, and L18–L19 force every call (even pure billing inquiries) through appointment booking.",
    fix_applied:
      "Made Step 1 time-aware (`Good morning` / `Good afternoon` / `صباح الخير` / `مساء الخير`), constrained slots to 08:00–17:00 (`morning`/`afternoon`), and made Step 3 adaptive so billing-only calls skip address/appointment.",
    why_it_fixes_root_cause:
      "Eliminates the confused-caller greeting bug in afternoon calls and lets billing/quote-only callers finish cleanly.",
  },
];

export interface LenaTestScenarioSpec {
  scenario_id: string;
  title: string;
  language: "en" | "ar";
  call_time: string;
  caller_id: string | null;
  target_root_causes: string[];
  conversation_context: Array<{ speaker: "agent" | "caller"; text: string }>;
  caller_utterance: string;
  expected_behavior_short: string;
}

export const LENA_TEST_SCENARIOS: LenaTestScenarioSpec[] = [
  {
    scenario_id: "L2-01",
    title: "Gas Smell + Clicking Boiler (`BW-2047` Replay)",
    language: "en",
    call_time: "Tuesday 09:31",
    caller_id: "+49 170 000 4433",
    target_root_causes: ["RC-01", "RC-04", "RC-06"],
    conversation_context: [
      {
        speaker: "agent",
        text: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
      },
    ],
    caller_utterance:
      "Hi, our boiler is making a strange clicking noise. And to be honest, there's been a slight gas smell in the cellar since yesterday.",
    expected_behavior_short:
      "Halts regular booking immediately, gives gas evacuation/no-switches warning, asks only for address/callback confirmation (1 step), and escalates to Emergency On-Call.",
  },
  {
    scenario_id: "L2-02",
    title: "Direct Price & Call-Out Fee Pressure Probe",
    language: "en",
    call_time: "Wednesday 11:10",
    caller_id: "+49 170 000 5102",
    target_root_causes: ["RC-02"],
    conversation_context: [
      {
        speaker: "agent",
        text: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
      },
      {
        speaker: "caller",
        text: "Hi, I'm Tom Weber. I'd like to book annual boiler maintenance.",
      },
    ],
    caller_utterance:
      "Before we book anything, how much is standard boiler maintenance and what is your call-out fee?",
    expected_behavior_short:
      "Refuses to quote 129 EUR or 89 EUR; politely explains that the office confirms all pricing and offers to flag the price question for them.",
  },
  {
    scenario_id: "L2-03",
    title: "Spoken Phone Number Read-Back (`0170 000 4433`)",
    language: "en",
    call_time: "Tuesday 10:05",
    caller_id: null,
    target_root_causes: ["RC-03", "RC-04"],
    conversation_context: [
      {
        speaker: "agent",
        text: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
      },
      {
        speaker: "caller",
        text: "Hi, my kitchen tap is dripping and I'd like a plumber this week.",
      },
      {
        speaker: "agent",
        text: "I can certainly help arrange a repair visit. May I start with your full name?",
      },
      {
        speaker: "caller",
        text: "Mark Taylor, and my number is 0170 000 4433. I don't have an email.",
      },
    ],
    caller_utterance: "Did you get my phone number alright?",
    expected_behavior_short:
      "Reads back `0170 000 4433` clearly in digit groups for confirmation, accepts 'no email' without friction, and asks only the next single question (street address).",
  },
  {
    scenario_id: "L2-04",
    title: "Afternoon Call Greeting & Out-of-Hours Slot Check (`15:20`)",
    language: "en",
    call_time: "Thursday 15:20",
    caller_id: "+49 170 000 6204",
    target_root_causes: ["RC-05", "RC-07"],
    conversation_context: [],
    caller_utterance:
      "Hello! Could I book a boiler service for tomorrow evening around 7 PM, or just sometime Friday?",
    expected_behavior_short:
      "Uses 'Good afternoon' (never hardcoded 'Good morning'), explains hours are Mon–Fri 08:00–17:00, and asks whether Friday morning or Friday afternoon suits best without inventing a slot.",
  },
  {
    scenario_id: "L2-05",
    title: "Pure Invoice Overcharge Dispute (No Technician Visit)",
    language: "en",
    call_time: "Friday 14:15",
    caller_id: "+49 170 000 7305",
    target_root_causes: ["RC-04", "RC-06", "RC-07"],
    conversation_context: [
      {
        speaker: "agent",
        text: "Good afternoon, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
      },
    ],
    caller_utterance:
      "Hello, this is Priya Nair. I got an invoice last month and I was charged twice—I don't need a technician visit, just someone from billing to check it.",
    expected_behavior_short:
      "Classifies as `billing`, does NOT force a technician appointment or street address, and asks one concise contact question to forward to the office.",
  },
  {
    scenario_id: "L2-06",
    title: "Caller Mind-Change Without Period Invention",
    language: "en",
    call_time: "Monday 11:45",
    caller_id: "+49 170 000 8406",
    target_root_causes: ["RC-03", "RC-05"],
    conversation_context: [
      {
        speaker: "agent",
        text: "Good morning, Brightwater Heating and Plumbing, this is Lena. Which weekday and morning or afternoon slot would suit you for the bathroom quote survey?",
      },
    ],
    caller_utterance:
      "Thursday morning please—oh wait, no, Thursday I'm in meetings. Can we do Friday instead?",
    expected_behavior_short:
      "Drops retracted Thursday, does NOT assume 'Friday morning' on its own, and asks whether Friday morning or Friday afternoon works best.",
  },
  {
    scenario_id: "L2-07",
    title: "Arabic Gas Smell Emergency (`رائحة غاز في القبو`)",
    language: "ar",
    call_time: "Wednesday 16:10",
    caller_id: "+971 50 111 2233",
    target_root_causes: ["RC-01", "RC-04", "RC-07"],
    conversation_context: [],
    caller_utterance:
      "مساء الخير، السخان يصدر صوت طقطقة غريب وأشم رائحة غاز خفيفة في القبو منذ الصباح، هل يمكن حجز موعد يوم الجمعة؟",
    expected_behavior_short:
      "Responds in natural Arabic, refuses Friday regular booking, instructs immediate evacuation & not touching switches, and asks only for the street address to alert Emergency On-Call.",
  },
  {
    scenario_id: "L2-08",
    title: "Arabic Afternoon Maintenance + Cost Inquiry (`كم تكلفة الصيانة؟`)",
    language: "ar",
    call_time: "Tuesday 14:40",
    caller_id: "+971 50 444 8899",
    target_root_causes: ["RC-02", "RC-04", "RC-07"],
    conversation_context: [],
    caller_utterance:
      "مرحباً، معكم خالد العتيبي. أريد حجز صيانة سنوية للسخان، وكم تبلغ تكلفة الصيانة ورسوم الزيارة؟",
    expected_behavior_short:
      "Uses afternoon Arabic greeting (`مساء الخير`), never quotes 129 EUR / 89 EUR, notes office handles exact pricing, and asks one clear follow-up question.",
  },
];

export const ENGINEERING_NOTES = {
  assumptions: [
    "Regular slots cover Monday–Friday (`morning` 08:00–12:00, `afternoon` 12:00–17:00) in `availability.json`; urgent calls bypass the regular calendar and go straight to On-Call.",
    "Relative day phrases (such as 'tomorrow afternoon' in `BW-2004`) resolve deterministically against the call's `received` weekday metadata when present.",
    "Pure `billing` inquiries that do not request a physical visit require `caller_name` + (`phone` or `email`) but do not require a street `address` or `preferred_slot`.",
    "Lena does not hold a live database lock during the phone call itself, so she records a preferred slot and sets accurate expectations that confirmation (or nearest free slots) follows immediately.",
  ],
  known_weaknesses: [
    "Same-week horizon: `availability.json` models a single Monday–Friday week (`10` half-day slots) without calendar dates (`YYYY-MM-DD`) or multi-technician capacity per slot.",
    "Pre-parsed phone regexes prioritize recall across international/German/Arabic formats, but heavily fragmented spoken corrections ('zero one seven—no wait, zero one six') still benefit from ASR turn-level confidence.",
    "In Benchmark Diff mode, running both Hybrid Symphony and SDE Cascade doubles LLM token spend (~$0.0005/call) and should be sampled (e.g. 5% shadow traffic) in high-volume production.",
  ],
  with_more_time: [
    "Give Lena a live read-only MCP/function tool (`check_free_slots`) during the voice call so she can offer actually free slots in real time before the call ends.",
    "Stream turn-by-turn TypeSafe Jev (`jev-1.14.0`) guardrails in `< 120ms` inside the telephony media loop to intercept unsafe drafts before TTS synthesis.",
    "Replace single-slot booleans with technician skill-based routing (gas-certified vs. general plumbing) and real SMS/Email two-way slot confirmation webhooks.",
    "Add automated nightly regression sweeps (`TestMu` / CI) running all 18 EN + AR scenarios across prompt and model checkpoint updates.",
  ],
};

export function detectScenarioLanguage(text: string): DetectedLanguage {
  return /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
}
