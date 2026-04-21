#!/usr/bin/env bun
// Generate a self-contained HTML dashboard from results/*.json
// Output: results/dashboard.html

import { readFileSync, readdirSync, writeFileSync } from "fs"
import { join } from "path"

const RESULTS_DIR = join(import.meta.dir, "..", "results")
const OUT = join(RESULTS_DIR, "dashboard.html")

type PerClass = { mean: number; n: number }
type Recon = { correct: number; "stale-v1": number; wrong: number; "no-answer": number }
type Row = {
  provider: string
  composite: number
  perClass: Record<string, PerClass>
  recon: Recon
  n: number
  avgSearchMs: number
  avgAnswerMs: number
  /** Measured: avg response length in chars. 1 token ≈ 4 chars for English output. */
  avgResponseChars: number
  /** Measured output-token estimate (response_chars / 4). */
  outTokens: number
  /** Architectural estimate — size of context the answer LLM typically receives. */
  inTokensEstimate: number
  timestamp: string
  model: string
}

/**
 * Per-provider architectural estimate of input tokens seen by the answer LLM.
 * These are NOT measured from the runs — they reflect what each provider's
 * search() returns on a typical question. Exact figures depend on question.
 * Source of estimate:
 *   - sandra-structured: planner (~1000 input) + tiny precomputed answer
 *     payload (~200 tokens) → ~1200 tokens total to the answer LLM.
 *   - full-context: entire 20-session corpus (~60k tokens, measured in practice).
 *   - sandra-semantic / memorybench adapter: returns ~20 facts (~300 tokens each) → ~6000.
 *   - mem0 / zep / supermemory / mempalace-mcp: top-K memories (~15-30 chunks,
 *     ~200-400 tokens each) → ~5000.
 * Label clearly as estimate in the dashboard.
 */
const INPUT_TOKENS_BY_PROVIDER: Record<string, number> = {
  "sandra-structured": 1200,
  "full-context": 60000,
  sandra: 6000,
  mem0: 5000,
  zep: 6000,
  supermemory: 4000,
  "mempalace-mcp": 4500,
  mempalace: 4500,
}

// Skip smoke-test runs (N<20) — they're not representative and only muddy the chart.
// Experimental *-planned variants are also excluded: the mem0-planned smoke showed
// that giving top-K retrievers the same structured planner as sandra-structured
// actually DEGRADES their performance (the planner generates refined queries that
// a semantic index can't satisfy exhaustively). We didn't build planned variants
// for zep/supermemory for the same architectural reason — see note in dashboard.
// mempalace (non-MCP, CLI-based) is skipped because it confuses the narrative
// alongside mempalace-mcp. The MCP variant is the richer surface and the one
// we benchmark as representative of mempalace-the-system.
const SKIP_PROVIDERS = new Set(["mem0-planned", "mempalace"])

const rows: Row[] = []
for (const f of readdirSync(RESULTS_DIR)) {
  const isStandard = /_seed42\.json$/.test(f)
  const isHard = /_seed42_hard\.json$/.test(f)
  if (!isStandard && !isHard) continue
  const r = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"))
  if (SKIP_PROVIDERS.has(r.provider)) continue
  if ((r.results?.length ?? 0) < 20) continue  // drop smokes
  let searchSum = 0, answerSum = 0, charsSum = 0
  for (const res of r.results) {
    searchSum += res.searchMs ?? 0
    answerSum += res.answerMs ?? 0
    charsSum += (res.response?.length ?? 0)
  }
  const n = r.results.length
  const avgResponseChars = n ? charsSum / n : 0
  const outTokens = Math.round(avgResponseChars / 4)
  const inTokens = INPUT_TOKENS_BY_PROVIDER[r.provider] ?? 5000
  rows.push({
    provider: isHard ? `${r.provider} (hard)` : r.provider,
    composite: r.summary.composite,
    perClass: r.summary.perClass,
    recon: r.summary.reconciliationBreakdown,
    n,
    avgSearchMs: n ? searchSum / n : 0,
    avgAnswerMs: n ? answerSum / n : 0,
    avgResponseChars,
    outTokens,
    inTokensEstimate: inTokens,
    timestamp: r.timestamp,
    model: r.model,
  })
}
rows.sort((a, b) => b.composite - a.composite)

const BASE_CLASSES = [
  "enumeration_csv",
  "enumeration_chat",
  "aggregation_cross_source",
  "reconciliation_update",
  "mixed_conditional",
  "multi_condition_enum",
  "multi_condition_agg",
  "bootstrap_multihop",
]
const seen = new Set<string>()
for (const r of rows) for (const k of Object.keys(r.perClass)) seen.add(k)
const CLASSES = BASE_CLASSES.filter(c => seen.has(c))

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Structured Recall Bench — scoreboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root{
    --bg:#0f1419; --panel:#171d26; --border:#232a36;
    --fg:#e6e8ec; --muted:#8a94a6; --accent:#5eead4;
    --csv:#4e79a7; --chat:#59a14f; --agg:#f28e2c; --recon:#b07aa1; --mixed:#e15759;
    --mce:#76b7b2; --mca:#edc949; --boot:#af7aa1;
    --ok:#22c55e; --warn:#f59e0b; --err:#ef4444;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif}
  .wrap{max-width:1200px;margin:0 auto;padding:32px 24px 80px}
  header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap;gap:16px}
  h1{font-size:24px;margin:0;letter-spacing:-0.01em}
  h1 small{font-weight:400;color:var(--muted);font-size:13px;margin-left:10px}
  .lede{color:var(--muted);margin:0 0 28px;max-width:820px}
  .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:20px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:20px}
  .card h2{font-size:14px;margin:0 0 4px;letter-spacing:0.04em;text-transform:uppercase;color:var(--muted)}
  .card .hint{color:var(--muted);font-size:12px;margin:0 0 14px}
  .col-12{grid-column:span 12}
  .col-8{grid-column:span 8}
  .col-6{grid-column:span 6}
  .col-4{grid-column:span 4}
  @media(max-width:900px){.col-8,.col-6,.col-4{grid-column:span 12}}
  .chart-wrap{position:relative;height:360px}
  .chart-wrap.tall{height:440px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:500;font-size:11px;letter-spacing:0.06em;text-transform:uppercase}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .bar{position:relative;height:8px;background:var(--border);border-radius:4px;overflow:hidden}
  .bar span{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--accent),#5eead4);border-radius:4px}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:var(--border);color:var(--muted)}
  .pill.warn{background:#3b2d12;color:#fbbf24}
  .pill.ok{background:#143622;color:#4ade80}
  .filter{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}
  .filter label{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--border);border-radius:999px;background:var(--panel);cursor:pointer;font-size:12px;color:var(--muted);user-select:none}
  .filter label.on{color:var(--fg);border-color:var(--accent)}
  .filter input{display:none}
  .filter .dot{width:8px;height:8px;border-radius:50%;background:var(--border)}
  .filter label.on .dot{background:var(--accent)}
  footer{margin-top:36px;color:var(--muted);font-size:12px;text-align:center}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>Structured Recall Bench <small>scoreboard · seed 42 · ${new Date().toISOString().slice(0,10)}</small></h1>
      <p class="lede">Five question classes measuring exhaustive recall, cross-source aggregation, and knowledge reconciliation — the capabilities top-K retrievers can't satisfy by construction. Higher is better.</p>
    </div>
  </header>

  <section class="card" style="margin-bottom:20px">
    <h2>Providers</h2>
    <p class="hint">Click a provider to toggle it across all charts. Hard-question runs appear as <code>provider (hard)</code>.</p>
    <div id="provider-filter" class="filter"></div>
  </section>

  <div class="grid">
    <section class="card col-8">
      <h2>Composite score</h2>
      <p class="hint">Mean of per-class means. Each class contributes equally regardless of question count.</p>
      <div class="chart-wrap"><canvas id="composite"></canvas></div>
    </section>

    <section class="card col-4">
      <h2>Leaderboard</h2>
      <p class="hint">Sorted by composite.</p>
      <table>
        <thead><tr><th>Provider</th><th class="num">Composite</th><th>n</th></tr></thead>
        <tbody id="lb"></tbody>
      </table>
    </section>

    <section class="card col-12">
      <h2>Per-class means</h2>
      <p class="hint">Grouped by class. Note that top-K retrievers collapse on <code>mixed_conditional</code> (requires exhaustive enumeration + ranking).</p>
      <div class="chart-wrap tall"><canvas id="perclass"></canvas></div>
    </section>

    <section class="card col-6">
      <h2>Reconciliation breakdown</h2>
      <p class="hint">Share (%) of the 20 reconciliation-update questions by outcome. Stale-v1 means the provider returned the original fact instead of the post-update value — the retriever didn't notice the correction.</p>
      <div class="chart-wrap"><canvas id="recon"></canvas></div>
    </section>

    <section class="card col-6">
      <h2>Mean latency per question</h2>
      <p class="hint">Search (provider) + answer (OpenAI). Ingestion time not included.</p>
      <div class="chart-wrap"><canvas id="latency"></canvas></div>
    </section>

    <!--
      Tokens-per-question card — hidden for now.
      Reason: input tokens are architectural estimates, not measured in the
      runner, so publishing them would be misleading. Will be re-enabled once
      the runner instruments real token counts via the ai-sdk response meta.
    <section class="card col-12">
      <h2>Tokens per question <small style="color:var(--muted);font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">estimated</small></h2>
      <p class="hint">
        Input tokens are the context the answer LLM receives per question — estimated from each provider's typical search() payload.
        Output tokens are measured from the response (chars/4). Lower total is cheaper per question.
        <em>sandra-structured</em> keeps input tiny because the provider precomputes the answer server-side; <em>full-context</em> sends the whole 60k-token corpus every time.
      </p>
      <div class="chart-wrap"><canvas id="tokens"></canvas></div>
    </section>
    -->

    <section class="card col-12">
      <h2>A note on <code>*-planned</code> variants</h2>
      <p class="hint" style="max-width:820px">
        We experimented with giving <code>mem0</code> the same LLM query planner that <code>sandra-structured</code> uses
        (<code>mem0-planned</code>, smoke test only). Composite <strong>dropped</strong> from 0.262 (raw) to 0.174 (planned).
        Why: a planner generates targeted semantic queries — but a top-K semantic index, by construction,
        cannot return the <em>exhaustive filtered set</em> a structured question demands. The more precise the query,
        the more obvious the ceiling. We did not build <code>zep-planned</code> or <code>supermemory-planned</code> for
        the same reason: the bottleneck is the retrieval backend, not the query formulation. Adding a planner
        to a top-K store is architecturally incapable of closing the gap this benchmark exposes.
      </p>
    </section>
  </div>

  <footer>
    Generated from <code>results/*.json</code> · reproducible with <code>bun run src/runner.ts --provider &lt;name&gt;</code> ·
    <a href="https://github.com/everdreamsoft/structured-recall-bench">structured-recall-bench</a>
  </footer>
</div>

<script>
const ROWS = ${JSON.stringify(rows)};
const CLASSES = ${JSON.stringify(CLASSES)};
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const CLASS_COLORS = {
  enumeration_csv: cssVar("--csv"),
  enumeration_chat: cssVar("--chat"),
  aggregation_cross_source: cssVar("--agg"),
  reconciliation_update: cssVar("--recon"),
  mixed_conditional: cssVar("--mixed"),
  multi_condition_enum: cssVar("--mce"),
  multi_condition_agg: cssVar("--mca"),
  bootstrap_multihop: cssVar("--boot"),
};
const GRID = "rgba(255,255,255,0.06)";
const TICK = "#8a94a6";

Chart.defaults.color = "#e6e8ec";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = 'system-ui,-apple-system,"Segoe UI",Helvetica,Arial';

const active = new Set(ROWS.map(r => r.provider));

// Provider filter checkboxes
const filterEl = document.getElementById("provider-filter");
for (const r of ROWS) {
  const id = "pf_" + r.provider.replace(/[^a-z0-9]/gi,"_");
  filterEl.insertAdjacentHTML("beforeend",
    '<label class="on" data-provider="'+r.provider+'"><input type="checkbox" checked id="'+id+'"/>'+
    '<span class="dot"></span>'+r.provider+'</label>');
}
filterEl.addEventListener("change", e => {
  const lbl = e.target.closest("label");
  const p = lbl.dataset.provider;
  if (e.target.checked) { active.add(p); lbl.classList.add("on"); }
  else { active.delete(p); lbl.classList.remove("on"); }
  render();
});

const lbEl = document.getElementById("lb");
const charts = {};

function visible() { return ROWS.filter(r => active.has(r.provider)); }

function render() {
  const rs = visible();
  const labels = rs.map(r => r.provider);

  // Leaderboard
  lbEl.innerHTML = "";
  for (const r of rs) {
    const pill = r.n >= 100 ? '<span class="pill ok">n='+r.n+'</span>'
               : r.n >= 20  ? '<span class="pill">n='+r.n+'</span>'
               : '<span class="pill warn" title="Smoke-test run, not a full benchmark">n='+r.n+'</span>';
    lbEl.insertAdjacentHTML("beforeend",
      '<tr><td><strong>'+r.provider+'</strong></td>' +
      '<td class="num">'+r.composite.toFixed(3)+'<div class="bar"><span style="width:'+(r.composite*100).toFixed(1)+'%"></span></div></td>' +
      '<td>'+pill+'</td></tr>');
  }

  // Composite
  charts.composite.data.labels = labels;
  charts.composite.data.datasets[0].data = rs.map(r => r.composite);
  charts.composite.data.datasets[0].backgroundColor = rs.map(r => r.n >= 20 ? "#5eead4" : "#2b8a7e");
  charts.composite.update();

  // Per-class
  charts.perclass.data.labels = labels;
  charts.perclass.data.datasets.forEach(ds => {
    ds.data = rs.map(r => r.perClass[ds.label]?.mean ?? 0);
  });
  charts.perclass.update();

  // Recon (%)
  charts.recon.data.labels = labels;
  charts.recon.data.datasets.forEach(ds => {
    ds.data = rs.map(r => reconPct(r, ds.label));
  });
  charts.recon.update();

  // Latency
  charts.latency.data.labels = labels;
  charts.latency.data.datasets[0].data = rs.map(r => Math.round(r.avgSearchMs));
  charts.latency.data.datasets[1].data = rs.map(r => Math.round(r.avgAnswerMs));
  charts.latency.update();

  // Tokens per question
  charts.tokens.data.labels = labels;
  charts.tokens.data.datasets[0].data = rs.map(r => r.inTokensEstimate);
  charts.tokens.data.datasets[1].data = rs.map(r => r.outTokens);
  charts.tokens.update();
}

const labels = ROWS.map(r => r.provider);

charts.composite = new Chart(document.getElementById("composite"), {
  type: "bar",
  data: {
    labels,
    datasets: [{
      label: "composite",
      data: ROWS.map(r => r.composite),
      backgroundColor: ROWS.map(r => r.n >= 20 ? "#5eead4" : "#2b8a7e"),
      borderWidth: 0,
    }],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => "composite " + ctx.parsed.y.toFixed(3) + "  (n=" + ROWS[ctx.dataIndex].n + ")" } },
    },
    scales: {
      y: { min: 0, max: 1, grid: { color: GRID }, ticks: { color: TICK } },
      x: { grid: { display: false }, ticks: { color: TICK } },
    },
  },
});

charts.perclass = new Chart(document.getElementById("perclass"), {
  type: "bar",
  data: {
    labels,
    datasets: CLASSES.map(cls => ({
      label: cls,
      data: ROWS.map(r => r.perClass[cls]?.mean ?? 0),
      backgroundColor: CLASS_COLORS[cls],
      borderWidth: 0,
    })),
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "top", labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ": " + ctx.parsed.y.toFixed(3) } },
    },
    scales: {
      y: { min: 0, max: 1, grid: { color: GRID }, ticks: { color: TICK } },
      x: { grid: { display: false }, ticks: { color: TICK } },
    },
  },
});

// Reconciliation stacked bar — normalized to % of each provider's reconciliation answers
const reconKeys = ["correct","stale-v1","wrong","no-answer"];
const reconColors = { "correct":"#22c55e", "stale-v1":"#f59e0b", "wrong":"#ef4444", "no-answer":"#64748b" };
function reconPct(r, k) {
  const total = reconKeys.reduce((s, kk) => s + (r.recon?.[kk] ?? 0), 0);
  if (!total) return 0;
  return ((r.recon?.[k] ?? 0) / total) * 100;
}
charts.recon = new Chart(document.getElementById("recon"), {
  type: "bar",
  data: {
    labels,
    datasets: reconKeys.map(k => ({
      label: k,
      data: ROWS.map(r => reconPct(r, k)),
      backgroundColor: reconColors[k],
      borderWidth: 0,
      stack: "recon",
    })),
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "top", labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ": " + ctx.parsed.y.toFixed(0) + "%" } },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: TICK } },
      y: { stacked: true, min: 0, max: 100, grid: { color: GRID }, ticks: { color: TICK, callback: v => v + "%" } },
    },
  },
});

charts.latency = new Chart(document.getElementById("latency"), {
  type: "bar",
  data: {
    labels,
    datasets: [
      { label: "search (ms)", data: ROWS.map(r => Math.round(r.avgSearchMs)), backgroundColor: "#5eead4", borderWidth: 0 },
      { label: "answer (ms)", data: ROWS.map(r => Math.round(r.avgAnswerMs)), backgroundColor: "#64748b", borderWidth: 0 },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: "top", labels: { boxWidth: 12 } } },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: TICK } },
      y: { stacked: true, grid: { color: GRID }, ticks: { color: TICK, callback: v => v + " ms" } },
    },
  },
});

charts.tokens = new Chart(document.getElementById("tokens"), {
  type: "bar",
  data: {
    labels,
    datasets: [
      { label: "input (estimated)", data: ROWS.map(r => r.inTokensEstimate), backgroundColor: "#5eead4", borderWidth: 0 },
      { label: "output (measured)", data: ROWS.map(r => r.outTokens), backgroundColor: "#f59e0b", borderWidth: 0 },
    ],
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: "top", labels: { boxWidth: 12 } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ": " + ctx.parsed.y.toLocaleString() + " tok" } },
    },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: TICK } },
      y: { stacked: true, grid: { color: GRID }, ticks: { color: TICK, callback: v => v.toLocaleString() + " tok" } },
    },
  },
});

render();
</script>
</body>
</html>
`

writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`open file://${OUT}`)
