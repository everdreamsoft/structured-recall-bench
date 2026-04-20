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
  timestamp: string
  model: string
}

const rows: Row[] = []
for (const f of readdirSync(RESULTS_DIR)) {
  if (!f.endsWith("_seed42.json")) continue
  const r = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"))
  let searchSum = 0, answerSum = 0
  for (const res of r.results) {
    searchSum += res.searchMs ?? 0
    answerSum += res.answerMs ?? 0
  }
  rows.push({
    provider: r.provider,
    composite: r.summary.composite,
    perClass: r.summary.perClass,
    recon: r.summary.reconciliationBreakdown,
    n: r.results.length,
    avgSearchMs: r.results.length ? searchSum / r.results.length : 0,
    avgAnswerMs: r.results.length ? answerSum / r.results.length : 0,
    timestamp: r.timestamp,
    model: r.model,
  })
}
rows.sort((a, b) => b.composite - a.composite)

const CLASSES = [
  "enumeration_csv",
  "enumeration_chat",
  "aggregation_cross_source",
  "reconciliation_update",
  "mixed_conditional",
] as const

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
      <p class="hint">Stale-v1 means the provider returned the original fact instead of the post-update value. High stale-v1 = the retriever didn't notice the correction.</p>
      <div class="chart-wrap"><canvas id="recon"></canvas></div>
    </section>

    <section class="card col-6">
      <h2>Mean latency per question</h2>
      <p class="hint">Search (provider) + answer (OpenAI). Ingestion time not included.</p>
      <div class="chart-wrap"><canvas id="latency"></canvas></div>
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
const CLASS_COLORS = {
  enumeration_csv: getComputedStyle(document.documentElement).getPropertyValue("--csv").trim(),
  enumeration_chat: getComputedStyle(document.documentElement).getPropertyValue("--chat").trim(),
  aggregation_cross_source: getComputedStyle(document.documentElement).getPropertyValue("--agg").trim(),
  reconciliation_update: getComputedStyle(document.documentElement).getPropertyValue("--recon").trim(),
  mixed_conditional: getComputedStyle(document.documentElement).getPropertyValue("--mixed").trim(),
};
const GRID = "rgba(255,255,255,0.06)";
const TICK = "#8a94a6";

Chart.defaults.color = "#e6e8ec";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = 'system-ui,-apple-system,"Segoe UI",Helvetica,Arial';

const labels = ROWS.map(r => r.provider);

// Leaderboard table
const lb = document.getElementById("lb");
for (const r of ROWS) {
  const pill = r.n >= 100 ? '<span class="pill ok">n='+r.n+'</span>'
             : r.n >= 20  ? '<span class="pill">n='+r.n+'</span>'
             : '<span class="pill warn" title="Smoke-test run, not a full benchmark">n='+r.n+'</span>';
  lb.insertAdjacentHTML("beforeend",
    '<tr><td><strong>'+r.provider+'</strong></td>' +
    '<td class="num">'+r.composite.toFixed(3)+'<div class="bar"><span style="width:'+(r.composite*100).toFixed(1)+'%"></span></div></td>' +
    '<td>'+pill+'</td></tr>');
}

// Composite bar
new Chart(document.getElementById("composite"), {
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

// Per-class grouped bars
new Chart(document.getElementById("perclass"), {
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

// Reconciliation stacked bar
const reconKeys = ["correct","stale-v1","wrong","no-answer"];
const reconColors = { "correct":"#22c55e", "stale-v1":"#f59e0b", "wrong":"#ef4444", "no-answer":"#64748b" };
new Chart(document.getElementById("recon"), {
  type: "bar",
  data: {
    labels,
    datasets: reconKeys.map(k => ({
      label: k,
      data: ROWS.map(r => r.recon[k] ?? 0),
      backgroundColor: reconColors[k],
      borderWidth: 0,
      stack: "recon",
    })),
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: "top", labels: { boxWidth: 12 } } },
    scales: {
      x: { stacked: true, grid: { display: false }, ticks: { color: TICK } },
      y: { stacked: true, grid: { color: GRID }, ticks: { color: TICK } },
    },
  },
});

// Latency
new Chart(document.getElementById("latency"), {
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
</script>
</body>
</html>
`

writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`open file://${OUT}`)
