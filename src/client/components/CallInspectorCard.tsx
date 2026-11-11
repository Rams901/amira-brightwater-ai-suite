import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  GitCompare,
  Languages,
  Mail,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import type { ProcessedCallRecord } from "../../shared/types.js";

interface CallInspectorProps {
  record: ProcessedCallRecord;
  onReplayWebhook: (rawCall: unknown) => void;
  isBusy: boolean;
}

function formatDuration(ms: number | undefined | null): string {
  if (!ms || ms <= 0) return "0 ms";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function CallInspectorCard({
  record,
  onReplayWebhook,
  isBusy,
}: CallInspectorProps) {
  const [subTab, setSubTab] = useState<"extracted" | "jev" | "transcript">("extracted");
  const [showEnglishMirror, setShowEnglishMirror] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyExtractedJson = async () => {
    await navigator.clipboard.writeText(JSON.stringify(record.extracted, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const rawTranscript =
    record.raw_call &&
    typeof record.raw_call === "object" &&
    Array.isArray((record.raw_call as { transcript?: unknown[] }).transcript)
      ? (record.raw_call as { transcript: Array<{ speaker: string; text: string }> }).transcript
      : [];

  const jevMs = record.jev_telemetry?.latency_ms ?? 0;
  const dsExtMs = record.deepseek_telemetry?.extraction_latency_ms ?? 0;
  const dsReplyMs = record.deepseek_telemetry?.reply_latency_ms ?? 0;
  const totalCallMs =
    record.total_processing_ms ??
    (record.engine_mode === "cascade"
      ? jevMs + dsExtMs + dsReplyMs
      : Math.max(jevMs, dsExtMs) + dsReplyMs);

  const bm = record.benchmark_comparison;

  return (
    <div className="panel">
      <div className="panel-header">
        <div style={{ minWidth: 0 }}>
          <h3 className="panel-title">
            <span className="mono">{record.extracted.call_id}</span>
            <span>·</span>
            <span>{record.extracted.caller_name ?? "Unknown Caller"}</span>
            {record.language === "ar" ? (
              <span className="badge badge-violet">AR · العربية</span>
            ) : (
              <span className="badge badge-neutral">EN</span>
            )}
            <span className="badge badge-neutral" style={{ textTransform: "uppercase" }}>
              {record.engine_mode}
            </span>
            {record.idempotent_replay && (
              <span className="badge badge-violet">Idempotent Replay</span>
            )}
          </h3>
          <div style={{ fontSize: 12.5, color: "var(--amira-ink-secondary)", marginTop: 4 }}>
            {record.outcome_headline}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={isBusy}
          onClick={() => onReplayWebhook(record.raw_call)}
          title="Send this call a second time to verify Bonus #2 duplicate replay prevention"
        >
          <RotateCcw size={13} />
          Simulate Webhook Replay
        </button>
      </div>

      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* Per-Call Execution Timing Breakdown */}
        <div className="timing-bar">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, color: "var(--amira-ink)" }}>
            <Clock size={14} color="var(--amira-violet)" />
            Call Processing Time: <span className="mono">{formatDuration(totalCallMs)}</span>
          </span>
          <span>·</span>
          <span>
            Jev (`jev-1.14.0`): <strong className="mono">{formatDuration(jevMs)}</strong>
          </span>
          <span>·</span>
          <span>
            DeepSeek Extract: <strong className="mono">{formatDuration(dsExtMs)}</strong>
          </span>
          <span>·</span>
          <span>
            Reply Draft: <strong className="mono">{dsReplyMs > 0 ? formatDuration(dsReplyMs) : "Skipped"}</strong>
          </span>
          {record.deepseek_telemetry?.cascade_escalated && (
            <>
              <span>·</span>
              <span className="badge badge-urgent">Escalated to DeepSeek Thinking</span>
            </>
          )}
        </div>

        {/* PROMINENT TOP-LEVEL BENCHMARK DIFF VIEW (when engine_mode === 'benchmark') */}
        {bm && (
          <div
            style={{
              border: "1.5px solid var(--amira-violet-border)",
              borderRadius: "var(--radius-md)",
              padding: 16,
              background: "var(--amira-violet-soft)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 700, color: "var(--amira-violet)" }}>
                <GitCompare size={16} />
                <span>Side-by-Side Architecture Benchmark (Hybrid Symphony vs. SDE Cascade)</span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <span className="badge badge-booked">
                  Field Agreement: {Math.round(bm.agreement_rate * 100)}%
                </span>
                <span className="badge badge-neutral">
                  {bm.cascade_escalated
                    ? `Cascade Escalated (${bm.cascade_fired_rules.join(", ")})`
                    : "Cascade Kept Rung 0 (No Rule Fired)"}
                </span>
              </div>
            </div>

            {/* Visual Latency Comparison */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 10,
              }}
            >
              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 8,
                  padding: "10px 12px",
                  border: "1px solid var(--amira-border)",
                }}
              >
                <div style={{ fontSize: 11.5, color: "var(--amira-ink-muted)", fontWeight: 600 }}>
                  HYBRID SYMPHONY (Parallel Jev + DeepSeek)
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }} className="mono">
                  {formatDuration(bm.hybrid_total_ms)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--amira-ink-secondary)" }}>
                  Est. intake cost: ${bm.hybrid_cost_usd.toFixed(6)}
                </div>
              </div>

              <div
                style={{
                  background: "#ffffff",
                  borderRadius: 8,
                  padding: "10px 12px",
                  border: "1px solid var(--amira-border)",
                }}
              >
                <div style={{ fontSize: 11.5, color: "var(--amira-ink-muted)", fontWeight: 600 }}>
                  SDE CASCADE (Sequential Extract -&gt; Verify -&gt; Escalate)
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }} className="mono">
                  {formatDuration(bm.cascade_total_ms)}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--amira-ink-secondary)" }}>
                  Est. intake cost: ${bm.cascade_cost_usd.toFixed(6)}
                </div>
              </div>
            </div>

            <div className="data-table-wrap">
              <table className="data-table" style={{ background: "#ffffff", borderRadius: 8 }}>
                <thead>
                  <tr>
                    <th style={{ width: "24%" }}>Schema Field</th>
                    <th style={{ width: "31%" }}>Hybrid Symphony</th>
                    <th style={{ width: "31%" }}>SDE Cascade</th>
                    <th style={{ width: "14%" }}>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {bm.diffs.map((d) => (
                    <tr key={d.field}>
                      <td className="mono" style={{ fontSize: 12, fontWeight: 600 }}>
                        {d.field}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {d.hybrid_value}
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {d.cascade_value}
                      </td>
                      <td>
                        <span className={`badge ${d.matches ? "badge-booked" : "badge-urgent"}`}>
                          {d.matches ? "Match" : "Diverged"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Customer Reply Draft */}
        <div
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
              marginBottom: 10,
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, fontWeight: 600, fontSize: 13 }}>
              {record.reply_draft?.channel === "email" ? (
                <Mail size={15} color="var(--amira-violet)" />
              ) : (
                <MessageSquare size={15} color="var(--amira-violet)" />
              )}
              <span>
                Customer Reply Draft{" "}
                {record.reply_draft
                  ? `(${record.reply_draft.channel.toUpperCase()} -> ${record.reply_draft.to})`
                  : "(Suppressed — Unreachable)"}
              </span>
            </div>

            {record.reply_draft?.english_mirror && (
              <button
                type="button"
                className="btn btn-soft btn-sm"
                onClick={() => setShowEnglishMirror((v) => !v)}
              >
                <Languages size={13} />
                {showEnglishMirror ? "Show Original Arabic" : "Show English Mirror"}
              </button>
            )}
          </div>

          {!record.reply_draft ? (
            <div className="banner banner-warn">
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>No Reply Drafted:</strong> Caller is unreachable (`phone: null`, `email: null`).
                Status set to `needs_review` per Brightwater routing rules.
              </div>
            </div>
          ) : (
            <div
              style={{
                background: "#ffffff",
                border: "1px solid var(--amira-border)",
                borderRadius: "var(--radius-sm)",
                padding: 14,
              }}
            >
              {record.reply_draft.subject && (
                <div
                  className={record.reply_draft.language === "ar" && !showEnglishMirror ? "rtl-text" : ""}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    paddingBottom: 8,
                    marginBottom: 8,
                    borderBottom: "1px solid var(--amira-border)",
                  }}
                >
                  Subject: {record.reply_draft.subject}
                </div>
              )}
              <div
                className={
                  record.reply_draft.language === "ar" && !showEnglishMirror ? "rtl-text" : ""
                }
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 13.5 }}
              >
                {showEnglishMirror && record.reply_draft.english_mirror
                  ? record.reply_draft.english_mirror
                  : record.reply_draft.body}
              </div>
            </div>
          )}
        </div>

        {/* Detail Sub-Tabs */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <div className="mode-group">
            <button
              type="button"
              className={`mode-pill ${subTab === "extracted" ? "active" : ""}`}
              onClick={() => setSubTab("extracted")}
            >
              11-Field JSON Schema
            </button>
            <button
              type="button"
              className={`mode-pill ${subTab === "jev" ? "active" : ""}`}
              onClick={() => setSubTab("jev")}
            >
              Jev Probabilities & SDE Rules
            </button>
            <button
              type="button"
              className={`mode-pill ${subTab === "transcript" ? "active" : ""}`}
              onClick={() => setSubTab("transcript")}
            >
              Call Transcript ({rawTranscript.length})
            </button>
          </div>

          {subTab === "extracted" && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={copyExtractedJson}>
              <Copy size={13} />
              {copied ? "Copied!" : "Copy JSON"}
            </button>
          )}
        </div>

        {subTab === "extracted" && (
          <pre className="json-box">{JSON.stringify(record.extracted, null, 2)}</pre>
        )}

        {subTab === "jev" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {!record.jev_telemetry ? (
              <div className="banner banner-warn">
                No Jev telemetry recorded because this call was isolated prior to AI evaluation.
              </div>
            ) : (
              <>
                {record.jev_telemetry.primitives.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>
                      Parallel System-One Intake Judgments (`POST /v1/systemone`)
                    </div>
                    {record.jev_telemetry.primitives.map((p) => {
                      const numericBar =
                        typeof p.value === "number"
                          ? p.key === "urg_severity"
                            ? Math.min(100, Math.round((p.value / 2) * 100))
                            : Math.round(p.value * 100)
                          : Math.round((p.confidence ?? 0.85) * 100);

                      const fillColor = p.triggered
                        ? p.key.startsWith("urg_")
                          ? "var(--amira-magenta)"
                          : "var(--amira-violet)"
                        : "#c4bdd8";

                      return (
                        <div key={p.key} className="prob-row">
                          <span title={p.key} style={{ fontWeight: p.triggered ? 600 : 400 }}>
                            {p.label}
                          </span>
                          <div className="prob-track">
                            <div
                              className="prob-fill"
                              style={{ width: `${numericBar}%`, background: fillColor }}
                            />
                          </div>
                          <span className="mono" style={{ textAlign: "right", fontSize: 11.5 }}>
                            {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {record.jev_telemetry.sde_checks.length > 0 && (
                  <div>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        marginBottom: 8,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <ShieldCheck size={15} color="var(--amira-teal)" />
                      Jev SDE Semantic Verification Checks (`P(broken)` threshold `0.70`)
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {record.jev_telemetry.sde_checks.map((chk, idx) => (
                        <div
                          key={`${chk.rule}-${idx}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            flexWrap: "wrap",
                            padding: "8px 12px",
                            borderRadius: 6,
                            border: "1px solid var(--amira-border)",
                            fontSize: 12.5,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                            {chk.fired ? (
                              <AlertTriangle size={14} color="var(--amira-magenta)" />
                            ) : (
                              <CheckCircle2 size={14} color="var(--amira-teal)" />
                            )}
                            <span className="mono">{chk.rule}</span>
                          </div>
                          <span className="mono">
                            P(broken) = {chk.p_broken.toFixed(2)} · {chk.fired ? "FIRED" : "PASS"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {subTab === "transcript" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rawTranscript.map((turn, i) => {
              const isAr = /[\u0600-\u06FF]/.test(turn.text);
              const isAgent = turn.speaker === "agent";
              return (
                <div
                  key={i}
                  className={isAr ? "rtl-text" : ""}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 8,
                    background: isAgent ? "var(--amira-surface-subtle)" : "var(--amira-violet-soft)",
                    border: `1px solid ${isAgent ? "var(--amira-border)" : "var(--amira-violet-border)"}`,
                    fontSize: 13.5,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      color: isAgent ? "var(--amira-ink-muted)" : "var(--amira-violet)",
                      marginBottom: 3,
                    }}
                  >
                    {isAgent ? "Lena (AI Agent)" : "Caller"}
                  </div>
                  <div style={{ overflowWrap: "anywhere" }}>{turn.text}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
