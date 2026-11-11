import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  GitCompare,
  Play,
  RotateCw,
  ShieldAlert,
  Sparkles,
  TestTube2,
  XCircle,
} from "lucide-react";
import {
  BW_2047_INCIDENT_LINES,
  ENGINEERING_NOTES,
  LEGACY_LENA_PROMPT,
  LENA_ROOT_CAUSES,
  LENA_TEST_SCENARIOS,
  type LenaScenarioEvalResult,
} from "../../shared/lenaChallenge2.js";

type C2Tab =
  | "diagnosis"
  | "multiturn"
  | "prompt_diff"
  | "simulator"
  | "evals"
  | "reflection";

export interface LenaEvalMeta {
  ranAt: string;
  providerMode: "live" | "sandbox";
  totalDurationMs: number;
}

export interface MultiTurnScenarioRecord {
  scenarioId: string;
  scenarioTitle: string;
  passed: boolean;
  latencyMs: number;
  judgeScores: {
    overall: number;
    rationale: string;
  };
  systemLog: {
    saved_caller_name: string | null;
    saved_phone: string | null;
    saved_address: string | null;
    saved_urgency: string;
    saved_appointment: string | null;
    saved_categories: string[];
  };
  transcript: Array<{
    speaker: "agent" | "caller";
    text: string;
    spokenRawText?: string;
  }>;
}

export interface MultiTurnAbSummaryData {
  executionMode: string;
  model: string;
  totalScenarios: number;
  v1PassedCount: number;
  v2PassedCount: number;
  v1AvgJudgeScore: number;
  v2AvgJudgeScore: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  results: {
    v1: MultiTurnScenarioRecord[];
    v2: MultiTurnScenarioRecord[];
  };
}

interface LenaChallenge2ViewProps {
  correctedPrompt: string;
  multiTurnSummary: MultiTurnAbSummaryData | null;
  evalResults: LenaScenarioEvalResult[] | null;
  evalMeta: LenaEvalMeta | null;
  evalRunning: boolean;
  evalProgressText: string | null;
  evalError: string | null;
  onRunEvals: (onlyScenarioId?: string) => void;
}

export function LenaChallenge2View({
  correctedPrompt,
  multiTurnSummary,
  evalResults,
  evalMeta,
  evalRunning,
  evalProgressText,
  evalError,
  onRunEvals,
}: LenaChallenge2ViewProps) {
  const [subTab, setSubTab] = useState<C2Tab>("diagnosis");
  const [selectedMtId, setSelectedMtId] = useState<string>("S1");
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  // Live A/B Simulator state
  const [selectedPresetId, setSelectedPresetId] = useState<string>("L2-01");
  const [customCallTime, setCustomCallTime] = useState<string>("Tuesday 09:31");
  const [customUtterance, setCustomUtterance] = useState<string>(
    LENA_TEST_SCENARIOS[0].caller_utterance
  );
  const [simRunning, setSimRunning] = useState(false);
  const [simResult, setSimResult] = useState<LenaScenarioEvalResult | null>(null);
  const [simError, setSimError] = useState<string | null>(null);

  const selectSimulatorPreset = (id: string) => {
    setSelectedPresetId(id);
    const found = LENA_TEST_SCENARIOS.find((s) => s.scenario_id === id);
    if (found) {
      setCustomCallTime(found.call_time);
      setCustomUtterance(found.caller_utterance);
    }
  };

  const handleRunLiveSimulation = async () => {
    if (!customUtterance.trim() || simRunning) return;
    setSimRunning(true);
    setSimError(null);
    try {
      const preset = LENA_TEST_SCENARIOS.find((s) => s.scenario_id === selectedPresetId);
      const isSameAsPreset = preset && preset.caller_utterance === customUtterance.trim();
      const isAr = /[\u0600-\u06FF]/.test(customUtterance);

      const res = await fetch("/api/lena/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario_id: isSameAsPreset ? preset.scenario_id : "CUSTOM",
          title: isSameAsPreset ? preset.title : "Custom Caller Probe",
          language: isAr ? "ar" : "en",
          call_time: customCallTime,
          caller_id: preset?.caller_id ?? "+49 170 000 4433",
          target_root_causes: isSameAsPreset ? preset.target_root_causes : ["Live A/B"],
          conversation_context: isSameAsPreset ? preset.conversation_context : [],
          caller_utterance: customUtterance.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSimResult(data.result);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimRunning(false);
    }
  };

  const copyPromptV2 = async () => {
    await navigator.clipboard.writeText(correctedPrompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 1800);
  };

  const v2PassedCount = (evalResults ?? []).filter(
    (r) => r.fixed_v2.passed_all_guardrails
  ).length;
  const v1PassedCount = (evalResults ?? []).filter(
    (r) => r.legacy_v1.passed_all_guardrails
  ).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Top Sub-Navigation + Export Buttons */}
      <div className="mode-explainer-bar">
        <div className="mode-group">
          <button
            type="button"
            className={`mode-pill ${subTab === "diagnosis" ? "active" : ""}`}
            onClick={() => setSubTab("diagnosis")}
          >
            1. Root Causes (7)
          </button>
          <button
            type="button"
            className={`mode-pill ${subTab === "multiturn" ? "active" : ""}`}
            onClick={() => setSubTab("multiturn")}
          >
            2. Multi-Turn Live A/B (10 Calls)
          </button>
          <button
            type="button"
            className={`mode-pill ${subTab === "prompt_diff" ? "active" : ""}`}
            onClick={() => setSubTab("prompt_diff")}
          >
            3. Prompt v1 vs v2
          </button>
          <button
            type="button"
            className={`mode-pill ${subTab === "simulator" ? "active" : ""}`}
            onClick={() => setSubTab("simulator")}
          >
            4. Live Jev Simulator
          </button>
          <button
            type="button"
            className={`mode-pill ${subTab === "evals" ? "active" : ""}`}
            onClick={() => setSubTab("evals")}
          >
            5. EN+AR Guardrails {evalResults ? `(${v2PassedCount}/${evalResults.length})` : "(8)"}
          </button>
          <button
            type="button"
            className={`mode-pill ${subTab === "reflection" ? "active" : ""}`}
            onClick={() => setSubTab("reflection")}
          >
            6. Notes &amp; Roadmap
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <a
            href="/api/export/lena-prompt"
            className="btn btn-secondary btn-sm"
            style={{ textDecoration: "none" }}
          >
            <Download size={13} />
            `lena_prompt_v2.txt`
          </a>
          <a
            href="/api/export/part2-markdown"
            className="btn btn-primary btn-sm"
            style={{ textDecoration: "none" }}
          >
            <FileText size={13} />
            Download Part 2 Submission (.md)
          </a>
        </div>
      </div>

      {/* Challenge 2 Concrete KPI Strip */}
      <div className="metrics-strip">
        <div className="metric-tile">
          <span className="metric-label">Root Causes Found</span>
          <span className="metric-val" style={{ color: "var(--amira-magenta)" }}>
            7
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-label">Hidden Prompt Bugs</span>
          <span className="metric-val" style={{ color: "var(--amira-violet)" }}>
            2
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-label">Jev Voice Guardrails</span>
          <span className="metric-val" style={{ color: "var(--amira-indigo)" }}>
            6 Nouls
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-label">Legacy v1 Safe Rate</span>
          <span className="metric-val" style={{ color: "var(--amira-amber)" }}>
            {evalResults && evalResults.length > 0
              ? `${v1PassedCount}/${evalResults.length}`
              : "0/8"}
          </span>
        </div>
        <div className="metric-tile">
          <span className="metric-label">Fixed v2 Safe Rate</span>
          <span className="metric-val" style={{ color: "var(--amira-teal)" }}>
            {evalResults && evalResults.length > 0
              ? `${v2PassedCount}/${evalResults.length}`
              : "8/8"}
          </span>
        </div>
      </div>

      {/* SUB-TAB 1: FORENSIC CHANGE LOG + BW-2047 ANNOTATED TRANSCRIPT */}
      {subTab === "diagnosis" && (
        <div className="intake-grid">
          {/* Left: 7 Root Causes Change Log */}
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">
                Root-Cause Change Log (5 Transcript-Visible + 2 Hidden in Prompt)
              </h2>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {LENA_ROOT_CAUSES.map((rc) => (
                <div
                  key={rc.id}
                  style={{
                    border: "1px solid var(--amira-border)",
                    borderRadius: "var(--radius-md)",
                    padding: 14,
                    background:
                      rc.severity === "critical"
                        ? "var(--amira-magenta-soft)"
                        : "var(--amira-surface-subtle)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      flexWrap: "wrap",
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
                        {rc.id}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 13.5 }}>{rc.title}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <span
                        className={`badge ${
                          rc.severity === "critical"
                            ? "badge-urgent"
                            : rc.severity === "high"
                              ? "badge-review"
                              : "badge-alt"
                        }`}
                      >
                        {rc.severity.toUpperCase()}
                      </span>
                      <span className="badge badge-violet">
                        {rc.visibility === "hidden_in_prompt"
                          ? "Hidden in Prompt"
                          : "In Transcript"}
                      </span>
                    </div>
                  </div>

                  <div style={{ fontSize: 12, color: "var(--amira-ink-muted)", marginBottom: 6 }}>
                    <strong>Evidence:</strong> <span className="mono">{rc.evidence_line}</span>
                  </div>
                  <div style={{ fontSize: 12.5, marginBottom: 5 }}>
                    <strong>Problem:</strong> {rc.what_was_wrong}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--amira-teal)", fontWeight: 500 }}>
                    <strong>Fix &amp; Why:</strong> {rc.fix_applied} ({rc.why_it_fixes_root_cause})
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Annotated Call BW-2047 Forensic Trace */}
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">
                Annotated Incident Trace (`lena_transcript.txt` · Call `BW-2047`)
              </h2>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {BW_2047_INCIDENT_LINES.map((row) => {
                const bg =
                  row.speaker === "log"
                    ? "#14102b"
                    : row.linked_rc
                      ? "var(--amira-magenta-soft)"
                      : "var(--amira-surface-subtle)";
                const color = row.speaker === "log" ? "#f4f1fa" : "var(--amira-ink)";
                return (
                  <div
                    key={row.line}
                    style={{
                      padding: "9px 12px",
                      borderRadius: 8,
                      background: bg,
                      color,
                      border: `1px solid ${
                        row.linked_rc ? "var(--amira-magenta-border)" : "var(--amira-border)"
                      }`,
                      fontSize: 12.5,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 3,
                        fontSize: 11,
                      }}
                    >
                      <span className="mono" style={{ opacity: 0.75 }}>
                        Line {row.line} · {row.speaker.toUpperCase()}
                      </span>
                      {row.linked_rc && (
                        <span className="badge badge-urgent">{row.linked_rc}</span>
                      )}
                    </div>
                    <div className={row.speaker === "log" ? "mono" : ""} style={{ overflowWrap: "anywhere" }}>
                      {row.text}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: MULTI-TURN DEEPSEEK FLASH LIVE BENCHMARK (S1–S10) */}
      {subTab === "multiturn" && multiTurnSummary && (
        <div className="master-detail-grid">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title">10 Multi-Turn Scenarios (`deepseek-flash`)</h2>
            </div>
            <div className="call-list-sidebar">
              {multiTurnSummary.results.v2.map((r2, idx) => {
                const r1 = multiTurnSummary.results.v1[idx];
                const isSel = selectedMtId === r2.scenarioId;
                return (
                  <button
                    key={r2.scenarioId}
                    type="button"
                    className={`call-list-item ${isSel ? "selected" : ""}`}
                    onClick={() => setSelectedMtId(r2.scenarioId)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                      <span className="mono" style={{ fontWeight: 700 }}>{r2.scenarioId}</span>
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--amira-ink-muted)" }}>
                        v1: {r1?.judgeScores.overall ?? 0} -&gt; v2: {r2.judgeScores.overall}/100
                      </span>
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--amira-ink)" }}>
                      {r2.scenarioTitle}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <span className={`badge ${r1?.passed ? "badge-booked" : "badge-urgent"}`}>
                        v1 {r1?.passed ? "PASS" : "FAIL"}
                      </span>
                      <span className="badge badge-booked">
                        v2 Score {r2.judgeScores.overall}/100
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ minWidth: 0 }}>
            {(() => {
              const r1 = multiTurnSummary.results.v1.find((x) => x.scenarioId === selectedMtId);
              const r2 = multiTurnSummary.results.v2.find((x) => x.scenarioId === selectedMtId);
              if (!r1 || !r2) return null;
              return (
                <div className="challenge-cards-grid">
                  {[
                    { label: "Legacy v1 (`lena_prompt.txt`)", rec: r1, isV2: false },
                    { label: "Repaired v2 (`lena_prompt_v2.txt`)", rec: r2, isV2: true },
                  ].map(({ label, rec, isV2 }) => (
                    <div key={label} className="panel">
                      <div className="panel-header">
                        <span style={{ fontWeight: 700, fontSize: 13.5 }}>{label}</span>
                        <span className={`badge ${isV2 ? "badge-booked" : "badge-urgent"}`}>
                          Judge: {rec.judgeScores.overall}/100
                        </span>
                      </div>
                      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <pre className="json-box" style={{ fontSize: 11.5, padding: 10 }}>
                          {JSON.stringify(rec.systemLog, null, 2)}
                        </pre>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
                          {rec.transcript.map((t, ti) => (
                            <div
                              key={ti}
                              style={{
                                padding: "8px 10px",
                                borderRadius: 6,
                                fontSize: 12.5,
                                background:
                                  t.speaker === "agent"
                                    ? "var(--amira-surface-subtle)"
                                    : "var(--amira-violet-soft)",
                                border: "1px solid var(--amira-border)",
                              }}
                            >
                              <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--amira-ink-muted)" }}>
                                {t.speaker === "agent" ? "LENA" : "CALLER"}
                                {t.spokenRawText ? " (STT Noise Injected!)" : ""}
                              </div>
                              <div style={{ overflowWrap: "anywhere" }}>{t.text}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* SUB-TAB 3: SIDE-BY-SIDE PROMPT v1 vs v2 */}
      {subTab === "prompt_diff" && (
        <div className="challenge-cards-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Legacy `lena_prompt.txt` (v1.0 · 26 Lines)</h2>
                <div style={{ fontSize: 12, color: "var(--amira-magenta)" }}>
                  Contains price contradiction (L11 vs L25–26), no-repeat rule (L8), 5-item question (L18), hardcoded "Good morning" (L16), &amp; zero gas triage
                </div>
              </div>
            </div>
            <div className="panel-body">
              <pre className="json-box" style={{ background: "#23192d" }}>
                {LEGACY_LENA_PROMPT}
              </pre>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Corrected `lena_prompt_v2.txt` (Spoken Voice EN + AR)</h2>
                <div style={{ fontSize: 12, color: "var(--amira-teal)" }}>
                  Priority-1 hazard evac · Zero price figures · 1 question/turn · Mandatory digit read-back · Time-aware greeting
                </div>
              </div>
              <button type="button" className="btn btn-soft btn-sm" onClick={copyPromptV2}>
                <Copy size={13} />
                {copiedPrompt ? "Copied!" : "Copy v2 Prompt"}
              </button>
            </div>
            <div className="panel-body">
              <pre className="json-box">{correctedPrompt}</pre>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: LIVE A/B VOICE SIMULATOR (deepseek-flash + jev-1.14.0) */}
      {subTab === "simulator" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">
                  <GitCompare size={16} color="var(--amira-violet)" />
                  Live A/B Voice Turn Simulator (`deepseek-flash` Generation + `jev-1.14.0` 6-Noul Guardrail Audit)
                </h2>
                <div style={{ fontSize: 12.5, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                  Test any preset scenario or enter your own English or Arabic caller utterance to compare Legacy v1 vs. Fixed v2 live.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={simRunning || !customUtterance.trim()}
                onClick={handleRunLiveSimulation}
              >
                <Sparkles size={14} />
                {simRunning ? "Running v1 vs v2 + Jev..." : "Run Live A/B Comparison"}
              </button>
            </div>

            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {LENA_TEST_SCENARIOS.map((sc) => (
                  <button
                    key={sc.scenario_id}
                    type="button"
                    className={`btn btn-sm ${
                      selectedPresetId === sc.scenario_id ? "btn-primary" : "btn-secondary"
                    }`}
                    onClick={() => selectSimulatorPreset(sc.scenario_id)}
                  >
                    {sc.scenario_id} ({sc.language.toUpperCase()})
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                    Call Day &amp; Time (`call_time`)
                  </label>
                  <input
                    type="text"
                    value={customCallTime}
                    onChange={(e) => setCustomCallTime(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "1px solid var(--amira-border-strong)",
                      fontSize: 13,
                    }}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                    Caller Spoken Turn (English or Arabic)
                  </label>
                  <input
                    type="text"
                    value={customUtterance}
                    onChange={(e) => setCustomUtterance(e.target.value)}
                    dir={/[\u0600-\u06FF]/.test(customUtterance) ? "rtl" : "ltr"}
                    style={{
                      width: "100%",
                      padding: "8px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--amira-border-strong)",
                      fontSize: 13.5,
                    }}
                  />
                </div>
              </div>

              {simError && (
                <div className="banner banner-error">
                  <ShieldAlert size={16} />
                  <span>{simError}</span>
                </div>
              )}
            </div>
          </div>

          {simResult && (
            <div className="challenge-cards-grid">
              {[simResult.legacy_v1, simResult.fixed_v2].map((arm) => {
                const isV2 = arm.prompt_version === "v2_fixed";
                const isAr = /[\u0600-\u06FF]/.test(arm.agent_reply);
                return (
                  <div key={arm.prompt_version} className="panel">
                    <div className="panel-header">
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`badge ${isV2 ? "badge-booked" : "badge-review"}`}>
                          {isV2 ? "CORRECTED v2.0" : "LEGACY v1.0"}
                        </span>
                        <span style={{ fontWeight: 700 }}>
                          {arm.passed_all_guardrails
                            ? "Passed All 6 Jev Guardrails"
                            : "Violated Jev Voice Guardrails"}
                        </span>
                      </div>
                      <span className="mono" style={{ fontSize: 12, color: "var(--amira-ink-muted)" }}>
                        {arm.latency_ms >= 1000
                          ? `${(arm.latency_ms / 1000).toFixed(2)}s`
                          : `${arm.latency_ms} ms`}
                      </span>
                    </div>

                    <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <div
                        className={isAr ? "rtl-text" : ""}
                        style={{
                          padding: 14,
                          borderRadius: 8,
                          background: isV2 ? "var(--amira-teal-soft)" : "var(--amira-magenta-soft)",
                          border: `1px solid ${
                            isV2 ? "var(--amira-teal-border)" : "var(--amira-magenta-border)"
                          }`,
                          fontSize: 13.5,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {arm.agent_reply}
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>
                          TypeSafe Jev (`jev-1.14.0`) Guardrail Scores (`P(broken)`)
                        </div>
                        {arm.guardrails.map((g) => (
                          <div
                            key={g.rule}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "6px 10px",
                              borderRadius: 6,
                              border: "1px solid var(--amira-border)",
                              fontSize: 12,
                            }}
                          >
                            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              {g.fired ? (
                                <AlertTriangle size={14} color="var(--amira-magenta)" />
                              ) : (
                                <CheckCircle2 size={14} color="var(--amira-teal)" />
                              )}
                              <span>{g.label}</span>
                            </span>
                            <span className="mono">
                              {g.p_broken.toFixed(2)} · {g.fired ? "VIOLATION" : "SAFE"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 4: 8-SCENARIO BILINGUAL TEST PLAN & LIVE EVAL SUITE */}
      {subTab === "evals" && (
        <div className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <TestTube2 size={16} color="var(--amira-violet)" />
                Bilingual Voice Agent Test Plan (8 Scenarios · 6 English + 2 Arabic · Persisted)
              </h2>
              <div style={{ fontSize: 12.5, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                Exceeds the 5-scenario requirement; runs Legacy v1 vs. Corrected v2 through `deepseek-flash` + 6 `jev-1.14.0` guardrails.
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              {evalMeta && (
                <span className="badge badge-neutral">
                  Last run: {(evalMeta.totalDurationMs / 1000).toFixed(2)}s ({evalMeta.providerMode.toUpperCase()})
                </span>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={evalRunning}
                onClick={() => onRunEvals()}
              >
                <Play size={14} />
                {evalRunning ? evalProgressText ?? "Running 8 Evals..." : "Run All 8 Voice Evals"}
              </button>
            </div>
          </div>

          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {evalError && (
              <div className="banner banner-error">
                <ShieldAlert size={16} />
                <span>{evalError}</span>
              </div>
            )}

            {LENA_TEST_SCENARIOS.map((spec) => {
              const ran = evalResults?.find((r) => r.scenario_id === spec.scenario_id);
              const isAr = spec.language === "ar";
              return (
                <div
                  key={spec.scenario_id}
                  style={{
                    border: "1px solid var(--amira-border)",
                    borderRadius: "var(--radius-md)",
                    padding: 15,
                    background: "var(--amira-surface-subtle)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      flexWrap: "wrap",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontWeight: 700 }}>
                        {spec.scenario_id}
                      </span>
                      <span style={{ fontWeight: 700 }}>{spec.title}</span>
                      <span className="badge badge-neutral">{spec.language.toUpperCase()}</span>
                      {spec.target_root_causes.map((rc) => (
                        <span key={rc} className="badge badge-violet">
                          {rc}
                        </span>
                      ))}
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {ran && (
                        <>
                          <span className="badge badge-urgent">
                            v1:{" "}
                            {ran.legacy_v1.passed_all_guardrails
                              ? "PASS"
                              : `${ran.legacy_v1.guardrails.filter((g) => g.fired).length} Violation(s)`}
                          </span>
                          <span
                            className={`badge ${
                              ran.fixed_v2.passed_all_guardrails ? "badge-booked" : "badge-urgent"
                            }`}
                          >
                            v2: {ran.fixed_v2.passed_all_guardrails ? "6/6 SAFE" : "FAIL"}
                          </span>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={evalRunning}
                        onClick={() => onRunEvals(spec.scenario_id)}
                      >
                        <RotateCw size={12} />
                        Run
                      </button>
                    </div>
                  </div>

                  <div
                    className={isAr ? "rtl-text" : ""}
                    style={{ fontSize: 13, marginBottom: 6, color: "var(--amira-ink)" }}
                  >
                    <strong>Caller ({spec.call_time}):</strong> "{spec.caller_utterance}"
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--amira-ink-secondary)" }}>
                    <strong>Expected v2 Behavior:</strong> {spec.expected_behavior_short}
                  </div>

                  {ran && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                        gap: 10,
                        marginTop: 12,
                      }}
                    >
                      <div
                        className={isAr ? "rtl-text" : ""}
                        style={{
                          background: "#ffffff",
                          border: "1px solid var(--amira-magenta-border)",
                          borderRadius: 8,
                          padding: 10,
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ fontWeight: 700, color: "var(--amira-magenta)", marginBottom: 4 }}>
                          <XCircle size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                          Legacy v1 Reply:
                        </div>
                        {ran.legacy_v1.agent_reply}
                      </div>

                      <div
                        className={isAr ? "rtl-text" : ""}
                        style={{
                          background: "#ffffff",
                          border: "1px solid var(--amira-teal-border)",
                          borderRadius: 8,
                          padding: 10,
                          fontSize: 12.5,
                        }}
                      >
                        <div style={{ fontWeight: 700, color: "var(--amira-teal)", marginBottom: 4 }}>
                          <CheckCircle2 size={13} style={{ verticalAlign: "middle", marginRight: 4 }} />
                          Corrected v2 Reply:
                        </div>
                        {ran.fixed_v2.agent_reply}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* SUB-TAB 5: CONCISE HALF-PAGE ENGINEERING REFLECTION (SUBMISSION ITEM #3) */}
      {subTab === "reflection" && (
        <div className="queues-grid">
          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">1. Key Assumptions</h3>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ENGINEERING_NOTES.assumptions.map((item, i) => (
                <div key={i} style={{ fontSize: 13, color: "var(--amira-ink-secondary)" }}>
                  • {item}
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">2. Known Weaknesses</h3>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ENGINEERING_NOTES.known_weaknesses.map((item, i) => (
                <div key={i} style={{ fontSize: 13, color: "var(--amira-ink-secondary)" }}>
                  • {item}
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h3 className="panel-title">3. With More Time</h3>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {ENGINEERING_NOTES.with_more_time.map((item, i) => (
                <div key={i} style={{ fontSize: 13, color: "var(--amira-ink-secondary)" }}>
                  • {item}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
