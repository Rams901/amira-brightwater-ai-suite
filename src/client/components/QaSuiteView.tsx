import { useState } from "react";
import { CheckCircle2, Play, RotateCw, ShieldAlert, XCircle } from "lucide-react";
import type { TestCaseResult } from "../../shared/types.js";

export interface QaSuiteMeta {
  ranAt: string;
  providerMode: "live" | "sandbox";
  totalDurationMs: number;
}

interface QaSuiteViewProps {
  results: TestCaseResult[] | null;
  meta: QaSuiteMeta | null;
  running: boolean;
  progressText: string | null;
  error: string | null;
  onRunSuite: (onlyTestId?: string) => void;
}

export function QaSuiteView({
  results,
  meta,
  running,
  progressText,
  error,
  onRunSuite,
}: QaSuiteViewProps) {
  const [filterLang, setFilterLang] = useState<"all" | "en" | "ar" | "bilingual">("all");

  const filtered = (results ?? []).filter((r) =>
    filterLang === "all" ? true : r.language === filterLang
  );
  const passedCount = (results ?? []).filter((r) => r.passed).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div className="panel">
        <div className="panel-header">
          <div style={{ minWidth: 0 }}>
            <h2 className="panel-title">
              Automated Bilingual QA Verification Suite (10 Scenarios · English & Arabic)
            </h2>
            <div style={{ fontSize: 12.5, color: "var(--amira-ink-muted)", marginTop: 3 }}>
              Isolated in-memory SQLite test harness · Results persist across tab switches until you re-run.
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {meta && (
              <span className="badge badge-neutral">
                Last run: {(meta.totalDurationMs / 1000).toFixed(2)}s ({meta.providerMode.toUpperCase()})
              </span>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onRunSuite()}
              disabled={running}
            >
              <Play size={14} />
              {running ? progressText ?? "Running Suite..." : "Run All 10 EN + AR Tests"}
            </button>
          </div>
        </div>

        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div className="mode-group">
              {(["all", "en", "ar", "bilingual"] as const).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  className={`mode-pill ${filterLang === lang ? "active" : ""}`}
                  onClick={() => setFilterLang(lang)}
                >
                  {lang === "all"
                    ? "All Scenarios (10)"
                    : lang === "en"
                      ? "English"
                      : lang === "ar"
                        ? "Arabic (العربية)"
                        : "Bilingual & Security"}
                </button>
              ))}
            </div>

            {results && results.length > 0 && (
              <span
                className={`badge ${
                  passedCount === results.length ? "badge-booked" : "badge-urgent"
                }`}
              >
                {passedCount} / {results.length} Scenarios Passing
              </span>
            )}
          </div>

          {running && progressText && (
            <div className="banner banner-info">
              <span>{progressText}</span>
            </div>
          )}

          {error && (
            <div className="banner banner-error">
              <ShieldAlert size={16} />
              <span>{error}</span>
            </div>
          )}

          {(!results || results.length === 0) && !running && (
            <div className="banner banner-info">
              <span>
                Click <strong>Run All 10 EN + AR Tests</strong> above to stream each scenario live.
                Every assertion compares the exact JSON shown in <code>Expected</code> and <code>Actual</code>.
              </span>
            </div>
          )}

          {filtered.map((tc) => (
            <div
              key={tc.test_id}
              style={{
                border: `1px solid ${tc.passed ? "var(--amira-border)" : "var(--amira-magenta-border)"}`,
                borderRadius: "var(--radius-md)",
                padding: 16,
                background: tc.passed ? "var(--amira-surface-subtle)" : "var(--amira-magenta-soft)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  flexWrap: "wrap",
                  marginBottom: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  {tc.passed ? (
                    <CheckCircle2 size={17} color="var(--amira-teal)" />
                  ) : (
                    <XCircle size={17} color="var(--amira-magenta)" />
                  )}
                  <span className="mono" style={{ fontWeight: 700 }}>
                    {tc.test_id}
                  </span>
                  <span style={{ fontWeight: 600 }}>{tc.title}</span>
                  <span className="badge badge-violet">{tc.category_tag}</span>
                  <span className="badge badge-neutral">{tc.language.toUpperCase()}</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="mono" style={{ fontSize: 12, color: "var(--amira-ink-muted)" }}>
                    {tc.duration_ms >= 1000
                      ? `${(tc.duration_ms / 1000).toFixed(2)}s`
                      : `${tc.duration_ms} ms`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={running}
                    onClick={() => onRunSuite(tc.test_id)}
                    title={`Re-run only ${tc.test_id}`}
                  >
                    <RotateCw size={12} />
                    Re-run
                  </button>
                </div>
              </div>

              <div style={{ fontSize: 12.5, color: "var(--amira-ink-secondary)", marginBottom: 12 }}>
                {tc.description}
              </div>

              <div className="data-table-wrap">
                <table className="data-table" style={{ background: "#ffffff", borderRadius: 6 }}>
                  <thead>
                    <tr>
                      <th style={{ width: "44%" }}>Assertion</th>
                      <th style={{ width: "24%" }}>Expected</th>
                      <th style={{ width: "24%" }}>Actual</th>
                      <th style={{ width: "8%" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tc.assertions.map((a, idx) => (
                      <tr key={idx}>
                        <td>{a.label}</td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {a.expected}
                        </td>
                        <td className="mono" style={{ fontSize: 11.5 }}>
                          {a.actual}
                        </td>
                        <td>
                          <span className={`badge ${a.passed ? "badge-booked" : "badge-urgent"}`}>
                            {a.passed ? "PASS" : "FAIL"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
