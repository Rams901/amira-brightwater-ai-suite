import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  inspectPromptTraits,
  runChallenge2AbSuite,
} from "../src/challenge2/deepseekVoiceHarness.js";

describe("Challenge 2 — Lena Voice Prompt Repair & DeepSeek Flash 4.1 Verification Suite", () => {
  const v1Prompt = fs.readFileSync(path.resolve(process.cwd(), "lena_prompt.txt"), "utf8");
  const v2Prompt = fs.readFileSync(path.resolve(process.cwd(), "lena_prompt_v2.txt"), "utf8");

  it("removes every structural prompt defect identified in the forensic audit", () => {
    const v1Traits = inspectPromptTraits(v1Prompt);
    const v2Traits = inspectPromptTraits(v2Prompt);

    // Legacy v1 contains all root-cause defects
    expect(v1Traits.hasPriceFiguresInPrompt).toBe(true);
    expect(v1Traits.forbidsReadback).toBe(true);
    expect(v1Traits.hasEmergencyTriage).toBe(false);
    expect(v1Traits.asksFiveFieldsAtOnce).toBe(true);
    expect(v1Traits.hardcodesGoodMorningOnly).toBe(true);

    // Repaired v2 eliminates contradictions, enforces readback, and stays compact for DeepSeek V4.1 Flash
    expect(v2Traits.hasPriceFiguresInPrompt).toBe(false);
    expect(v2Traits.forbidsReadback).toBe(false);
    expect(v2Traits.mandatesReadback).toBe(true);
    expect(v2Traits.hasEmergencyTriage).toBe(true);
    expect(v2Traits.asksFiveFieldsAtOnce).toBe(false);
    expect(v2Traits.hardcodesGoodMorningOnly).toBe(false);
    expect(v2Traits.forbidsConfirmedBooking).toBe(true);
    expect(v2Traits.hasOutOfScopeGuard).toBe(true);
    expect(v2Traits.hasNonBookingBillingFlow).toBe(true);
  });

  it("reproduces BW-2047 failures on v1 and achieves 10/10 (100%) pass rate on repaired v2 across all adversarial scenarios", async () => {
    const summary = await runChallenge2AbSuite({
      v1PromptText: v1Prompt,
      v2PromptText: v2Prompt,
    });

    expect(summary.totalScenarios).toBe(10);

    // Legacy v1 fails S1 (BW-2047 gas leak + price leak + 4483 phone corruption) and overall suite
    const s1Legacy = summary.results.v1.find((r) => r.scenarioId === "S1")!;
    expect(s1Legacy.passed).toBe(false);
    expect(s1Legacy.systemLog.saved_phone).toBe("0170 000 4483");
    expect(s1Legacy.systemLog.saved_categories).toContain("maintenance");
    expect(summary.v1PassRatePct).toBeLessThanOrEqual(20);

    // Repaired v2 fixes S1 completely (catches 4483 -> 4433, saves 12 Linden Road, escalates urgent on-call, quotes 0 prices)
    const s1Repaired = summary.results.v2.find((r) => r.scenarioId === "S1")!;
    expect(s1Repaired.passed).toBe(true);
    expect(s1Repaired.systemLog.saved_phone).toBe("0170 000 4433");
    expect(s1Repaired.systemLog.saved_address).toBe("12 Linden Road");
    expect(s1Repaired.systemLog.saved_urgency).toBe("urgent");
    expect(s1Repaired.systemLog.saved_appointment).toBeNull();
    expect(s1Repaired.systemLog.saved_categories).toEqual(["repair"]);

    // Repaired v2 passes all 10 scenarios (100%)
    for (const r of summary.results.v2) {
      expect(
        r.passed,
        `${r.scenarioId} (${r.scenarioTitle}) failed invariants: ${JSON.stringify(
          r.invariants.filter((i) => !i.passed)
        )}`
      ).toBe(true);
    }
    expect(summary.v2PassRatePct).toBe(100);
  });
});
