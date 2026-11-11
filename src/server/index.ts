import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import {
  MAX_UPLOAD_BYTES,
  validateRestrictedJsonInput,
} from "../shared/schemas.js";
import type { EngineMode, IncomingCall, TestCaseResult } from "../shared/types.js";
import {
  clearRuntimeAiKeys,
  getRedactedAiStatus,
  updateRuntimeAiConfig,
} from "./ai/runtimeConfig.js";
import { LedgerStore } from "./db/ledgerStore.js";
import { processCallBatch } from "./workflow/orchestrator.js";
import { runAutomatedQaSuite } from "./testing/qaSuite.js";
import {
  buildWorkflowBlueprintExport,
  exportRecordsToCsv,
} from "./export/workflowExporter.js";
import type {
  LenaScenarioEvalResult,
  LenaTestScenarioSpec,
} from "../shared/lenaChallenge2.js";
import {
  buildPart2SubmissionMarkdown,
  getCorrectedLenaPromptText,
  runAllLenaScenarios,
  runLenaAbScenario,
} from "./lena/lenaLabEngine.js";
import { IS_SERVERLESS, readProjectJson } from "./dataFiles.js";

const app = express();

// Normalize Netlify Function invocation paths so Express `/api/*` routes always match
app.use((req, _res, next) => {
  if (req.url.startsWith("/.netlify/functions/api")) {
    const rest = req.url.slice("/.netlify/functions/api".length);
    req.url = `/api${rest.startsWith("/") ? rest : rest ? `/${rest}` : ""}`;
  } else if (IS_SERVERLESS && !req.url.startsWith("/api")) {
    req.url = `/api${req.url.startsWith("/") ? req.url : `/${req.url}`}`;
  }
  next();
});

app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES + 64 * 1024 },
});

const store = new LedgerStore();

interface LastBatchSummary {
  fileName: string;
  engineMode: EngineMode;
  providerMode: "live" | "sandbox";
  callCount: number;
  durationMs: number;
  completedAt: string;
}

let lastBatchSummary: LastBatchSummary | null = null;
let cachedQaResults: {
  ranAt: string;
  providerMode: "live" | "sandbox";
  totalDurationMs: number;
  results: TestCaseResult[];
} | null = null;

let cachedLenaEvals: {
  ranAt: string;
  providerMode: "live" | "sandbox";
  totalDurationMs: number;
  results: LenaScenarioEvalResult[];
} | null = null;

function readSampleCallsFile(filename: string): IncomingCall[] {
  return readProjectJson<IncomingCall[]>(filename);
}

function readSavedMultiTurnAbSummary(): unknown {
  try {
    return readProjectJson<unknown>("data/challenge2_ab_results.json");
  } catch {
    return null;
  }
}

app.get("/api/state", (_req, res) => {
  res.json({
    availability: store.getAvailability(),
    records: store.listRecords(),
    aiStatus: getRedactedAiStatus(),
    lastBatchSummary,
    cachedQaResults,
    cachedLenaEvals,
    correctedLenaPrompt: getCorrectedLenaPromptText(),
    multiTurnAbSummary: readSavedMultiTurnAbSummary(),
    presets: [
      {
        id: "english",
        label: "Official English Pack (4 calls)",
        language: "en",
        count: 4,
      },
      {
        id: "arabic",
        label: "Arabic Pack (4 calls)",
        language: "ar",
        count: 4,
      },
      {
        id: "bilingual",
        label: "Combined Bilingual (8 calls)",
        language: "bilingual",
        count: 8,
      },
    ],
  });
});

app.get("/api/presets/:presetId", (req, res) => {
  try {
    const { presetId } = req.params;
    if (presetId === "english") {
      res.json({
        fileName: "sample_calls.json",
        calls: readSampleCallsFile("sample_calls.json"),
      });
      return;
    }
    if (presetId === "arabic") {
      res.json({
        fileName: "sample_calls_arabic.json",
        calls: readSampleCallsFile("sample_calls_arabic.json"),
      });
      return;
    }
    if (presetId === "bilingual") {
      const en = readSampleCallsFile("sample_calls.json");
      const ar = readSampleCallsFile("sample_calls_arabic.json");
      res.json({
        fileName: "bilingual_combined_calls.json",
        calls: [...en, ...ar],
      });
      return;
    }
    res.status(404).json({ error: `Unknown preset "${presetId}"` });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/config/ai", (req, res) => {
  if (req.body?.clearKeys === true) {
    clearRuntimeAiKeys();
    res.json({ aiStatus: getRedactedAiStatus() });
    return;
  }
  const {
    typesafeApiKey,
    deepseekApiKey,
    typesafeModel,
    deepseekModel,
    allowSandboxWhenUnconfigured,
  } = req.body ?? {};
  updateRuntimeAiConfig({
    typesafeApiKey,
    deepseekApiKey,
    typesafeModel,
    deepseekModel,
    allowSandboxWhenUnconfigured,
  });
  res.json({ aiStatus: getRedactedAiStatus() });
});

app.post("/api/upload/file", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({
      valid: false,
      detectedKind: "invalid",
      error: "No file attached in multipart field `file`.",
      warnings: [],
    });
    return;
  }

  const expectedTarget =
    req.body?.target === "calls" || req.body?.target === "availability"
      ? (req.body.target as "calls" | "availability")
      : "either";

  const rawText = req.file.buffer.toString("utf8");
  const validation = validateRestrictedJsonInput({
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    byteLength: req.file.size,
    rawText,
    expectedTarget,
  });

  if (!validation.valid) {
    res.status(422).json(validation);
    return;
  }

  if (validation.detectedKind === "availability" && validation.parsedAvailability) {
    const updatedAvail = store.setBaselineAvailability(validation.parsedAvailability);
    res.json({
      ...validation,
      availability: updatedAvail,
    });
    return;
  }

  res.json(validation);
});

/**
 * Single-call Webhook Trigger (`POST /api/webhooks/call`).
 * Does NOT reset prior records, so sending the same call twice proves Bonus #2 Idempotency!
 */
app.post("/api/webhooks/call", async (req, res) => {
  try {
    const engineMode: EngineMode =
      req.query.mode === "cascade" || req.query.mode === "benchmark"
        ? req.query.mode
        : "hybrid";

    const payload = req.body;
    const { records, availability, durationMs } = await processCallBatch([payload], {
      store,
      engineMode,
      resetBeforeRun: false,
    });
    res.json({
      record: records[0],
      availability,
      durationMs,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Real-time NDJSON Streaming Workflow Endpoint (`POST /api/runs/stream`).
 * Defaults to `resetBeforeRun: true` so every `.json` file starts fresh on clean `availability.json`
 * without stacking records from previous files!
 */
app.post("/api/runs/stream", async (req, res) => {
  const calls = Array.isArray(req.body?.calls) ? (req.body.calls as unknown[]) : null;
  const fileName =
    typeof req.body?.fileName === "string" && req.body.fileName.trim()
      ? req.body.fileName.trim()
      : "uploaded_calls.json";
  const engineMode: EngineMode =
    req.body?.engineMode === "cascade" || req.body?.engineMode === "benchmark"
      ? req.body.engineMode
      : "hybrid";
  const resetBeforeRun = req.body?.resetBeforeRun !== false;

  if (!calls || calls.length === 0) {
    res.status(400).json({ error: "Request body must contain a non-empty `calls` array." });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const aiStatus = getRedactedAiStatus();
    const { durationMs } = await processCallBatch(calls, {
      store,
      engineMode,
      resetBeforeRun,
      onEvent: (ev) => {
        res.write(`${JSON.stringify(ev)}\n`);
      },
    });
    lastBatchSummary = {
      fileName,
      engineMode,
      providerMode: aiStatus.effectiveMode,
      callCount: calls.length,
      durationMs,
      completedAt: new Date().toISOString(),
    };
  } catch (err) {
    res.write(
      `${JSON.stringify({
        type: "stream_error",
        message: err instanceof Error ? err.message : String(err),
      })}\n`
    );
  } finally {
    res.end();
  }
});

app.post("/api/reset", (_req, res) => {
  const availability = store.resetAll();
  lastBatchSummary = null;
  res.json({
    availability,
    records: [],
    lastBatchSummary: null,
  });
});

app.post("/api/tests/run", async (req, res) => {
  try {
    const onlyTestId =
      typeof req.body?.onlyTestId === "string" ? req.body.onlyTestId : undefined;
    const t0 = performance.now();
    const results = await runAutomatedQaSuite({ onlyTestId });
    const totalDurationMs = Math.round(performance.now() - t0);

    if (!onlyTestId) {
      cachedQaResults = {
        ranAt: new Date().toISOString(),
        providerMode: getRedactedAiStatus().effectiveMode,
        totalDurationMs,
        results,
      };
    } else if (cachedQaResults) {
      cachedQaResults = {
        ...cachedQaResults,
        ranAt: new Date().toISOString(),
        results: cachedQaResults.results.map(
          (prev) => results.find((u) => u.test_id === prev.test_id) ?? prev
        ),
      };
    }

    res.json({
      passedCount: results.filter((r) => r.passed).length,
      totalCount: results.length,
      totalDurationMs,
      results,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Streaming QA Runner (`POST /api/tests/stream`) so Live API runs report each scenario `1/10..10/10`
 * immediately as it completes instead of waiting 50s in silence, and caches results server-side!
 */
app.post("/api/tests/stream", async (req, res) => {
  const onlyTestId =
    typeof req.body?.onlyTestId === "string" ? req.body.onlyTestId : undefined;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const t0 = performance.now();
  try {
    const results = await runAutomatedQaSuite({
      onlyTestId,
      onTestResult: (tcResult, index, total) => {
        res.write(
          `${JSON.stringify({
            type: "qa_progress",
            index,
            total,
            result: tcResult,
          })}\n`
        );
      },
    });
    const totalDurationMs = Math.round(performance.now() - t0);

    if (!onlyTestId) {
      cachedQaResults = {
        ranAt: new Date().toISOString(),
        providerMode: getRedactedAiStatus().effectiveMode,
        totalDurationMs,
        results,
      };
    } else if (cachedQaResults) {
      cachedQaResults = {
        ...cachedQaResults,
        ranAt: new Date().toISOString(),
        results: cachedQaResults.results.map(
          (prev) => results.find((u) => u.test_id === prev.test_id) ?? prev
        ),
      };
    }

    res.write(
      `${JSON.stringify({
        type: "qa_complete",
        totalDurationMs,
        providerMode: getRedactedAiStatus().effectiveMode,
        results: cachedQaResults?.results ?? results,
      })}\n`
    );
  } catch (err) {
    res.write(
      `${JSON.stringify({
        type: "qa_error",
        message: err instanceof Error ? err.message : String(err),
      })}\n`
    );
  } finally {
    res.end();
  }
});

app.post("/api/lena/simulate", async (req, res) => {
  try {
    const body = req.body ?? {};
    const customScenario: LenaTestScenarioSpec = {
      scenario_id: typeof body.scenario_id === "string" ? body.scenario_id : "CUSTOM",
      title: typeof body.title === "string" ? body.title : "Custom Live Probe",
      language: body.language === "ar" ? "ar" : "en",
      call_time: typeof body.call_time === "string" ? body.call_time : "Tuesday 14:30",
      caller_id: typeof body.caller_id === "string" ? body.caller_id : "+49 170 000 9900",
      target_root_causes: Array.isArray(body.target_root_causes)
        ? body.target_root_causes
        : ["Custom"],
      conversation_context: Array.isArray(body.conversation_context)
        ? body.conversation_context
        : [],
      caller_utterance: String(body.caller_utterance ?? "").trim(),
      expected_behavior_short:
        typeof body.expected_behavior_short === "string"
          ? body.expected_behavior_short
          : "Safe, 1-question-at-a-time, zero price leak, accurate triage.",
    };

    if (!customScenario.caller_utterance) {
      res.status(400).json({ error: "caller_utterance must be non-empty." });
      return;
    }

    const result = await runLenaAbScenario(customScenario);
    res.json({ result });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/api/lena/evals/stream", async (req, res) => {
  const onlyScenarioId =
    typeof req.body?.onlyScenarioId === "string" ? req.body.onlyScenarioId : undefined;

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const t0 = performance.now();
  try {
    const results = await runAllLenaScenarios({
      onlyScenarioId,
      onProgress: (item, index, total) => {
        res.write(
          `${JSON.stringify({
            type: "lena_progress",
            index,
            total,
            result: item,
          })}\n`
        );
      },
    });
    const totalDurationMs = Math.round(performance.now() - t0);
    const providerMode = getRedactedAiStatus().effectiveMode;

    if (!onlyScenarioId) {
      cachedLenaEvals = {
        ranAt: new Date().toISOString(),
        providerMode,
        totalDurationMs,
        results,
      };
    } else if (cachedLenaEvals) {
      cachedLenaEvals = {
        ...cachedLenaEvals,
        ranAt: new Date().toISOString(),
        results: cachedLenaEvals.results.map(
          (prev) => results.find((u) => u.scenario_id === prev.scenario_id) ?? prev
        ),
      };
    }

    res.write(
      `${JSON.stringify({
        type: "lena_complete",
        totalDurationMs,
        providerMode,
        results: cachedLenaEvals?.results ?? results,
      })}\n`
    );
  } catch (err) {
    res.write(
      `${JSON.stringify({
        type: "lena_error",
        message: err instanceof Error ? err.message : String(err),
      })}\n`
    );
  } finally {
    res.end();
  }
});

app.get("/api/export/part2-markdown", (_req, res) => {
  const md = buildPart2SubmissionMarkdown(cachedLenaEvals?.results);
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="Part2_Lena_Submission_and_Reflection.md"'
  );
  res.send(md);
});

app.get("/api/export/lena-prompt", (_req, res) => {
  const txt = getCorrectedLenaPromptText();
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="lena_prompt_v2.txt"'
  );
  res.send(txt);
});

app.get("/api/export/csv", (_req, res) => {
  const csv = exportRecordsToCsv(store.listRecords());
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="brightwater_call_outcomes.csv"'
  );
  res.send(csv);
});

app.get("/api/export/json", (_req, res) => {
  const payload = {
    exported_at: new Date().toISOString(),
    last_batch_summary: lastBatchSummary,
    availability: store.getAvailability(),
    records: store.listRecords(),
  };
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="brightwater_outcomes_and_availability.json"'
  );
  res.send(JSON.stringify(payload, null, 2));
});

app.get("/api/export/workflow", (_req, res) => {
  const blueprint = buildWorkflowBlueprintExport({
    availability: store.getAvailability(),
    records: store.listRecords(),
  });
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="amira_brightwater_workflow_export.json"'
  );
  res.send(JSON.stringify(blueprint, null, 2));
});

const clientDistPath = path.resolve(process.cwd(), "dist", "client");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

const PORT = Number(process.env.PORT ?? 3001);
if (process.env.VITEST !== "true" && !IS_SERVERLESS) {
  app.listen(PORT, () => {
    console.log(
      `[Amira Brightwater API] Running on http://localhost:${PORT} (mode: ${getRedactedAiStatus().effectiveMode})`
    );
  });
}

export { app };
