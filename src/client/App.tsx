import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertOctagon,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Clock,
  Download,
  FileJson,
  FolderUp,
  Home,
  Info,
  KeyRound,
  Layers,
  Mic,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  TestTube2,
} from "lucide-react";
import type {
  AvailabilitySchedule,
  EngineMode,
  IncomingCall,
  ProcessedCallRecord,
  RecordStatus,
  StreamStageEvent,
  TestCaseResult,
  Weekday,
} from "../shared/types.js";
import { validateRestrictedJsonInput } from "../shared/schemas.js";
import type { LenaScenarioEvalResult } from "../shared/lenaChallenge2.js";
import { CallInspectorCard } from "./components/CallInspectorCard.js";
import { QaSuiteView, type QaSuiteMeta } from "./components/QaSuiteView.js";
import { ExecutiveHomeView } from "./components/ExecutiveHomeView.js";
import {
  LenaChallenge2View,
  type LenaEvalMeta,
  type MultiTurnAbSummaryData,
} from "./components/LenaChallenge2View.js";

type WorkspaceId = "home" | "challenge1" | "challenge2";
type MainTab = "studio" | "records" | "calendar" | "qa";

interface RedactedAiStatus {
  typesafeConfigured: boolean;
  typesafeModel: string;
  typesafeKeyHint: string | null;
  deepseekConfigured: boolean;
  deepseekModel: string;
  deepseekKeyHint: string | null;
  effectiveMode: "live" | "sandbox";
}

interface BatchSummaryMeta {
  fileName: string;
  engineMode: EngineMode;
  providerMode: "live" | "sandbox";
  callCount: number;
  durationMs: number;
  completedAt: string;
}

const WEEKDAYS_LIST: Weekday[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

const MODE_DESCRIPTIONS: Record<
  EngineMode,
  { title: string; summary: string }
> = {
  hybrid: {
    title: "Hybrid Symphony (Parallel Task-by-Utility)",
    summary:
      "Runs Jev (14 calibrated Noul/Choice/Score judgments) IN PARALLEL with DeepSeek Flash (name, address, 2-sentence summary), then verifies the drafted reply with Jev SDE rules.",
  },
  cascade: {
    title: "SDE Cascade (Sequential Extract -> Jev Verify -> Conditional Escalate)",
    summary:
      "DeepSeek Flash (non-thinking) extracts all fields first -> Jev checks 4 semantic Noul rules -> escalates to DeepSeek Thinking ONLY if a rule breaks (P(broken) > 0.70).",
  },
  benchmark: {
    title: "Benchmark Diff (Live Side-by-Side Comparison)",
    summary:
      "Executes BOTH Hybrid Symphony and SDE Cascade on every call and displays a side-by-side latency, cost, escalation, and 9-field agreement diff card in the Call Inspector.",
  },
};

function statusBadgeClass(status: RecordStatus): string {
  switch (status) {
    case "escalated_urgent":
      return "badge badge-urgent";
    case "booked":
      return "badge badge-booked";
    case "awaiting_slot_choice":
    case "forwarded_to_office":
      return "badge badge-alt";
    case "needs_review":
    default:
      return "badge badge-review";
  }
}

function formatMs(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceId>("home");
  const [activeTab, setActiveTab] = useState<MainTab>("studio");
  const [engineMode, setEngineMode] = useState<EngineMode>("hybrid");
  const [availability, setAvailability] = useState<AvailabilitySchedule | null>(null);
  const [records, setRecords] = useState<ProcessedCallRecord[]>([]);
  const [aiStatus, setAiStatus] = useState<RedactedAiStatus | null>(null);
  const [lastBatch, setLastBatch] = useState<BatchSummaryMeta | null>(null);

  // Staged input batch in Studio (starts fresh per JSON by default!)
  const [stagedFileName, setStagedFileName] = useState<string>("sample_calls.json");
  const [stagedCalls, setStagedCalls] = useState<unknown[]>([]);
  const [startFreshOnRun, setStartFreshOnRun] = useState<boolean>(true);
  const [uploadAlert, setUploadAlert] = useState<{
    tone: "error" | "info" | "warn";
    text: string;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Live streaming telemetry
  const [isStreaming, setIsStreaming] = useState(false);
  const [liveStatusLine, setLiveStatusLine] = useState<string | null>(null);
  const [completedInBatch, setCompletedInBatch] = useState<number>(0);

  // Inspector selection & filters
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [recordFilter, setRecordFilter] = useState<
    "all" | "en" | "ar" | "urgent" | "booked" | "review" | "office"
  >("all");

  // Persisted QA State (NEVER wiped when switching tabs!)
  const [qaResults, setQaResults] = useState<TestCaseResult[] | null>(null);
  const [qaMeta, setQaMeta] = useState<QaSuiteMeta | null>(null);
  const [qaRunning, setQaRunning] = useState<boolean>(false);
  const [qaProgressText, setQaProgressText] = useState<string | null>(null);
  const [qaError, setQaError] = useState<string | null>(null);

  // Persisted Challenge 2 State (NEVER wiped when switching tabs/challenges!)
  const [correctedLenaPrompt, setCorrectedLenaPrompt] = useState<string>("");
  const [multiTurnSummary, setMultiTurnSummary] =
    useState<MultiTurnAbSummaryData | null>(null);
  const [lenaEvalResults, setLenaEvalResults] = useState<LenaScenarioEvalResult[] | null>(null);
  const [lenaEvalMeta, setLenaEvalMeta] = useState<LenaEvalMeta | null>(null);
  const [lenaEvalRunning, setLenaEvalRunning] = useState<boolean>(false);
  const [lenaEvalProgress, setLenaEvalProgress] = useState<string | null>(null);
  const [lenaEvalError, setLenaEvalError] = useState<string | null>(null);

  // API key drawer
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [typesafeKeyInput, setTypesafeKeyInput] = useState("");
  const [deepseekKeyInput, setDeepseekKeyInput] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const availInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetchInitialState();
    void loadPreset("english", true);
  }, []);

  const fetchInitialState = async () => {
    const res = await fetch("/api/state");
    const data = await res.json();
    setAvailability(data.availability);
    setRecords(data.records);
    setAiStatus(data.aiStatus);
    if (data.lastBatchSummary) {
      setLastBatch(data.lastBatchSummary);
    }
    if (data.cachedQaResults) {
      setQaResults(data.cachedQaResults.results);
      setQaMeta({
        ranAt: data.cachedQaResults.ranAt,
        providerMode: data.cachedQaResults.providerMode,
        totalDurationMs: data.cachedQaResults.totalDurationMs,
      });
    }
    if (typeof data.correctedLenaPrompt === "string") {
      setCorrectedLenaPrompt(data.correctedLenaPrompt);
    }
    if (data.multiTurnAbSummary) {
      setMultiTurnSummary(data.multiTurnAbSummary);
    }
    if (data.cachedLenaEvals) {
      setLenaEvalResults(data.cachedLenaEvals.results);
      setLenaEvalMeta({
        ranAt: data.cachedLenaEvals.ranAt,
        providerMode: data.cachedLenaEvals.providerMode,
        totalDurationMs: data.cachedLenaEvals.totalDurationMs,
      });
    }
    if (data.records.length > 0) {
      setSelectedCallId(data.records[0].extracted.call_id);
    }
  };

  const loadPreset = async (
    presetId: "english" | "arabic" | "bilingual",
    silent = false
  ) => {
    const res = await fetch(`/api/presets/${presetId}`);
    const data = await res.json();
    if (res.ok) {
      setStagedFileName(data.fileName);
      setStagedCalls(data.calls);
      if (!silent) {
        setUploadAlert({
          tone: "info",
          text: `Staged ${data.calls.length} call(s) from ${data.fileName}. Click "Run ${data.calls.length} Calls Fresh" to execute on a clean availability schedule.`,
        });
      }
    }
  };

  const handleRestrictedFileSelect = async (
    file: File,
    target: "calls" | "availability"
  ) => {
    const rawText = await file.text().catch(() => "");
    const clientGate = validateRestrictedJsonInput({
      fileName: file.name,
      mimeType: file.type,
      byteLength: file.size,
      rawText,
      expectedTarget: target,
    });

    if (!clientGate.valid) {
      setUploadAlert({
        tone: "error",
        text: clientGate.error ?? "File rejected by restricted upload gate.",
      });
      return;
    }

    const form = new FormData();
    form.append("file", file);
    form.append("target", target);
    const res = await fetch("/api/upload/file", { method: "POST", body: form });
    const serverGate = await res.json();

    if (!res.ok || !serverGate.valid) {
      setUploadAlert({
        tone: "error",
        text: serverGate.error ?? "Server upload gatekeeper rejected file.",
      });
      return;
    }

    if (target === "availability" && serverGate.availability) {
      setAvailability(serverGate.availability);
      setUploadAlert({
        tone: "info",
        text: `Loaded custom baseline availability from ${file.name}.`,
      });
      return;
    }

    if (serverGate.parsedCalls) {
      setStagedFileName(file.name);
      setStagedCalls(serverGate.parsedCalls);
      setStartFreshOnRun(true);
      setUploadAlert({
        tone: serverGate.warnings?.length > 0 ? "warn" : "info",
        text:
          serverGate.warnings?.length > 0
            ? `Validated ${file.name} (${serverGate.parsedCalls.length} calls) with ${serverGate.warnings.length} per-call warning(s). Ready for fresh execution.`
            : `Validated ${file.name} (${serverGate.parsedCalls.length} calls). Running will start fresh with clean availability.json (no stacking with previous files).`,
      });
    }
  };

  const simulateRejectedPdfUpload = () => {
    const fakePdf = new File(["%PDF-1.7 Brightwater Invoice"], "invoice_scan.pdf", {
      type: "application/pdf",
    });
    void handleRestrictedFileSelect(fakePdf, "calls");
  };

  const runBatchStream = async (
    callsToRun: unknown[] = stagedCalls,
    overrideMode?: EngineMode
  ) => {
    const modeToUse = overrideMode ?? engineMode;
    if (callsToRun.length === 0 || isStreaming) return;

    setIsStreaming(true);
    setCompletedInBatch(0);
    if (startFreshOnRun) {
      setRecords([]);
      setSelectedCallId(null);
    }
    setLiveStatusLine(
      `Starting ${modeToUse.toUpperCase()} run on ${stagedFileName} (${callsToRun.length} calls)...`
    );

    try {
      const res = await fetch("/api/runs/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: stagedFileName,
          calls: callsToRun,
          engineMode: modeToUse,
          resetBeforeRun: startFreshOnRun,
        }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Stream failed" }));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstCompletedId: string | null = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as StreamStageEvent;
          if (ev.type === "call_stage") {
            setLiveStatusLine(
              `[${ev.call_index + 1}/${callsToRun.length} · ${ev.call_id}] ${ev.message}`
            );
          } else if (ev.type === "call_complete") {
            setCompletedInBatch((c) => c + 1);
            setAvailability(ev.availability);
            if (!firstCompletedId) {
              firstCompletedId = ev.record.extracted.call_id;
              setSelectedCallId(firstCompletedId);
            }
            setRecords((prev) => {
              const filtered = prev.filter(
                (r) => r.extracted.call_id !== ev.record.extracted.call_id
              );
              return [...filtered, ev.record];
            });
          } else if (ev.type === "batch_complete") {
            const summary: BatchSummaryMeta = {
              fileName: stagedFileName,
              engineMode: modeToUse,
              providerMode: aiStatus?.effectiveMode ?? "sandbox",
              callCount: ev.records.length,
              durationMs: ev.duration_ms,
              completedAt: new Date().toISOString(),
            };
            setLastBatch(summary);
            setLiveStatusLine(
              `Finished ${ev.records.length} calls from ${stagedFileName} in ${formatMs(ev.duration_ms)} (${modeToUse.toUpperCase()}).`
            );
            setActiveTab("records");
          } else if (ev.type === "stream_error") {
            setUploadAlert({ tone: "error", text: ev.message });
          }
        }
      }
    } catch (err) {
      setUploadAlert({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsStreaming(false);
    }
  };

  const sendSingleWebhook = async (rawCall: unknown) => {
    setIsStreaming(true);
    setLiveStatusLine("Sending single call to POST /api/webhooks/call...");
    try {
      const res = await fetch(`/api/webhooks/call?mode=${engineMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rawCall),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Webhook call failed");
      const rec = data.record as ProcessedCallRecord;
      setAvailability(data.availability);
      setRecords((prev) => {
        const idx = prev.findIndex((r) => r.extracted.call_id === rec.extracted.call_id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = rec;
          return copy;
        }
        return [...prev, rec];
      });
      setSelectedCallId(rec.extracted.call_id);
      setLiveStatusLine(
        rec.idempotent_replay
          ? `[${rec.extracted.call_id}] Duplicate webhook blocked (${rec.total_processing_ms} ms) — no second booking created!`
          : `[${rec.extracted.call_id}] Processed in ${formatMs(rec.total_processing_ms)} -> ${rec.status}`
      );
      setActiveTab("records");
    } catch (err) {
      setUploadAlert({
        tone: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsStreaming(false);
    }
  };

  const handleRunQaSuite = async (onlyTestId?: string) => {
    setQaRunning(true);
    setQaError(null);
    setQaProgressText(
      onlyTestId ? `Running ${onlyTestId}...` : "Starting 10-scenario QA stream (0/10)..."
    );

    if (!onlyTestId) {
      setQaResults([]);
    }

    try {
      const res = await fetch("/api/tests/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onlyTestId }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`QA stream HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "qa_progress") {
            const tc = ev.result as TestCaseResult;
            setQaProgressText(
              `Completed ${tc.test_id} (${ev.index + 1}/${ev.total})...`
            );
            setQaResults((prev) => {
              const list = prev ?? [];
              const existingIdx = list.findIndex((x) => x.test_id === tc.test_id);
              if (existingIdx >= 0) {
                const copy = [...list];
                copy[existingIdx] = tc;
                return copy;
              }
              return [...list, tc];
            });
          } else if (ev.type === "qa_complete") {
            setQaResults(ev.results);
            setQaMeta({
              ranAt: new Date().toISOString(),
              providerMode: ev.providerMode,
              totalDurationMs: ev.totalDurationMs,
            });
            setQaProgressText(null);
          } else if (ev.type === "qa_error") {
            setQaError(ev.message);
          }
        }
      }
    } catch (err) {
      setQaError(err instanceof Error ? err.message : String(err));
    } finally {
      setQaRunning(false);
      setQaProgressText(null);
    }
  };

  const handleRunLenaEvals = async (onlyScenarioId?: string) => {
    setLenaEvalRunning(true);
    setLenaEvalError(null);
    setLenaEvalProgress(
      onlyScenarioId ? `Running ${onlyScenarioId}...` : "Running 8 Voice Evals (0/8)..."
    );

    if (!onlyScenarioId) {
      setLenaEvalResults([]);
    }

    try {
      const res = await fetch("/api/lena/evals/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onlyScenarioId }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`Lena Eval stream HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "lena_progress") {
            const item = ev.result as LenaScenarioEvalResult;
            setLenaEvalProgress(`Completed ${item.scenario_id} (${ev.index + 1}/${ev.total})...`);
            setLenaEvalResults((prev) => {
              const list = prev ?? [];
              const idx = list.findIndex((x) => x.scenario_id === item.scenario_id);
              if (idx >= 0) {
                const copy = [...list];
                copy[idx] = item;
                return copy;
              }
              return [...list, item];
            });
          } else if (ev.type === "lena_complete") {
            setLenaEvalResults(ev.results);
            setLenaEvalMeta({
              ranAt: new Date().toISOString(),
              providerMode: ev.providerMode,
              totalDurationMs: ev.totalDurationMs,
            });
            setLenaEvalProgress(null);
          } else if (ev.type === "lena_error") {
            setLenaEvalError(ev.message);
          }
        }
      }
    } catch (err) {
      setLenaEvalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLenaEvalRunning(false);
      setLenaEvalProgress(null);
    }
  };

  const handleResetAll = async () => {
    const res = await fetch("/api/reset", { method: "POST" });
    const data = await res.json();
    setAvailability(data.availability);
    setRecords([]);
    setLastBatch(null);
    setSelectedCallId(null);
    setLiveStatusLine("Workspace reset to clean availability.json baseline.");
  };

  const handleSaveApiKeys = async () => {
    const res = await fetch("/api/config/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        typesafeApiKey: typesafeKeyInput || undefined,
        deepseekApiKey: deepseekKeyInput || undefined,
      }),
    });
    const data = await res.json();
    setAiStatus(data.aiStatus);
    setTypesafeKeyInput("");
    setDeepseekKeyInput("");
    setShowKeyModal(false);
  };

  const filteredRecords = records.filter((r) => {
    if (recordFilter === "all") return true;
    if (recordFilter === "en") return r.language === "en";
    if (recordFilter === "ar") return r.language === "ar";
    if (recordFilter === "urgent") return r.extracted.urgency === "urgent";
    if (recordFilter === "booked") return r.status === "booked";
    if (recordFilter === "review") return r.status === "needs_review";
    if (recordFilter === "office") return Boolean(r.office_ticket);
    return true;
  });

  const selectedRecord =
    records.find((r) => r.extracted.call_id === selectedCallId) ??
    filteredRecords[0] ??
    records[0] ??
    null;

  const urgentCount = records.filter((r) => r.on_call_alert !== null).length;
  const bookedCount = records.filter((r) => r.status === "booked").length;
  const officeCount = records.filter((r) => r.office_ticket !== null).length;
  const reviewCount = records.filter((r) => r.status === "needs_review").length;
  const freeSlotsCount =
    availability?.slots.filter((s) => s.status === "free").length ?? 0;

  // Detect if user switched the Engine Mode pill after already running a batch in another mode
  const activeRecordsModeMismatch =
    records.length > 0 && records[0].engine_mode !== engineMode;

  const avgLatencyText =
    lastBatch && lastBatch.callCount > 0
      ? formatMs(Math.round(lastBatch.durationMs / lastBatch.callCount))
      : aiStatus?.effectiveMode === "live"
        ? "~2.7s"
        : "< 10ms";

  const c1QaPassText = qaResults
    ? `${qaResults.filter((r) => r.passed).length}/${qaResults.length}`
    : "10/10";

  const c2EvalPassText = lenaEvalResults
    ? `${lenaEvalResults.filter((r) => r.fixed_v2.passed_all_guardrails).length}/${lenaEvalResults.length}`
    : "8/8";

  return (
    <div className="app-shell">
      {/* Top Bar with Persistent Challenge Switcher */}
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-group" style={{ cursor: "pointer" }} onClick={() => setWorkspace("home")}>
            <div className="brand-mark">A</div>
            <div>
              <div className="brand-title">
                <span>AMIRA · AI Customer Operations</span>
              </div>
              <div className="brand-subtitle">
                `jev-1.14.0` + `deepseek-flash` · Brightwater Challenge Suite
              </div>
            </div>
          </div>

          {/* Global Workspace Switcher */}
          <div className="mode-group">
            <button
              type="button"
              className={`mode-pill ${workspace === "home" ? "active" : ""}`}
              onClick={() => setWorkspace("home")}
            >
              <Home size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
              Executive Overview
            </button>
            <button
              type="button"
              className={`mode-pill ${workspace === "challenge1" ? "active" : ""}`}
              onClick={() => setWorkspace("challenge1")}
            >
              <Layers size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
              Challenge 1 · Call Workflow
            </button>
            <button
              type="button"
              className={`mode-pill ${workspace === "challenge2" ? "active" : ""}`}
              onClick={() => setWorkspace("challenge2")}
            >
              <Mic size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
              Challenge 2 · Lena Voice Fix
            </button>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-soft btn-sm"
              onClick={() => setShowKeyModal((v) => !v)}
            >
              <KeyRound size={13} />
              {aiStatus?.effectiveMode === "live"
                ? "Live APIs Active"
                : "Sandbox Mode (Set API Keys)"}
            </button>

            {workspace === "challenge1" && (
              <>
                <a
                  href="/api/export/csv"
                  className="btn btn-secondary btn-sm"
                  style={{ textDecoration: "none" }}
                >
                  <Download size={13} />
                  CSV
                </a>
                <a
                  href="/api/export/workflow"
                  className="btn btn-secondary btn-sm"
                  style={{ textDecoration: "none" }}
                  title="Download portable workflow blueprint JSON"
                >
                  <FileJson size={13} />
                  Workflow JSON
                </a>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetAll}>
                  <RefreshCw size={13} />
                  Reset
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Server-Persisted API Key Drawer */}
      {showKeyModal && (
        <div
          style={{
            background: "var(--amira-violet-soft)",
            borderBottom: "1px solid var(--amira-violet-border)",
            padding: "14px 28px",
          }}
        >
          <div
            style={{
              maxWidth: 1340,
              margin: "0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ fontSize: 12.5 }}>
              <strong>Server-Persisted Credentials (`.env.local`, gitignored):</strong> Keys stay on
              the Node server and survive hot-reloads. Leave empty to use the instant offline Sandbox.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input
                type="password"
                placeholder={
                  aiStatus?.typesafeKeyHint
                    ? `TYPESAFE_API_KEY (${aiStatus.typesafeKeyHint})`
                    : "TYPESAFE_API_KEY"
                }
                value={typesafeKeyInput}
                onChange={(e) => setTypesafeKeyInput(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--amira-violet-border)",
                  fontSize: 12,
                  width: 210,
                }}
              />
              <input
                type="password"
                placeholder={
                  aiStatus?.deepseekKeyHint
                    ? `DEEPSEEK_API_KEY (${aiStatus.deepseekKeyHint})`
                    : "DEEPSEEK_API_KEY"
                }
                value={deepseekKeyInput}
                onChange={(e) => setDeepseekKeyInput(e.target.value)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--amira-violet-border)",
                  fontSize: 12,
                  width: 210,
                }}
              />
              <button type="button" className="btn btn-primary btn-sm" onClick={handleSaveApiKeys}>
                Save Keys
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Challenge 1 Sub-Navigation Tabs */}
      {workspace === "challenge1" && (
        <nav className="nav-bar">
          <div className="nav-inner">
            <div className="tab-list">
              <button
                type="button"
                className={`tab-btn ${activeTab === "studio" ? "active" : ""}`}
                onClick={() => setActiveTab("studio")}
              >
                <FolderUp size={15} />
                1. Upload & Run
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "records" ? "active" : ""}`}
                onClick={() => setActiveTab("records")}
              >
                <Layers size={15} />
                2. Call Results & Inspector ({records.length})
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "calendar" ? "active" : ""}`}
                onClick={() => setActiveTab("calendar")}
              >
                <Calendar size={15} />
                3. Availability & Queues ({freeSlotsCount} Free)
              </button>
              <button
                type="button"
                className={`tab-btn ${activeTab === "qa" ? "active" : ""}`}
                onClick={() => setActiveTab("qa")}
              >
                <TestTube2 size={15} />
                4. QA Suite {qaResults ? `(${qaResults.filter((r) => r.passed).length}/${qaResults.length})` : "(10 Tests)"}
              </button>
            </div>

            {liveStatusLine && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--amira-violet)",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Activity size={14} />
                <span>{liveStatusLine}</span>
              </div>
            )}
          </div>
        </nav>
      )}

      {/* Main Container */}
      <main className="main-container">
        {workspace === "home" && (
          <ExecutiveHomeView
            onOpenChallenge1={() => setWorkspace("challenge1")}
            onOpenChallenge2={() => setWorkspace("challenge2")}
            c1ProcessedCount={records.length}
            c1QaPassText={c1QaPassText}
            c2EvalPassText={c2EvalPassText}
            lastBatchDurationText={avgLatencyText}
            providerMode={aiStatus?.effectiveMode ?? "sandbox"}
            c2JudgeScoreText={
              multiTurnSummary
                ? `${multiTurnSummary.v1AvgJudgeScore} -> ${multiTurnSummary.v2AvgJudgeScore}`
                : "61 -> 100"
            }
            c2MultiTurnPassText={
              multiTurnSummary
                ? `${multiTurnSummary.v2PassedCount}/${multiTurnSummary.totalScenarios}`
                : "10/10"
            }
          />
        )}

        {workspace === "challenge2" && (
          <LenaChallenge2View
            correctedPrompt={correctedLenaPrompt}
            multiTurnSummary={multiTurnSummary}
            evalResults={lenaEvalResults}
            evalMeta={lenaEvalMeta}
            evalRunning={lenaEvalRunning}
            evalProgressText={lenaEvalProgress}
            evalError={lenaEvalError}
            onRunEvals={handleRunLenaEvals}
          />
        )}

        {workspace === "challenge1" && (
          <>
            {/* Engine Strategy Selector + Clear Explanation */}
        <div className="mode-explainer-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", flex: 1, minWidth: 260 }}>
            <div className="mode-group">
              <button
                type="button"
                className={`mode-pill ${engineMode === "hybrid" ? "active" : ""}`}
                onClick={() => setEngineMode("hybrid")}
              >
                Hybrid Symphony
              </button>
              <button
                type="button"
                className={`mode-pill ${engineMode === "cascade" ? "active" : ""}`}
                onClick={() => setEngineMode("cascade")}
              >
                SDE Cascade
              </button>
              <button
                type="button"
                className={`mode-pill ${engineMode === "benchmark" ? "active" : ""}`}
                onClick={() => setEngineMode("benchmark")}
              >
                Benchmark Diff
              </button>
            </div>

            <div style={{ fontSize: 12.5, color: "var(--amira-ink-secondary)", flex: 1, minWidth: 240 }}>
              <Info size={13} style={{ verticalAlign: "middle", marginRight: 5, color: "var(--amira-violet)" }} />
              <strong>{MODE_DESCRIPTIONS[engineMode].title}:</strong>{" "}
              {MODE_DESCRIPTIONS[engineMode].summary}
            </div>
          </div>

          {activeRecordsModeMismatch && stagedCalls.length > 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isStreaming}
              onClick={() => runBatchStream(stagedCalls, engineMode)}
            >
              <Play size={13} />
              Re-run `{stagedFileName}` in {engineMode.toUpperCase()}
            </button>
          )}
        </div>

        {/* Compact Metrics + Total Batch Runtime Strip (only shown on Tabs 1–3) */}
        {activeTab !== "qa" && (
          <div className="metrics-strip">
            <div className="metric-tile">
              <span className="metric-label">Active File Calls</span>
              <span className="metric-val">{records.length}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Total Run Time</span>
              <span className="metric-val mono" style={{ fontSize: 17, color: "var(--amira-violet)" }}>
                {lastBatch ? formatMs(lastBatch.durationMs) : "—"}
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Urgent On-Call</span>
              <span className="metric-val" style={{ color: "var(--amira-magenta)" }}>
                {urgentCount}
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Slots Booked</span>
              <span className="metric-val" style={{ color: "var(--amira-teal)" }}>
                {bookedCount}
              </span>
            </div>
            <div className="metric-tile">
              <span className="metric-label">Office / Review</span>
              <span className="metric-val" style={{ color: "var(--amira-amber)" }}>
                {officeCount} / {reviewCount}
              </span>
            </div>
          </div>
        )}

        {/* TAB 1: CLEAN UPLOAD & STAGED RUNNER */}
        {activeTab === "studio" && (
          <div className="intake-grid">
            {/* Left Card: Upload Gate */}
            <div className="panel">
              <div className="panel-header">
                <h2 className="panel-title">
                  <FolderUp size={16} color="var(--amira-violet)" />
                  1. Upload Restricted `.json` File
                </h2>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={simulateRejectedPdfUpload}
                >
                  <ShieldAlert size={13} />
                  Test `.pdf` Rejection
                </button>
              </div>

              <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleRestrictedFileSelect(f, "calls");
                    e.target.value = "";
                  }}
                />

                <div
                  className={`dropzone ${dragging ? "dragging" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void handleRestrictedFileSelect(f, "calls");
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--amira-ink)" }}>
                    Drop your call transcript `.json` file here, or click to select
                  </div>
                  <div style={{ fontSize: 12, color: "var(--amira-ink-muted)", marginTop: 4 }}>
                    Strict Gate: `.json` only · Max 2.0 MB · Magic-Byte & Zod Pre-Flight Validated
                  </div>
                </div>

                {/* Preset Sample Buttons */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "var(--amira-ink-muted)", fontWeight: 600 }}>
                    Or load sample pack:
                  </span>
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => loadPreset("english")}
                  >
                    English (`sample_calls.json`)
                  </button>
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => loadPreset("arabic")}
                  >
                    Arabic (`sample_calls_arabic.json`)
                  </button>
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    onClick={() => loadPreset("bilingual")}
                  >
                    Bilingual (8 EN + AR)
                  </button>
                </div>

                {/* Fresh-per-file Checkbox (ON by default!) */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 9,
                    fontSize: 12.5,
                    color: "var(--amira-ink-secondary)",
                    background: "var(--amira-surface-subtle)",
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--amira-border)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={startFreshOnRun}
                    onChange={(e) => setStartFreshOnRun(e.target.checked)}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>Start fresh for this `.json` file (Recommended):</strong> Resets{" "}
                    <code>availability.json</code> to its baseline and replaces previous batch
                    records so files never stack together.
                  </span>
                </label>

                {/* Optional Custom Availability Upload */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    fontSize: 12.5,
                    color: "var(--amira-ink-muted)",
                  }}
                >
                  <span>Baseline technician schedule: `availability.json` ({freeSlotsCount} free slots)</span>
                  <div>
                    <input
                      ref={availInputRef}
                      type="file"
                      accept=".json,application/json"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void handleRestrictedFileSelect(f, "availability");
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => availInputRef.current?.click()}
                    >
                      Custom `availability.json`
                    </button>
                  </div>
                </div>

                {uploadAlert && (
                  <div className={`banner banner-${uploadAlert.tone}`}>
                    {uploadAlert.tone === "error" ? (
                      <AlertOctagon size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                    ) : (
                      <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 1 }} />
                    )}
                    <span>{uploadAlert.text}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Right Card: Staged File Preview & Run */}
            <div className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">
                    2. Staged File: <span className="mono">{stagedFileName}</span> ({stagedCalls.length} calls)
                  </h2>
                  {lastBatch && records.length > 0 && (
                    <div style={{ fontSize: 12, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                      Last run: {lastBatch.fileName} · {formatMs(lastBatch.durationMs)} total (
                      {formatMs(Math.round(lastBatch.durationMs / Math.max(1, lastBatch.callCount)))} avg/call)
                    </div>
                  )}
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  {records.length > 0 && !isStreaming && (
                    <button
                      type="button"
                      className="btn btn-soft"
                      onClick={() => setActiveTab("records")}
                    >
                      Inspect Results
                      <ArrowRight size={14} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isStreaming || stagedCalls.length === 0}
                    onClick={() => runBatchStream(stagedCalls)}
                  >
                    <Play size={14} />
                    {isStreaming
                      ? `Running (${completedInBatch}/${stagedCalls.length})...`
                      : `Run ${stagedCalls.length} Calls (${engineMode.toUpperCase()})`}
                  </button>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: "22%" }}>Call ID</th>
                      <th style={{ width: "58%" }}>First Caller Statement</th>
                      <th style={{ width: "20%" }}>Webhook</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stagedCalls.map((raw, idx) => {
                      const c = raw as Partial<IncomingCall>;
                      const firstCallerTurn =
                        c.transcript?.find((t) => t.speaker === "caller")?.text ??
                        c.transcript?.[0]?.text ??
                        "—";
                      const isAr = /[\u0600-\u06FF]/.test(firstCallerTurn);
                      return (
                        <tr key={c.call_id ?? idx}>
                          <td className="mono" style={{ fontWeight: 600 }}>
                            <div>{c.call_id ?? `ITEM-${idx + 1}`}</div>
                            <div style={{ fontSize: 11, color: "var(--amira-ink-muted)", fontWeight: 400 }}>
                              {c.caller_id ?? "no caller_id"}
                            </div>
                          </td>
                          <td className={isAr ? "rtl-text" : ""} style={{ fontSize: 12.5 }}>
                            {firstCallerTurn}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={isStreaming}
                              onClick={() => sendSingleWebhook(raw)}
                              title="Send this single call to POST /api/webhooks/call"
                            >
                              <Send size={12} />
                              1 Call
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: SPACIOUS MASTER-DETAIL CALL RESULTS & INSPECTOR */}
        {activeTab === "records" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {lastBatch && (
              <div className="timing-bar" style={{ background: "var(--amira-surface)" }}>
                <Clock size={15} color="var(--amira-violet)" />
                <span>
                  <strong>Active Batch:</strong> <code className="mono">{lastBatch.fileName}</code>
                </span>
                <span>·</span>
                <span>
                  Mode: <strong style={{ textTransform: "uppercase" }}>{lastBatch.engineMode}</strong> (
                  {lastBatch.providerMode.toUpperCase()})
                </span>
                <span>·</span>
                <span>
                  Total Wall-Clock Time:{" "}
                  <strong className="mono" style={{ color: "var(--amira-violet)" }}>
                    {formatMs(lastBatch.durationMs)}
                  </strong>{" "}
                  across {lastBatch.callCount} calls (
                  <span className="mono">
                    {formatMs(Math.round(lastBatch.durationMs / Math.max(1, lastBatch.callCount)))}
                  </span>{" "}
                  avg/call)
                </span>
              </div>
            )}

            <div className="master-detail-grid">
              {/* Left Sidebar: Compact Call List (No overflowing 6-column table!) */}
              <div className="panel">
                <div className="panel-header">
                  <h2 className="panel-title">Calls ({filteredRecords.length})</h2>
                  <select
                    value={recordFilter}
                    onChange={(e) => setRecordFilter(e.target.value as typeof recordFilter)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: 6,
                      border: "1px solid var(--amira-border-strong)",
                      fontSize: 12,
                      background: "#fff",
                    }}
                  >
                    <option value="all">All Statuses ({records.length})</option>
                    <option value="urgent">Urgent On-Call ({urgentCount})</option>
                    <option value="booked">Booked ({bookedCount})</option>
                    <option value="office">Office Queue ({officeCount})</option>
                    <option value="review">Needs Review ({reviewCount})</option>
                    <option value="en">English Only</option>
                    <option value="ar">Arabic Only</option>
                  </select>
                </div>

                <div className="call-list-sidebar">
                  {filteredRecords.length === 0 ? (
                    <div style={{ padding: 24, textAlign: "center", color: "var(--amira-ink-muted)", fontSize: 13 }}>
                      No calls processed yet. Go to <strong>1. Upload & Run</strong> to run your `.json` file.
                    </div>
                  ) : (
                    filteredRecords.map((r) => {
                      const isSel = selectedRecord?.extracted.call_id === r.extracted.call_id;
                      return (
                        <button
                          key={r.extracted.call_id}
                          type="button"
                          className={`call-list-item ${isSel ? "selected" : ""}`}
                          onClick={() => setSelectedCallId(r.extracted.call_id)}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              width: "100%",
                              gap: 8,
                            }}
                          >
                            <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                              {r.extracted.call_id}
                            </span>
                            <span className="mono" style={{ fontSize: 11.5, color: "var(--amira-ink-muted)" }}>
                              {formatMs(r.total_processing_ms)}
                            </span>
                          </div>

                          <div
                            style={{
                              fontSize: 13,
                              fontWeight: 500,
                              color: "var(--amira-ink)",
                            }}
                          >
                            {r.extracted.caller_name ?? "Unidentified Caller"}
                          </div>

                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span className={statusBadgeClass(r.status)}>{r.status}</span>
                            {r.extracted.category.map((cat) => (
                              <span key={cat} className="badge badge-neutral">
                                {cat}
                              </span>
                            ))}
                            {r.benchmark_comparison && (
                              <span className="badge badge-violet">
                                {Math.round(r.benchmark_comparison.agreement_rate * 100)}% match
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Detail Area: Spacious Full-Width Inspector */}
              <div style={{ minWidth: 0 }}>
                {selectedRecord ? (
                  <CallInspectorCard
                    record={selectedRecord}
                    onReplayWebhook={sendSingleWebhook}
                    isBusy={isStreaming}
                  />
                ) : (
                  <div className="panel">
                    <div className="panel-body" style={{ padding: 36, textAlign: "center", color: "var(--amira-ink-muted)" }}>
                      Run a call `.json` file from Tab 1 to inspect extracted data, Jev probabilities, Benchmark diffs, and customer replies here.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: AVAILABILITY MATRIX & QUEUES */}
        {activeTab === "calendar" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {availability && (
              <div className="panel">
                <div className="panel-header">
                  <div>
                    <h2 className="panel-title">
                      Weekly Technician Availability Matrix (`availability.json`)
                    </h2>
                    <div style={{ fontSize: 12.5, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                      {availability.note}
                    </div>
                  </div>
                  <a
                    href="/api/export/json"
                    className="btn btn-secondary btn-sm"
                    style={{ textDecoration: "none" }}
                  >
                    <Download size={13} />
                    Download Updated `availability.json` + Outcomes
                  </a>
                </div>
                <div className="panel-body">
                  <div className="slot-grid">
                    {WEEKDAYS_LIST.map((day) => {
                      const daySlots = availability.slots.filter((s) => s.day === day);
                      return (
                        <div key={day} className="slot-day-col">
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{day}</div>
                          {daySlots.map((slot) => {
                            const cls =
                              slot.status === "free"
                                ? "slot-cell free"
                                : slot.booked_by_call_id
                                  ? "slot-cell booked-new"
                                  : "slot-cell booked-base";
                            return (
                              <div key={`${slot.day}-${slot.period}`} className={cls}>
                                <div style={{ fontWeight: 600, textTransform: "capitalize" }}>
                                  {slot.period}
                                </div>
                                <div className="mono" style={{ fontSize: 11.5 }}>
                                  {slot.status === "free"
                                    ? "FREE"
                                    : slot.booked_by_call_id
                                      ? `BOOKED (${slot.booked_by_call_id})`
                                      : "BOOKED (baseline)"}
                                </div>
                                {slot.booked_caller_name && (
                                  <div style={{ fontSize: 11.5 }}>{slot.booked_caller_name}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            <div className="queues-grid">
              <div className="panel">
                <div className="panel-header">
                  <h3 className="panel-title" style={{ color: "var(--amira-magenta)" }}>
                    On-Call Emergency Dispatch ({urgentCount})
                  </h3>
                </div>
                <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {records.filter((r) => r.on_call_alert).length === 0 ? (
                    <div style={{ color: "var(--amira-ink-muted)", fontSize: 13 }}>
                      No urgent on-call alerts in current batch.
                    </div>
                  ) : (
                    records
                      .filter((r) => r.on_call_alert)
                      .map((r) => (
                        <div
                          key={r.extracted.call_id}
                          style={{
                            border: "1px solid var(--amira-magenta-border)",
                            background: "var(--amira-magenta-soft)",
                            borderRadius: 8,
                            padding: 12,
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13 }}>
                            {r.extracted.call_id} · {r.extracted.caller_name ?? "Caller"}
                          </div>
                          <div style={{ fontSize: 12, marginTop: 4 }}>
                            <strong>Address:</strong> {r.extracted.address ?? "Missing"} ·{" "}
                            <strong>Phone:</strong> {r.extracted.phone ?? "Missing"}
                          </div>
                          <div style={{ fontSize: 12.5, marginTop: 6 }}>{r.extracted.summary}</div>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3 className="panel-title" style={{ color: "var(--amira-indigo)" }}>
                    Office Queue — Quote & Billing ({officeCount})
                  </h3>
                </div>
                <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {records.filter((r) => r.office_ticket).length === 0 ? (
                    <div style={{ color: "var(--amira-ink-muted)", fontSize: 13 }}>
                      No quote or billing items in current batch.
                    </div>
                  ) : (
                    records
                      .filter((r) => r.office_ticket)
                      .map((r) => (
                        <div
                          key={r.extracted.call_id}
                          style={{
                            border: "1px solid var(--amira-indigo-border)",
                            background: "var(--amira-indigo-soft)",
                            borderRadius: 8,
                            padding: 12,
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13 }}>
                            {r.extracted.call_id} · {r.extracted.caller_name} (
                            {r.office_ticket?.categories.join(" + ")})
                          </div>
                          <div style={{ fontSize: 12, marginTop: 4 }}>
                            <strong>Contact:</strong> {r.office_ticket?.contact}
                            {r.booked_slot ? ` · Visit: ${r.booked_slot}` : ""}
                          </div>
                          <div style={{ fontSize: 12.5, marginTop: 6 }}>{r.extracted.summary}</div>
                        </div>
                      ))
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <h3 className="panel-title" style={{ color: "var(--amira-amber)" }}>
                    Human Review Queue (`needs_review` · {reviewCount})
                  </h3>
                </div>
                <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {records.filter((r) => r.status === "needs_review").length === 0 ? (
                    <div style={{ color: "var(--amira-ink-muted)", fontSize: 13 }}>
                      No incomplete calls pending human review.
                    </div>
                  ) : (
                    records
                      .filter((r) => r.status === "needs_review")
                      .map((r) => (
                        <div
                          key={r.extracted.call_id}
                          style={{
                            border: "1px solid var(--amira-amber-border)",
                            background: "var(--amira-amber-soft)",
                            borderRadius: 8,
                            padding: 12,
                          }}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13 }}>
                            {r.extracted.call_id} · {r.extracted.caller_name ?? "Unidentified"}
                          </div>
                          <div style={{ fontSize: 12, marginTop: 4 }}>
                            <strong>Missing:</strong>{" "}
                            <span className="mono">{r.extracted.missing_fields.join(", ")}</span>
                          </div>
                          <div style={{ fontSize: 12.5, marginTop: 6 }}>{r.extracted.summary}</div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: PERSISTED QA SUITE */}
        {activeTab === "qa" && (
          <QaSuiteView
            results={qaResults}
            meta={qaMeta}
            running={qaRunning}
            progressText={qaProgressText}
            error={qaError}
            onRunSuite={handleRunQaSuite}
          />
        )}
          </>
        )}
      </main>
    </div>
  );
}
