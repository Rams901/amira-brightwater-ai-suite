import type {
  AvailabilitySchedule,
  IncomingCall,
  TestCaseAssertion,
  TestCaseResult,
} from "../../shared/types.js";
import { validateRestrictedJsonInput } from "../../shared/schemas.js";
import { LedgerStore, loadDefaultAvailabilityFromDisk } from "../db/ledgerStore.js";
import { processCallBatch } from "../workflow/orchestrator.js";
import { readProjectJson } from "../dataFiles.js";

function loadJsonFile<T>(filename: string): T {
  return readProjectJson<T>(filename);
}

/**
 * Strict Expected === Actual Assertion Helper.
 * `passed` is computed directly from `JSON.stringify(actual) === JSON.stringify(expected)`
 * so there can NEVER be a hidden boolean condition missing from the UI's Expected/Actual columns.
 */
function assertExactMatch(
  label: string,
  actual: unknown,
  expected: unknown
): TestCaseAssertion {
  const expectedStr = typeof expected === "string" ? expected : JSON.stringify(expected);
  const actualStr = typeof actual === "string" ? actual : JSON.stringify(actual);
  return {
    label,
    passed: actualStr === expectedStr,
    expected: expectedStr,
    actual: actualStr,
  };
}

export interface RunQaOptions {
  onlyTestId?: string;
  onTestResult?: (result: TestCaseResult, index: number, total: number) => void;
}

interface ScenarioDefinition {
  id: string;
  run: (baseAvailability: AvailabilitySchedule) => Promise<TestCaseResult>;
}

/**
 * Runs 10 isolated end-to-end automated QA scenarios (English, Arabic, Bilingual, Idempotency,
 * Gas/Flood Safety Overrides, Fault Isolation, and Restricted Upload Security).
 * Every test uses an isolated `:memory:` SQLite LedgerStore so running QA never mutates live user state.
 */
export async function runAutomatedQaSuite(
  options?: RunQaOptions
): Promise<TestCaseResult[]> {
  const baseAvailability = loadDefaultAvailabilityFromDisk();

  const scenarios: ScenarioDefinition[] = [
    // TC-01 (EN): Official 4-Call Sample Pack
    {
      id: "TC-01",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const enCalls = loadJsonFile<IncomingCall[]>("sample_calls.json");
        const { records, availability } = await processCallBatch(enCalls, {
          store,
          engineMode: "hybrid",
        });

        const [c1, c2, c3, c4] = records;
        const friPm = availability.slots.find(
          (s) => s.day === "Friday" && s.period === "afternoon"
        );

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "BW-1001 (Helga Brandt): urgent -> escalated_urgent & On-Call alerted, no regular slot booked",
            {
              status: c1.status,
              booked: c1.booked_slot,
              alert: Boolean(c1.on_call_alert),
            },
            { status: "escalated_urgent", booked: null, alert: true }
          ),
          assertExactMatch(
            "BW-1002 (Tom Keller): Wednesday morning taken -> proposes Tuesday afternoon & Wednesday afternoon",
            {
              status: c2.status,
              proposed: c2.proposed_slots,
            },
            {
              status: "awaiting_slot_choice",
              proposed: ["Tuesday afternoon", "Wednesday afternoon"],
            }
          ),
          assertExactMatch(
            "BW-1003 (Sandra dropped): unreachable -> needs_review, reply_draft === null, Call 4 still runs",
            {
              status: c3.status,
              reply: c3.reply_draft,
              missingPhoneOrEmail: c3.extracted.missing_fields.includes("phone_or_email"),
            },
            { status: "needs_review", reply: null, missingPhoneOrEmail: true }
          ),
          assertExactMatch(
            "BW-1004 (Priya Nair): mind-change resolves to Friday afternoon + books slot + forwards quote & billing to Office",
            {
              slot: c4.extracted.preferred_slot,
              bookedBy: friPm?.booked_by_call_id ?? null,
              hasQuote: c4.extracted.category.includes("quote"),
              hasBilling: c4.extracted.category.includes("billing"),
              officeTicket: Boolean(c4.office_ticket),
            },
            {
              slot: "Friday afternoon",
              bookedBy: "BW-1004",
              hasQuote: true,
              hasBilling: true,
              officeTicket: true,
            }
          ),
        ];

        store.close();
        return {
          test_id: "TC-01",
          title: "English Official Sample Pack (`BW-1001`–`BW-1004`)",
          language: "en",
          category_tag: "End-to-End Core",
          description:
            "Verifies all 4 official English calls: urgent heating outage, booked-slot nearest alternatives, dropped unreachable call isolation, and caller mind-change + multi-category booking.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: c4,
        };
      },
    },

    // TC-02 (AR): Arabic 4-Call Sample Pack
    {
      id: "TC-02",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const arCalls = loadJsonFile<IncomingCall[]>("sample_calls_arabic.json");
        const { records, availability } = await processCallBatch(arCalls, {
          store,
          engineMode: "hybrid",
        });

        const [a1, a2, a3, a4] = records;
        const friAm = availability.slots.find(
          (s) => s.day === "Friday" && s.period === "morning"
        );

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "BW-AR-101 (فاطمة المنصور): Eastern Arabic phone normalized + emergency -> escalated_urgent + Arabic SMS & English mirror",
            {
              phone: a1.extracted.phone,
              status: a1.status,
              replyLang: a1.reply_draft?.language ?? null,
              hasEnglishMirror: Boolean(a1.reply_draft?.english_mirror),
            },
            {
              phone: "+971 50 111 2233",
              status: "escalated_urgent",
              replyLang: "ar",
              hasEnglishMirror: true,
            }
          ),
          assertExactMatch(
            "BW-AR-102 (خالد العتيبي): صباح الأربعاء booked -> proposes Tuesday afternoon & Wednesday afternoon in Arabic Email",
            {
              slot: a2.extracted.preferred_slot,
              proposed: a2.proposed_slots,
              hasArabicBody: /[\u0600-\u06FF]/.test(a2.reply_draft?.body ?? ""),
            },
            {
              slot: "Wednesday morning",
              proposed: ["Tuesday afternoon", "Wednesday afternoon"],
              hasArabicBody: true,
            }
          ),
          assertExactMatch(
            "BW-AR-103 (سارة — dropped): unreachable -> needs_review, reply_draft === null, batch continues to BW-AR-104",
            { status: a3.status, reply: a3.reply_draft },
            { status: "needs_review", reply: null }
          ),
          assertExactMatch(
            "BW-AR-104 (أحمد الزهراني): Arabic mind-change (الخميس -> صباح الجمعة) books Friday morning + forwards quote & billing",
            {
              slot: a4.extracted.preferred_slot,
              bookedBy: friAm?.booked_by_call_id ?? null,
              hasQuote: a4.extracted.category.includes("quote"),
              hasBilling: a4.extracted.category.includes("billing"),
            },
            {
              slot: "Friday morning",
              bookedBy: "BW-AR-104",
              hasQuote: true,
              hasBilling: true,
            }
          ),
        ];

        store.close();
        return {
          test_id: "TC-02",
          title: "Arabic 4-Call Pack (`BW-AR-101`–`BW-AR-104`)",
          language: "ar",
          category_tag: "Arabic NLP & RTL",
          description:
            "Verifies Arabic speech turns, Eastern Arabic numerals (٠-٩), Arabic mind-change slot resolution, native Arabic customer replies with English operator mirrors, and dropped-call safety.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: a4,
        };
      },
    },

    // TC-03 (EN · Bonus #2): Idempotent Duplicate Webhook Replay Prevention
    {
      id: "TC-03",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const call4 = loadJsonFile<IncomingCall[]>("sample_calls.json")[3];

        const firstRun = await processCallBatch([call4], { store });
        const secondRun = await processCallBatch([call4], { store });

        const r1 = firstRun.records[0];
        const r2 = secondRun.records[0];
        const bookedCount = secondRun.availability.slots.filter(
          (s) => s.booked_by_call_id === "BW-1004"
        ).length;

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "First delivery books Friday afternoon normally (idempotent_replay: false)",
            { status: r1.status, replay: r1.idempotent_replay },
            { status: "booked", replay: false }
          ),
          assertExactMatch(
            "Second identical delivery is intercepted (idempotent_replay: true) and does NOT trigger slot conflict or 2nd booking",
            { status: r2.status, replay: r2.idempotent_replay, bookedSlotsForCall: bookedCount },
            { status: "booked", replay: true, bookedSlotsForCall: 1 }
          ),
        ];

        store.close();
        return {
          test_id: "TC-03",
          title: "Duplicate Webhook Replay Idempotency (`BW-1004` x2)",
          language: "en",
          category_tag: "Bonus: Idempotency",
          description:
            "Proves Bonus Requirement #2: sending the exact same call twice returns the cached ledger record (`idempotent_replay: true`) and never creates a second booking.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: r2,
        };
      },
    },

    // TC-04 (AR · Bonus #2): Arabic Booking Replay + Eastern Digit Phone Precision
    {
      id: "TC-04",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const arBookingCall: IncomingCall = {
          call_id: "QA-AR-REPLAY-04",
          caller_id: null,
          transcript: [
            { speaker: "agent", text: "مرحباً بكم في برايت ووتر، كيف أساعدك؟" },
            {
              speaker: "caller",
              text: "مرحباً، اسمي ليلى الكيلاني. أرغب بحجز صيانة سنوية للسخان يوم الثلاثاء بعد الظهر. عنواني شارع الزهور ٧ ورقم جوالي +٩٧١ ٥٠ ٩٩٨ ٧٧٦٦.",
            },
          ],
        };

        const run1 = await processCallBatch([arBookingCall], { store });
        const run2 = await processCallBatch([arBookingCall], { store });

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Eastern Arabic digits `+٩٧١ ٥٠ ٩٩٨ ٧٧٦٦` normalized verbatim to `+971 50 998 7766` & Tuesday afternoon booked",
            {
              phone: run1.records[0].extracted.phone,
              booked: run1.records[0].booked_slot,
            },
            { phone: "+971 50 998 7766", booked: "Tuesday afternoon" }
          ),
          assertExactMatch(
            "Replay of Arabic booking call is deduplicated cleanly",
            { replay: run2.records[0].idempotent_replay },
            { replay: true }
          ),
        ];

        store.close();
        return {
          test_id: "TC-04",
          title: "Arabic Spoken Phone Normalization + Replay Lock",
          language: "ar",
          category_tag: "Bonus: Idempotency (AR)",
          description:
            "Validates spoken Eastern Arabic phone extraction when `caller_id` is null and ensures replay deduplication holds identically on Arabic payloads.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: run1.records[0],
        };
      },
    },

    // TC-05 (EN · Safety): Subtle Gas Smell Hazard Override
    {
      id: "TC-05",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const gasCall: IncomingCall = {
          call_id: "QA-EN-GAS-2047",
          received: "Tuesday 09:31",
          caller_id: "+49 170 000 4433",
          transcript: [
            {
              speaker: "agent",
              text: "Good morning, Brightwater Heating and Plumbing, this is Lena. How can I help you?",
            },
            {
              speaker: "caller",
              text: "Hi, Mark Taylor here at 12 Linden Road. Our boiler is making a strange clicking noise, and there's been a slight gas smell in the cellar since yesterday. Is Thursday morning possible?",
            },
          ],
        };

        const { records, availability } = await processCallBatch([gasCall], { store });
        const rec = records[0];
        const thuAm = availability.slots.find(
          (s) => s.day === "Thursday" && s.period === "morning"
        );

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Jev `urg_hazard` overrides routine slot request -> urgency === 'urgent' & status === 'escalated_urgent'",
            { urgency: rec.extracted.urgency, status: rec.status },
            { urgency: "urgent", status: "escalated_urgent" }
          ),
          assertExactMatch(
            "Thursday morning remains `free` (never book a regular slot on urgent gas smell!) and phone stays exact `4433`",
            { thuAmStatus: thuAm?.status ?? null, phone: rec.extracted.phone },
            { thuAmStatus: "free", phone: "+49 170 000 4433" }
          ),
        ];

        store.close();
        return {
          test_id: "TC-05",
          title: "Subtle Gas Smell Safety Override (`BW-2047` Cross-Part Guard)",
          language: "en",
          category_tag: "Safety Critical",
          description:
            "Caller requests Thursday morning while casually mentioning a slight gas smell in the cellar. Jev `urg_hazard` forces urgent on-call escalation and prevents regular slot booking.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: rec,
        };
      },
    },

    // TC-06 (AR · Safety): Arabic Burst Pipe / Flooding Emergency Override
    {
      id: "TC-06",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const arFloodCall: IncomingCall = {
          call_id: "QA-AR-FLOOD-06",
          caller_id: "+49 170 888 1212",
          transcript: [
            { speaker: "agent", text: "أهلاً بكم في برايت ووتر، معكم لينا." },
            {
              speaker: "caller",
              text: "معك طارق الحسن، عندي انفجار أنبوب مياه وفيضان في المطبخ الآن! العنوان شارع الوادي ١٨، هل يمكنكم القدوم يوم الأربعاء بعد الظهر أو اليوم؟",
            },
          ],
        };

        const { records, availability } = await processCallBatch([arFloodCall], { store });
        const rec = records[0];
        const wedPm = availability.slots.find(
          (s) => s.day === "Wednesday" && s.period === "afternoon"
        );

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Arabic burst-pipe emergency (`انفجار أنبوب` / `فيضان`) triggers On-Call alert & leaves Wednesday afternoon free",
            {
              urgency: rec.extracted.urgency,
              wedPmStatus: wedPm?.status ?? null,
              alertCreated: Boolean(rec.on_call_alert),
            },
            { urgency: "urgent", wedPmStatus: "free", alertCreated: true }
          ),
        ];

        store.close();
        return {
          test_id: "TC-06",
          title: "Arabic Burst-Pipe Emergency Override (`انفجار أنبوب مياه`)",
          language: "ar",
          category_tag: "Safety Critical (AR)",
          description:
            "Ensures Arabic emergency flood/pipe-burst calls trigger immediate On-Call dispatch, draft an Arabic emergency SMS, and never consume regular technician slots.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: rec,
        };
      },
    },

    // TC-07 (Bilingual · Fault Isolation): Corrupted LLM JSON on Call #1 -> Call #2 Runs
    {
      id: "TC-07",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const badCall: IncomingCall = {
          call_id: "QA-FAULT-BAD-01",
          caller_id: "+49 170 111 0000",
          transcript: [
            { speaker: "caller", text: "Hi, Max Weber at 9 River Road, Thursday morning boiler repair." },
          ],
        };
        const nextArabicCall: IncomingCall = {
          call_id: "QA-FAULT-GOOD-AR-02",
          caller_id: "+49 170 222 3333",
          transcript: [
            {
              speaker: "caller",
              text: "مرحباً، اسمي ريم السالم، أريد صيانة سنوية للسخان يوم الخميس صباحاً، العنوان شارع المروج ٥.",
            },
          ],
        };

        const { records } = await processCallBatch([badCall, nextArabicCall], {
          store,
          faultByCallId: {
            "QA-FAULT-BAD-01": { injectAlwaysMalformedJson: true },
          },
        });

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Corrupted LLM JSON on Call #1 isolates cleanly to `needs_review` without crashing workflow",
            { status: records[0].status, isolated: Boolean(records[0].error_isolated) },
            { status: "needs_review", isolated: true }
          ),
          assertExactMatch(
            "Subsequent Arabic Call #2 still executes and books `Thursday morning` successfully",
            { status: records[1].status, booked: records[1].booked_slot },
            { status: "booked", booked: "Thursday morning" }
          ),
        ];

        store.close();
        return {
          test_id: "TC-07",
          title: "Truncated LLM JSON Fault Isolation (EN Failure -> AR Success)",
          language: "bilingual",
          category_tag: "Resilience & Recovery",
          description:
            "Injects unrecoverable truncated JSON (`{\"caller_name\": \"Max`) on Call #1 and proves Call #1 isolates to `needs_review` while Call #2 (Arabic) completes and books its slot.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: records[0],
        };
      },
    },

    // TC-08 (EN · Value Extraction): Spoken Callback Number Overrides Switchboard caller_id
    {
      id: "TC-08",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const multiPhoneCall: IncomingCall = {
          call_id: "QA-EN-PHONE-08",
          caller_id: "+49 681 00000",
          transcript: [
            { speaker: "agent", text: "Brightwater Heating and Plumbing, how can I help?" },
            {
              speaker: "caller",
              text: "Hi, this is Lukas Meyer calling from our office switchboard, please don't use this landline. Text my direct mobile +49 170 999 8877 instead. I need boiler maintenance at 18 Park Street on Wednesday afternoon.",
            },
          ],
        };

        const { records } = await processCallBatch([multiPhoneCall], { store });
        const rec = records[0];

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Pre-parsed Regex + Jev `Choice` picks spoken mobile `+49 170 999 8877` over switchboard `caller_id`",
            { phone: rec.extracted.phone, smsTo: rec.reply_draft?.to ?? null },
            { phone: "+49 170 999 8877", smsTo: "+49 170 999 8877" }
          ),
        ];

        store.close();
        return {
          test_id: "TC-08",
          title: "Spoken Mobile Disambiguation Over Switchboard `caller_id`",
          language: "en",
          category_tag: "TypeSafe Value Extraction",
          description:
            "Applies TypeSafe's Pre-Parsed Value Extraction Cookbook: regex finds both switchboard and spoken mobile spans; Jev selects the mobile verbatim with zero digit risk.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: rec,
        };
      },
    },

    // TC-09 (AR · Contextual Validation): Pure Arabic Billing Inquiry (No Address Needed)
    {
      id: "TC-09",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: baseAvail,
        });
        const arBillingOnly: IncomingCall = {
          call_id: "QA-AR-BILLING-09",
          caller_id: "+49 170 777 6543",
          transcript: [
            { speaker: "agent", text: "مرحباً بكم في برايت ووتر، كيف أساعدك؟" },
            {
              speaker: "caller",
              text: "مساء الخير، اسمي عمر الفاروق. لدي استفسار بخصوص فاتورة الصيانة الشهر الماضي حيث تم احتساب رسوم الزيارة مرتين، بريدي omar.farooq@example.com ولا أحتاج زيارة فني.",
            },
          ],
        };

        const { records } = await processCallBatch([arBillingOnly], { store });
        const rec = records[0];

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "Pure Arabic billing call has `missing_fields: []` even with `address: null` & routes to Office Queue",
            {
              missing: rec.extracted.missing_fields,
              status: rec.status,
              hasBillingTicket: rec.office_ticket?.categories.includes("billing") ?? false,
            },
            {
              missing: [],
              status: "forwarded_to_office",
              hasBillingTicket: true,
            }
          ),
        ];

        store.close();
        return {
          test_id: "TC-09",
          title: "Contextual Validation: Arabic Billing Inquiry Without Address",
          language: "ar",
          category_tag: "Smart Validation (AR)",
          description:
            "Confirms pure billing inquiries are not falsely flagged `needs_review` for lacking a street address or appointment slot, while routing cleanly to the Office Queue.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: rec,
        };
      },
    },

    // TC-10 (Bilingual · Boundary & Security): 1-Slot Schedule + File Gatekeeper
    {
      id: "TC-10",
      run: async (baseAvail) => {
        const t0 = performance.now();
        const tightAvailability: AvailabilitySchedule = {
          note: "Only 1 slot left free in the entire week.",
          slots: baseAvail.slots.map((s) => ({
            ...s,
            status: s.day === "Friday" && s.period === "afternoon" ? "free" : "booked",
          })),
        };
        const store = new LedgerStore({
          dbPath: ":memory:",
          initialAvailability: tightAvailability,
        });

        const callAskingBooked: IncomingCall = {
          call_id: "QA-BOUNDARY-10",
          caller_id: "+49 170 333 4444",
          transcript: [
            {
              speaker: "caller",
              text: "Hello, Nina Hoffmann at 3 Pine Street. Can I book boiler maintenance on Tuesday morning? Email nina@example.com.",
            },
          ],
        };

        const { records } = await processCallBatch([callAskingBooked], { store });
        const pdfBlocked = validateRestrictedJsonInput({
          fileName: "AI_Engineer_Challenge.pdf",
          mimeType: "application/pdf",
          byteLength: 1024,
          rawText: "%PDF-1.7 fake",
        });
        const spoofBlocked = validateRestrictedJsonInput({
          fileName: "spoofed.json",
          mimeType: "application/json",
          byteLength: 512,
          rawText: "%PDF-1.7 disguised inside .json",
        });

        const assertions: TestCaseAssertion[] = [
          assertExactMatch(
            "When only 1 free slot exists all week, proposes that 1 remaining slot (`Friday afternoon`) without crashing",
            records[0].proposed_slots,
            ["Friday afternoon"]
          ),
          assertExactMatch(
            "Restricted File Gatekeeper blocks both `.pdf` extensions AND magic-byte spoofed `.json` files",
            { pdfValid: pdfBlocked.valid, spoofValid: spoofBlocked.valid },
            { pdfValid: false, spoofValid: false }
          ),
        ];

        store.close();
        return {
          test_id: "TC-10",
          title: "1-Slot Boundary Math + Restricted Upload Security Gate",
          language: "bilingual",
          category_tag: "Security & Boundary",
          description:
            "Verifies graceful boundary behavior when `< 2` slots remain free and tests the restricted upload gatekeeper against `.pdf` and magic-header spoofing.",
          passed: assertions.every((a) => a.passed),
          duration_ms: Math.round(performance.now() - t0),
          assertions,
          record_snapshot: records[0],
        };
      },
    },
  ];

  const selected = options?.onlyTestId
    ? scenarios.filter((s) => s.id === options.onlyTestId)
    : scenarios;

  const results: TestCaseResult[] = [];
  for (let i = 0; i < selected.length; i++) {
    const tcResult = await selected[i].run(baseAvailability);
    results.push(tcResult);
    options?.onTestResult?.(tcResult, i, selected.length);
  }

  return results;
}
