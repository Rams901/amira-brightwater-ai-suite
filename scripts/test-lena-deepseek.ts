import fs from "node:fs";
import path from "node:path";
import { runChallenge2AbSuite, type ScenarioEvalResult } from "../src/challenge2/deepseekVoiceHarness.js";

function parseArgs(argv: string[]) {
  let requireLive = false;
  let verbose = false;
  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let model: string | undefined;
  const scenarioIds: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") requireLive = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--api-key" && argv[i + 1]) apiKey = argv[++i];
    else if (arg === "--base-url" && argv[i + 1]) baseUrl = argv[++i];
    else if (arg === "--model" && argv[i + 1]) model = argv[++i];
    else if (arg === "--scenario" && argv[i + 1]) {
      scenarioIds.push(...argv[++i].split(",").map((s) => s.trim().toUpperCase()));
    }
  }

  return { requireLive, verbose, apiKey, baseUrl, model, scenarioIds };
}

function formatTranscriptBlock(res: ScenarioEvalResult): string {
  const lines: string[] = [];
  lines.push(`\n  [${res.promptLabel}] (${res.passed ? "PASS" : "FAIL"} · Judge ${res.judgeScores.overall}/100 · ${res.latencyMs} ms)`);
  for (const turn of res.transcript) {
    const speaker = turn.speaker === "agent" ? "Lena  " : "Caller";
    const sttTag = turn.spokenRawText ? `  [STT misheard spoken: "${turn.spokenRawText}"]` : "";
    lines.push(`    ${speaker}: ${turn.text}${sttTag}`);
  }
  lines.push("    --- Post-Call System Log ---");
  lines.push(`    saved caller_name = ${JSON.stringify(res.systemLog.saved_caller_name)}`);
  lines.push(`    saved phone       = ${JSON.stringify(res.systemLog.saved_phone)}`);
  lines.push(`    saved address     = ${JSON.stringify(res.systemLog.saved_address)}`);
  lines.push(`    saved urgency     = ${JSON.stringify(res.systemLog.saved_urgency)}`);
  lines.push(`    saved appointment = ${JSON.stringify(res.systemLog.saved_appointment)}`);
  lines.push(`    saved categories  = ${JSON.stringify(res.systemLog.saved_categories)}`);
  for (const inv of res.invariants) {
    lines.push(`    [${inv.passed ? "OK" : "XX"}] ${inv.label}: ${inv.detail}`);
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const v1Path = path.resolve(rootDir, "lena_prompt.txt");
  const v2Path = path.resolve(rootDir, "lena_prompt_v2.txt");

  const v1PromptText = fs.readFileSync(v1Path, "utf8");
  const v2PromptText = fs.readFileSync(v2Path, "utf8");

  console.log("================================================================================");
  console.log("  BRIGHTWATER CHALLENGE 2 — DEEPSEEK FLASH 4.1 PROMPT VERIFICATION SUITE");
  console.log("================================================================================");

  const summary = await runChallenge2AbSuite({
    v1PromptText,
    v2PromptText,
    options: {
      apiKey: args.apiKey,
      baseUrl: args.baseUrl,
      model: args.model,
      requireLive: args.requireLive,
      scenarioIds: args.scenarioIds.length > 0 ? args.scenarioIds : undefined,
    },
  });

  console.log(`Execution Mode : ${summary.executionMode}`);
  console.log(`Model          : ${summary.model}`);
  if (summary.executionMode === "prompt-behavioral-sim") {
    console.log(
      "Note           : DEEPSEEK_API_KEY not found in .env; ran prompt-trait behavioral simulation.\n" +
        "                 Set DEEPSEEK_API_KEY in .env (or pass --api-key <key> --live) to execute live DeepSeek V4.1 Flash API turns."
    );
  } else {
    console.log(
      `Tokens & Cost  : ${summary.totalInputTokens} in / ${summary.totalOutputTokens} out (~$${summary.estimatedCostUsd} USD)`
    );
  }
  console.log("--------------------------------------------------------------------------------");
  console.log(
    `Legacy v1 (lena_prompt.txt)    : ${summary.v1PassedCount}/${summary.totalScenarios} passed (${summary.v1PassRatePct}%) | Avg Rubric Score: ${summary.v1AvgJudgeScore}/100`
  );
  console.log(
    `Repaired v2 (lena_prompt_v2.txt): ${summary.v2PassedCount}/${summary.totalScenarios} passed (${summary.v2PassRatePct}%) | Avg Rubric Score: ${summary.v2AvgJudgeScore}/100`
  );
  console.log("--------------------------------------------------------------------------------\n");

  for (let i = 0; i < summary.results.v2.length; i++) {
    const r1 = summary.results.v1[i];
    const r2 = summary.results.v2[i];
    const v1Badge = r1.passed ? "PASS" : "FAIL";
    const v2Badge = r2.passed ? "PASS" : "FAIL";
    console.log(
      `${r2.scenarioId.padEnd(4)} | v1: ${v1Badge} (${String(r1.judgeScores.overall).padStart(3)}/100) -> v2: ${v2Badge} (${String(r2.judgeScores.overall).padStart(3)}/100) | ${r2.scenarioTitle}`
    );

    if (args.verbose || r2.scenarioId === "S1" || r2.scenarioId === "S3" || !r2.passed) {
      console.log(formatTranscriptBlock(r1));
      console.log(formatTranscriptBlock(r2));
      console.log("");
    }
  }

  const outDir = path.resolve(rootDir, "data");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = path.resolve(outDir, "challenge2_ab_results.json");
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`\nSaved full A/B transcripts, system logs & invariant audit to: ${outPath}`);

  if (summary.v2PassedCount < summary.totalScenarios) {
    console.error(
      `\nVerification failed: Repaired prompt passed ${summary.v2PassedCount}/${summary.totalScenarios} scenarios.`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Challenge 2 verification runner error:", err);
  process.exit(1);
});
