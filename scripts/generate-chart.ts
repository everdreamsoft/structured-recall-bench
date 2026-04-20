#!/usr/bin/env bun
// Generate a grouped bar chart (SVG) comparing all providers across the
// 5 question classes + composite. Reads results/*.json written by runner.ts.

import { readFileSync, readdirSync, writeFileSync } from "fs"
import { join } from "path"

const RESULTS_DIR = join(import.meta.dir, "..", "results")
const OUT = join(RESULTS_DIR, "scoreboard.svg")

const CLASSES = [
  "enumeration_csv",
  "enumeration_chat",
  "aggregation_cross_source",
  "reconciliation_update",
  "mixed_conditional",
  "composite",
] as const

const COLORS: Record<string, string> = {
  enumeration_csv: "#4e79a7",
  enumeration_chat: "#59a14f",
  aggregation_cross_source: "#f28e2c",
  reconciliation_update: "#b07aa1",
  mixed_conditional: "#e15759",
  composite: "#333333",
}

type Row = { provider: string; scores: Record<string, number> }

const rows: Row[] = []
for (const file of readdirSync(RESULTS_DIR)) {
  if (!file.endsWith("_seed42.json")) continue
  const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf8"))
  const scores: Record<string, number> = { composite: data.summary.composite }
  for (const [k, v] of Object.entries<any>(data.summary.perClass)) scores[k] = v.mean
  rows.push({ provider: data.provider, scores })
}

const order = ["sandra-structured", "full-context", "sandra", "zep", "supermemory", "mem0"]
rows.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))

const W = 1200
const H = 640
const PAD = { top: 70, right: 30, bottom: 120, left: 70 }
const plotW = W - PAD.left - PAD.right
const plotH = H - PAD.top - PAD.bottom
const groupW = plotW / rows.length
const barW = (groupW - 20) / CLASSES.length

const y = (v: number) => PAD.top + plotH - v * plotH

let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui,Helvetica,Arial,sans-serif">`
svg += `<rect width="${W}" height="${H}" fill="#fff"/>`
svg += `<text x="${W / 2}" y="30" text-anchor="middle" font-size="20" font-weight="600">Structured Recall Bench — scores by provider (seed=42, 2026-04-20)</text>`
svg += `<text x="${W / 2}" y="52" text-anchor="middle" font-size="12" fill="#666">Per-class means + composite (mean of class means). Higher is better.</text>`

// y-axis grid + labels
for (let t = 0; t <= 10; t++) {
  const v = t / 10
  const yy = y(v)
  svg += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${yy}" y2="${yy}" stroke="#eee"/>`
  svg += `<text x="${PAD.left - 8}" y="${yy + 4}" text-anchor="end" font-size="10" fill="#666">${v.toFixed(1)}</text>`
}
svg += `<line x1="${PAD.left}" x2="${PAD.left}" y1="${PAD.top}" y2="${PAD.top + plotH}" stroke="#888"/>`
svg += `<line x1="${PAD.left}" x2="${W - PAD.right}" y1="${PAD.top + plotH}" y2="${PAD.top + plotH}" stroke="#888"/>`

// bars
rows.forEach((row, gi) => {
  const gx = PAD.left + gi * groupW + 10
  CLASSES.forEach((cls, ci) => {
    const v = row.scores[cls] ?? 0
    const bx = gx + ci * barW
    const by = y(v)
    const bh = PAD.top + plotH - by
    svg += `<rect x="${bx}" y="${by}" width="${barW - 2}" height="${bh}" fill="${COLORS[cls]}" opacity="${cls === "composite" ? 1 : 0.85}"/>`
    if (v >= 0.05) {
      svg += `<text x="${bx + (barW - 2) / 2}" y="${by - 3}" text-anchor="middle" font-size="9" fill="#222">${v.toFixed(2)}</text>`
    }
  })
  svg += `<text x="${gx + (groupW - 20) / 2}" y="${PAD.top + plotH + 20}" text-anchor="middle" font-size="13" font-weight="600">${row.provider}</text>`
  svg += `<text x="${gx + (groupW - 20) / 2}" y="${PAD.top + plotH + 36}" text-anchor="middle" font-size="11" fill="#555">composite ${row.scores.composite.toFixed(3)}</text>`
})

// legend
const legendY = H - 50
const legendStartX = 60
CLASSES.forEach((cls, i) => {
  const x = legendStartX + i * 185
  svg += `<rect x="${x}" y="${legendY}" width="14" height="14" fill="${COLORS[cls]}"/>`
  svg += `<text x="${x + 20}" y="${legendY + 11}" font-size="11" fill="#333">${cls}</text>`
})

svg += `</svg>`
writeFileSync(OUT, svg)
console.log(`wrote ${OUT}`)
console.log(`open file://${OUT} to view`)
