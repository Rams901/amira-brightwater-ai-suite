import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runAutomatedQaSuite } from "../src/server/testing/qaSuite.js";
import { LedgerStore, loadDefaultAvailabilityFromDisk } from "../src/server/db/ledgerStore.js";
import { processCallBatch } from "../src/server/workflow/orchestrator.js";
import {
  buildPart2SubmissionMarkdown,
  runAllLenaScenarios,
} from "../src/server/lena/lenaLabEngine.js";
import { LENA_ROOT_CAUSES } from "../src/shared/lenaChallenge2.js";
import type { IncomingCall } from "../src/shared/types.js";

describe("Challenge 1 — Brightwater Call-to-Outcome Operations Studio (EN + AR)", () => {
  it("passes all 10 automated English, Arabic, Safety, Idempotency & Fault-Isolation test cases", async () => {
    const results = await runAutomatedQaSuite();
    expect(results).toHaveLength(10);
    for (const testCase of results) {
      expect(
        testCase.passed,
        `${testCase.test_id} (${testCase.title}) failed: ${JSON.stringify(testCase.assertions)}`
      ).toBe(true);
    }
  });

  it("supports SDE Cascade and Dual-Engine Benchmark modes on both English and Arabic calls", async () => {
    const store = new LedgerStore({
      dbPath: ":memory:",
      initialAvailability: loadDefaultAvailabilityFromDisk(),
    });

    const enCalls = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "sample_calls.json"), "utf8")
    ) as IncomingCall[];
    const arCalls = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "sample_calls_arabic.json"), "utf8")
    ) as IncomingCall[];

    const cascadeRun = await processCallBatch([enCalls[0]], {
      store,
      engineMode: "cascade",
    });
    expect(cascadeRun.records[0].status).toBe("escalated_urgent");

    const benchmarkRun = await processCallBatch([arCalls[3]], {
      store,
      engineMode: "benchmark",
    });
    expect(benchmarkRun.records[0].status).toBe("booked");
    expect(benchmarkRun.records[0].booked_slot).toBe("Friday morning");
    expect(benchmarkRun.records[0].benchmark_comparison).not.toBeNull();
    expect(benchmarkRun.records[0].benchmark_comparison?.agreement_rate).toBeGreaterThanOrEqual(0.8);

    store.close();
  });
});

describe("Challenge 2 — Lena Voice Agent Fix & 6-Noul Guardrail Suite (EN + AR)", () => {
  it("diagnoses all 7 root causes (including hidden prompt bugs) and passes 8/8 EN+AR voice evals on v2 while catching v1 violations", async () => {
    expect(LENA_ROOT_CAUSES).toHaveLength(7);
    expect(
      LENA_ROOT_CAUSES.some((rc) => rc.visibility === "hidden_in_prompt")
    ).toBe(true);

    const evals = await runAllLenaScenarios();
    expect(evals).toHaveLength(8);

    for (const sc of evals) {
      expect(
        sc.legacy_v1.passed_all_guardrails,
        `Legacy v1 should fail at least 1 Jev guardrail on ${sc.scenario_id}`
      ).toBe(false);
      expect(
        sc.fixed_v2.passed_all_guardrails,
        `Corrected v2 failed Jev guardrail on ${sc.scenario_id}: ${JSON.stringify(sc.fixed_v2.guardrails)}`
      ).toBe(true);
    }

    const markdown = buildPart2SubmissionMarkdown(evals);
    expect(markdown).toContain("## 1. Corrected System Prompt for Lena");
    expect(markdown).toContain("## 2. Root-Cause Change Log");
    expect(markdown).toContain("## 4. Assumptions, Known Weaknesses & What We Would Do With More Time");
  });
});
