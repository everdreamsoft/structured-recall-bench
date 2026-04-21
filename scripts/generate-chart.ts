#!/usr/bin/env bun
// Generate a composite-score bar chart (SVG) across providers.
// Reads results/*.json written by runner.ts.

import { readFileSync, readdirSync, writeFileSync } from "fs"
import { join } from "path"

const RESULTS_DIR = join(import.meta.dir, "..", "results")
const OUT = join(RESULTS_DIR, "scoreboard.svg")

type Row = { provider: string; composite: number; n: number }

const SKIP = new Set(["mem0-planned"])
const rows: Row[] = []
for (const file of readdirSync(RESULTS_DIR)) {
  if (!file.endsWith("_seed42.json")) continue
  const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8"))
  if (SKIP.has(data.provider)) continue
  if ((data.results?.length ?? 0) < 20) continue
  rows.push({
    provider: data.provider,
    composite: data.summary.composite,
    n: data.results.length,
  })
}
rows.sort((a, b) => b.composite - a.composite)

const W = 1200
const H = 480
const PAD = { top: 70, right: 30, bottom: 90, left: 70 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom
const groupW = plotW / rows.length
const barW = Math.min(groupW - 30, 90)

const y = (v: number) => PAD.top + plotH - v * plotH

const TODAY = new Date().toISOString().slice(0, 10)
const WINNER = "#2bb3a4"
const BAR = "#334155"

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,Helvetica,Arial,sans-serif">`
svg += `<rect width="${W}" height="${H}" fill="#fff"/>`
svg += `<text x="${W / 2}" y="34" text-anchor="middle" font-size="20" font-weight="600">Structured Recall Bench — composite score by provider</text>`
svg += `<text x="${W / 2}" y="54" text-anchor="middle" font-size="12" fill="#666">seed=42 · ${TODAY} · mean of per-class means · higher is better</text>`

// y-axis grid + labels
for (let t = 0; t <= 10; t += 2) {
  const v = t / 10
  const yy = y(v)
  svg += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yy}" y2="${yy}" stroke="#eee"/>`
  svg += `<text x="${PAD.left - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#666">${v.toFixed(1)}</text>`
}
svg += `<line x1="${PAD.left}" x2="${PAD.left}" y1="${PAD.top}" y2="${PAD.top + plotH}" stroke="#888"/>`
svg += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${PAD.top + plotH}" y2="${PAD.top + plotH}" stroke="#888"/>`

// bars
rows.forEach((row, i) => {
  const cx = PAD.left + i * groupW + groupW / 2
  const bx = cx - barW / 2
  const by = y(row.composite)
  const bh = PAD.top + plotH - by
  svg += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" fill="${i === 0 ? WINNER : BAR}" rx="3"/>`
  svg += `<text x="${cx}" y="${by - 6}" text-anchor="middle" font-size="13" font-weight="600" fill="#111">${row.composite.toFixed(3)}</text>`
  svg += `<text x="${cx}" y="${PAD.top + plotH + 22}" text-anchor="middle" font-size="13" font-weight="600" fill="#222">${row.provider}</text>`
  svg += `<text x="${cx}" y="${PAD.top + plotH + 38}" text-anchor="middle" font-size="10" fill="#777">n=${row.n}</text>`
})

svg += `</svg>`
writeFileSync(OUT, svg)
console.log(`wrote ${OUT}`)
console.log(`open file://${OUT} to view`)
