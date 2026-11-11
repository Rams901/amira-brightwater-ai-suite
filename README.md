# Amira · Brightwater AI Customer Operations Suite

End-to-end solution for **Challenge 1 (Call-to-Outcome Workflow)** and **Challenge 2 (Lena Voice Agent Prompt Repair & Guardrail Lab)** in a single React 19 + TypeScript + Serverless/Express workspace, supporting **English & Arabic (RTL)**.

## Architecture & Models

- **System-One Calibrated Judgments:** **TypeSafe Jev (`jev-1.14.0`)** via `@typesafe-ai/sdk` (`$0.042 / 1M` input tokens · `$0` output tokens)
  - **14 parallel intake primitives** (`Noul`, `Choice`, `Score`) per call + **4 SDE reply verification `Noul`s** in Challenge 1
  - **6 parallel voice-safety `Noul` guardrails** in Challenge 2
- **System-Two Span Extraction, Grounded Prose & Thinking Judge:** **DeepSeek V4.1 Flash (`deepseek-flash` / `1017`)** (`$0.15 / 1M` input · `$0.60 / 1M` output)
  - Concurrent `caller_name`, `address`, and `<= 2-sentence` `summary` extraction with 1-shot JSON repair
  - Outcome-grounded **English & Arabic** SMS/Email reply drafting (with English operator mirror)
  - Multi-turn voice simulation + 5-dimension Thinking Judge (`61/100 -> 100/100` rubric gain across `S1`–`S10`)
- **Deterministic TypeScript Core:**
  - Restricted `.json` upload gate (`<= 2MB`, MIME + magic-byte spoofing check, Zod pre-flight)
  - Chronological nearest-2-free-slots calendar math & priority routing truth table
  - SQLite (`node:sqlite`) `(call_id, SHA-256)` idempotency ledger preventing duplicate bookings

---

## Run Locally in 2 Commands (Zero Keys Required to Start)

Requires **Node.js 22+**. Works **out of the box** in calibrated Bilingual Sandbox mode, or live when `TYPESAFE_API_KEY` and `DEEPSEEK_API_KEY` are added via `.env` or the in-app **`Set API Keys`** drawer.

```bash
npm install
npm run dev
```

Open **`http://localhost:5173`** to explore:
1. **Executive Overview:** Stakeholder KPIs, live latencies, unit economics, and side-by-side SVG architecture diagrams.
2. **Challenge 1 · Call Workflow:** Restricted `.json` uploader, `Hybrid Symphony` / `SDE Cascade` / `Benchmark Diff` modes, live availability matrix, On-Call / Office / Review queues, 10 EN+AR QA scenarios, and 1-click CSV / Workflow JSON export.
3. **Challenge 2 · Lena Voice Fix:** 7-defect forensic root-cause changelog (`5` transcript-visible + `2` hidden in `lena_prompt.txt`), 10 multi-turn live A/B transcripts, side-by-side prompt diff (`lena_prompt.txt` vs `lena_prompt_v2.txt`), live Jev guardrail simulator, 8 EN+AR voice evals, and 1-click Markdown submission export.

### Automated Verification Commands

```bash
npm test          # Runs Vitest suite across Challenge 1 (10 EN/AR QA cases) & Challenge 2 (10 multi-turn + 8 voice guardrail cases)
npm run build     # Type-checks (tsc --noEmit) and builds production bundle into dist/client
```

---

## Deploy to Netlify (1-Click or Auto-Import via `netlify.toml`)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Rams901/amira-brightwater-ai-suite)

This repository includes `netlify.toml` and `netlify/functions/api.ts` (`serverless-http` wrapping the Express API):

1. Import this GitHub repository in **Netlify** (`Add new site -> Import an existing project`).
2. Netlify automatically detects `npm run build`, publishes `dist/client`, and deploys `/api/*` via `netlify/functions/api.ts` on Node 22.
3. *(Optional for Live LLM calls)* In **Site configuration -> Environment variables**, add:
   - `TYPESAFE_API_KEY`
   - `DEEPSEEK_API_KEY`
   *(Without env vars, the deployed site runs cleanly in instant Bilingual Sandbox mode, or reviewers can paste keys in the top-right UI drawer.)*
