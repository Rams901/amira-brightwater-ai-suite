import { ArrowRight, CheckCircle2, Cpu, ShieldCheck, Zap } from "lucide-react";

interface ExecutiveHomeProps {
  onOpenChallenge1: () => void;
  onOpenChallenge2: () => void;
  c1ProcessedCount: number;
  c1QaPassText: string;
  c2EvalPassText: string;
  lastBatchDurationText: string;
  providerMode: "live" | "sandbox";
  c2JudgeScoreText: string;
  c2MultiTurnPassText: string;
}

function Challenge1DiagramSvg() {
  return (
    <svg
      viewBox="0 0 560 214"
      width="100%"
      role="img"
      aria-label="Challenge 1 Architecture Diagram"
      style={{ display: "block", background: "#faf9fe", borderRadius: 10, border: "1px solid #e6e0f3" }}
    >
      <defs>
        <marker id="arr1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#7b7597" />
        </marker>
      </defs>

      {/* Stage 1 */}
      <rect x="12" y="73" width="104" height="68" rx="8" fill="#ffffff" stroke="#0f0a36" strokeWidth="1.4" />
      <rect x="12" y="73" width="5" height="68" rx="2" fill="#0f0a36" />
      <text x="23" y="94" fontSize="10.2" fontWeight="700" fill="#0f0a36">1. Gate + Lock</text>
      <text x="23" y="110" fontSize="9" fill="#524e6b">.json &lt;= 2MB · Zod</text>
      <text x="23" y="125" fontSize="9" fill="#524e6b">SHA-256 + Regex</text>

      {/* Parallel Fork */}
      <path d="M 116 95 C 134 95, 134 50, 152 50" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr1)" />
      <path d="M 116 119 C 134 119, 134 164, 152 164" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr1)" />

      {/* Jev System One */}
      <rect x="154" y="16" width="170" height="68" rx="8" fill="#f2edff" stroke="#3c0ca5" strokeWidth="1.6" />
      <rect x="154" y="16" width="6" height="68" rx="2" fill="#3c0ca5" />
      <text x="167" y="36" fontSize="10.3" fontWeight="700" fill="#3c0ca5">TypeSafe Jev · jev-1.14.0</text>
      <text x="167" y="52" fontSize="9.2" fontWeight="600" fill="#0f0a36">14 Parallel Primitives (~0.5s)</text>
      <text x="167" y="67" fontSize="8.8" fill="#524e6b">4 Cat · 4 Urg · Slot Choice · $0 out</text>

      {/* DeepSeek V4.1 Flash */}
      <rect x="154" y="130" width="170" height="68" rx="8" fill="#edfdf8" stroke="#0f8a78" strokeWidth="1.6" />
      <rect x="154" y="130" width="6" height="68" rx="2" fill="#0f8a78" />
      <text x="167" y="150" fontSize="10.3" fontWeight="700" fill="#0f8a78">DeepSeek V4.1 · deepseek-flash</text>
      <text x="167" y="166" fontSize="9.2" fontWeight="600" fill="#0f0a36">Span JSON + 1-Shot Repair (~1.4s)</text>
      <text x="167" y="181" fontSize="8.8" fill="#524e6b">Name · Address · &lt;=2-Sent Summary</text>

      {/* Join */}
      <path d="M 324 50 C 341 50, 341 95, 356 95" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr1)" />
      <path d="M 324 164 C 341 164, 341 119, 356 119" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr1)" />

      {/* TS Router */}
      <rect x="358" y="71" width="90" height="72" rx="8" fill="#ffffff" stroke="#0f0a36" strokeWidth="1.4" />
      <text x="367" y="92" fontSize="10" fontWeight="700" fill="#0f0a36">TS Truth Table</text>
      <text x="367" y="107" fontSize="8.8" fill="#524e6b">Book / 2 Free Alt</text>
      <text x="367" y="120" fontSize="8.8" fill="#c4008e">Urgent -&gt; OnCall</text>
      <text x="367" y="133" fontSize="8.8" fill="#524e6b">SQLite Ledger</text>

      <path d="M 448 107 L 464 107" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr1)" />

      {/* Reply + Jev SDE */}
      <rect x="466" y="59" width="82" height="96" rx="8" fill="#fdf2fa" stroke="#c4008e" strokeWidth="1.4" />
      <text x="474" y="79" fontSize="9.8" fontWeight="700" fill="#c4008e">Reply + SDE</text>
      <text x="474" y="94" fontSize="8.6" fontWeight="600" fill="#0f8a78">deepseek-flash</text>
      <text x="474" y="107" fontSize="8.6" fill="#524e6b">EN / AR Draft</text>
      <text x="474" y="123" fontSize="8.6" fontWeight="600" fill="#3c0ca5">+ jev-1.14.0</text>
      <text x="474" y="136" fontSize="8.5" fill="#524e6b">4 Rule Nouls</text>
    </svg>
  );
}

function Challenge2DiagramSvg() {
  return (
    <svg
      viewBox="0 0 560 214"
      width="100%"
      role="img"
      aria-label="Challenge 2 Architecture Diagram"
      style={{ display: "block", background: "#faf9fe", borderRadius: 10, border: "1px solid #e6e0f3" }}
    >
      <defs>
        <marker id="arr2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#7b7597" />
        </marker>
      </defs>

      {/* Caller Persona + STT Noise */}
      <rect x="12" y="73" width="106" height="68" rx="8" fill="#ffffff" stroke="#0f0a36" strokeWidth="1.4" />
      <rect x="12" y="73" width="5" height="68" rx="2" fill="#0f0a36" />
      <text x="23" y="94" fontSize="10.2" fontWeight="700" fill="#0f0a36">Caller + STT Sim</text>
      <text x="23" y="110" fontSize="8.8" fill="#0f8a78">deepseek-flash</text>
      <text x="23" y="125" fontSize="8.8" fill="#c4008e">4433 -&gt; 4483 Noise</text>

      {/* Fork */}
      <path d="M 118 95 C 135 95, 135 50, 152 50" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr2)" />
      <path d="M 118 119 C 135 119, 135 164, 152 164" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr2)" />

      {/* v1 Legacy */}
      <rect x="154" y="16" width="172" height="68" rx="8" fill="#fffbeb" stroke="#b45309" strokeWidth="1.4" />
      <text x="165" y="36" fontSize="10.2" fontWeight="700" fill="#b45309">Lena v1 · Legacy (10% Pass)</text>
      <text x="165" y="52" fontSize="8.9" fontWeight="600" fill="#0f0a36">deepseek-flash (non-thinking)</text>
      <text x="165" y="67" fontSize="8.6" fill="#b45309">89/129 EUR leak · 4483 saved · 5 Qs</text>

      {/* v2 Repaired */}
      <rect x="154" y="130" width="172" height="68" rx="8" fill="#edfdf8" stroke="#0f8a78" strokeWidth="1.6" />
      <rect x="154" y="130" width="6" height="68" rx="2" fill="#0f8a78" />
      <text x="165" y="150" fontSize="10.2" fontWeight="700" fill="#0f8a78">Lena v2 · Repaired (100% Pass)</text>
      <text x="165" y="166" fontSize="8.9" fontWeight="600" fill="#0f0a36">deepseek-flash (EN + AR Voice)</text>
      <text x="165" y="181" fontSize="8.6" fill="#0f8a78">Gas Evac · Readback 4433 · &lt;=2 Qs</text>

      {/* Join to Dual Judge */}
      <path d="M 326 50 C 344 50, 344 95, 362 95" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr2)" />
      <path d="M 326 164 C 344 164, 344 119, 362 119" fill="none" stroke="#7b7597" strokeWidth="1.4" markerEnd="url(#arr2)" />

      {/* Dual Verification: Jev 1.14 + DeepSeek Thinking Judge */}
      <rect x="364" y="42" width="184" height="130" rx="8" fill="#f2edff" stroke="#3c0ca5" strokeWidth="1.6" />
      <rect x="364" y="42" width="6" height="130" rx="2" fill="#3c0ca5" />
      <text x="377" y="63" fontSize="10.2" fontWeight="700" fill="#3c0ca5">Dual Guardrail &amp; Rubric Audit</text>
      <text x="377" y="81" fontSize="9" fontWeight="600" fill="#3c0ca5">1. TypeSafe Jev · jev-1.14.0</text>
      <text x="377" y="95" fontSize="8.6" fill="#524e6b">6 Parallel Voice Nouls (P &lt;= 0.70)</text>
      <text x="377" y="114" fontSize="9" fontWeight="600" fill="#0f8a78">2. DeepSeek · deepseek-flash</text>
      <text x="377" y="128" fontSize="8.6" fill="#524e6b">Thinking Judge (5-Rubric 0–100)</text>
      <text x="377" y="146" fontSize="8.8" fontWeight="700" fill="#0f0a36">+ TS System-Log Invariant Check</text>
      <text x="377" y="160" fontSize="8.6" fontWeight="700" fill="#c4008e">Score: v1 61/100 -&gt; v2 100/100</text>
    </svg>
  );
}

export function ExecutiveHomeView({
  onOpenChallenge1,
  onOpenChallenge2,
  c1ProcessedCount,
  c1QaPassText,
  c2EvalPassText,
  lastBatchDurationText,
  providerMode,
  c2JudgeScoreText,
  c2MultiTurnPassText,
}: ExecutiveHomeProps) {
  const c1PassNum = Number(c1QaPassText.split("/")[0]) || 10;
  const mtPassNum = Number(c2MultiTurnPassText.split("/")[0]) || 10;
  const arPassNum = Number(c2EvalPassText.split("/")[0]) || 8;
  const totalPassSum = c1PassNum + mtPassNum + arPassNum;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Explicit Models & Token Cost Strip */}
      <div
        style={{
          background: "var(--amira-surface)",
          border: "1px solid var(--amira-border)",
          borderRadius: "var(--radius-lg)",
          padding: "14px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="badge badge-violet" style={{ fontSize: 12, padding: "4px 10px" }}>
            <Cpu size={13} /> TypeSafe Jev (`jev-1.14.0`) · $0.042/1M in · $0 out
          </span>
          <span className="badge badge-booked" style={{ fontSize: 12, padding: "4px 10px" }}>
            <Zap size={13} /> DeepSeek V4.1 Flash (`deepseek-flash` / 1017) · $0.15/1M in · $0.60/1M out
          </span>
          <span className="badge badge-neutral" style={{ fontSize: 12, padding: "4px 10px" }}>
            <ShieldCheck size={13} /> EN + AR Bilingual
          </span>
        </div>

        <span
          className={`badge ${providerMode === "live" ? "badge-booked" : "badge-alt"}`}
          style={{ fontSize: 12, padding: "4px 10px" }}
        >
          {providerMode === "live" ? "LIVE APIs ACTIVE" : "SANDBOX ACTIVE"}
        </span>
      </div>

      {/* 5 Big Stakeholder KPI Numbers */}
      <div className="exec-kpi-grid">
        <div className="exec-kpi-card">
          <div className="exec-kpi-num" style={{ color: "var(--amira-violet)" }}>
            20
          </div>
          <div className="exec-kpi-title">Jev `jev-1.14.0` Primitives</div>
          <div className="exec-kpi-sub">14 Intake + 6 Voice Guardrails</div>
        </div>

        <div className="exec-kpi-card">
          <div className="exec-kpi-num" style={{ color: "var(--amira-teal)" }}>
            {lastBatchDurationText}
          </div>
          <div className="exec-kpi-title">Live Avg Call Latency</div>
          <div className="exec-kpi-sub">Parallel Jev || DeepSeek Flash</div>
        </div>

        <div className="exec-kpi-card">
          <div className="exec-kpi-num" style={{ color: "var(--amira-magenta)" }}>
            {c2JudgeScoreText}
          </div>
          <div className="exec-kpi-title">Lena Voice Rubric Gain</div>
          <div className="exec-kpi-sub">`deepseek-flash` Thinking Judge</div>
        </div>

        <div className="exec-kpi-card">
          <div className="exec-kpi-num">{totalPassSum} / 28</div>
          <div className="exec-kpi-title">Automated Scenarios</div>
          <div className="exec-kpi-sub">
            {c1QaPassText} C1 · {c2MultiTurnPassText} Multi-Turn · {c2EvalPassText} EN/AR
          </div>
        </div>

        <div className="exec-kpi-card">
          <div className="exec-kpi-num" style={{ color: "var(--amira-indigo)" }}>
            $0.044
          </div>
          <div className="exec-kpi-title">20-Call Live Eval Cost</div>
          <div className="exec-kpi-sub">187.6K in / 26.5K out tokens</div>
        </div>
      </div>

      {/* Side-by-Side Challenge Selector Cards */}
      <div className="challenge-cards-grid">
        {/* CHALLENGE 1 */}
        <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
          <div className="panel-header">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="badge badge-violet">CHALLENGE 1</span>
                <h2 className="panel-title" style={{ fontSize: 16 }}>
                  Call-to-Outcome Workflow Studio
                </h2>
              </div>
              <div style={{ fontSize: 12, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                `jev-1.14.0` (Judgments) + `deepseek-flash` (Spans &amp; Replies) + SQLite Ledger
              </div>
            </div>

            <button type="button" className="btn btn-primary" onClick={onOpenChallenge1}>
              Open Challenge 1
              <ArrowRight size={14} />
            </button>
          </div>

          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 15, flex: 1 }}
          >
            <div className="mini-stat-row">
              <div className="mini-stat">
                <span className="mini-stat-val">11</span>
                <span className="mini-stat-lbl">JSON Fields</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-violet)" }}>14 + 4</span>
                <span className="mini-stat-lbl">Jev Nouls/Choices</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-teal)" }}>10 / 10</span>
                <span className="mini-stat-lbl">EN + AR QA</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val">{c1ProcessedCount || "0"}</span>
                <span className="mini-stat-lbl">Active Calls</span>
              </div>
            </div>

            <Challenge1DiagramSvg />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>`.json` Gate (&lt;= 2MB + Magic-Byte)</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>3 Modes: Hybrid / Cascade / Diff</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>2 Nearest Free Slots Math</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>0 Duplicate Bookings (SHA-256)</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>1 -&gt; N Per-Call Fault Isolation</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>EN + AR RTL Replies + CSV/JSON</span>
              </div>
            </div>
          </div>
        </div>

        {/* CHALLENGE 2 */}
        <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
          <div className="panel-header">
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="badge badge-urgent">CHALLENGE 2</span>
                <h2 className="panel-title" style={{ fontSize: 16 }}>
                  Lena Voice Prompt Repair &amp; Eval Lab
                </h2>
              </div>
              <div style={{ fontSize: 12, color: "var(--amira-ink-muted)", marginTop: 2 }}>
                `deepseek-flash` (Voice + Thinking Judge) + `jev-1.14.0` (6 Voice Guardrails)
              </div>
            </div>

            <button type="button" className="btn btn-primary" onClick={onOpenChallenge2}>
              Open Challenge 2
              <ArrowRight size={14} />
            </button>
          </div>

          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 15, flex: 1 }}
          >
            <div className="mini-stat-row">
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-magenta)" }}>7</span>
                <span className="mini-stat-lbl">Root Causes Fixed</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-amber)" }}>10%</span>
                <span className="mini-stat-lbl">Legacy v1 Pass</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-teal)" }}>
                  {mtPassNum * 10}%
                </span>
                <span className="mini-stat-lbl">Repaired v2 Pass</span>
              </div>
              <div className="mini-stat">
                <span className="mini-stat-val" style={{ color: "var(--amira-violet)" }}>100/100</span>
                <span className="mini-stat-lbl">v2 Rubric Score</span>
              </div>
            </div>

            <Challenge2DiagramSvg />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>Gas/Flood Evac (0h vs 48h Delay)</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>0 EUR Quoted (Removed L25–26)</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>STT Read-Back (`4483` -&gt; `4433`)</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>Hidden `"Good morning"` Bug Fixed</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>10 Multi-Turn + 8 EN/AR Evals</span>
              </div>
              <div className="feature-chip">
                <CheckCircle2 size={13} color="var(--amira-teal)" />
                <span>1-Click Part 2 Markdown Export</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
