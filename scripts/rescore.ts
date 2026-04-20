#!/usr/bin/env bun
/**
 * Re-score all existing results files with the current scorer.
 *
 * Usage: bun run scripts/rescore.ts
 *
 * Reads results/*.json, recomputes scores from the raw responses using the
 * latest scorer + parser (src/scorer.ts). Writes back in-place and prints
 * a diff summary per provider.
 *
 * Rationale: the scorer's extractFirstNumber was fixed to accept <3-digit
 * integers (recon-sonya-brown-employees = 86). This re-score propagates
 * that fix to earlier runs without spending any LLM API budget.
 */

import { readFileSync, writeFileSync, readdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

import { scoreResponse, composeSummary } from "../src/scorer"
import type { QuestionItem } from "../src/types/domain"
import type { UnifiedSession } from "../src/types/memorybench"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..")
const RESULTS_DIR = join(REPO_ROOT, "results")
const DATA_DIR = join(REPO_ROOT, "datasets", "customer-records-v1")

function extractCanonicalNames(sessions: UnifiedSession[]): string[] {
  const names = new Set<string>()
  for (const s of sessions) {
    for (const m of s.messages) {
      for (const line of m.content.split("\n")) {
        const csv = line.match(/^([A-Z][a-zA-ZÀ-ÿ'-]+ [A-Z][a-zA-ZÀ-ÿ'-]+),/)
        if (csv) names.add(csv[1])
        const sent = line.match(/^\s*•?\s*([A-Z][a-zA-ZÀ-ÿ'-]+ [A-Z][a-zA-ZÀ-ÿ'-]+)\b/)
        if (sent) names.add(sent[1])
      }
    }
  }
  return [...names]
}

function main() {
  const questions = JSON.parse(readFileSync(join(DATA_DIR, "questions.json"), "utf8")) as QuestionItem[]
  const sessions = JSON.parse(readFileSync(join(DATA_DIR, "sessions.json"), "utf8")) as UnifiedSession[]
  const canonical = extractCanonicalNames(sessions)
  const byQid = new Map(questions.map((q) => [q.questionId, q]))

  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json") && !f.endsWith(".bak.json"))

  for (const f of files) {
    const path = join(RESULTS_DIR, f)
    const payload = JSON.parse(readFileSync(path, "utf8")) as {
      provider: string
      summary: { composite: number }
      results: Array<{ questionId: string; response: string; score: { score: number } }>
    }
    if (!payload.results || payload.results.length === 0) continue

    const oldComposite = payload.summary?.composite ?? 0
    let flippedToCorrect = 0
    const reScored = []
    for (const r of payload.results) {
      const q = byQid.get(r.questionId)
      if (!q) continue
      const oldScore = r.score.score
      const newScore = scoreResponse(r.response, q.groundTruth, canonical)
      if ((oldScore ?? 0) === 0 && newScore.score > 0) flippedToCorrect++
      reScored.push({ question: q, score: newScore })
      ;(r as unknown as { score: unknown }).score = newScore
    }
    const summary = composeSummary(reScored)
    payload.summary = summary as unknown as typeof payload.summary
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", "utf8")

    const delta = summary.composite - oldComposite
    console.log(
      `${payload.provider.padEnd(22)}  old=${oldComposite.toFixed(3)}  new=${summary.composite.toFixed(3)}  Δ=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}  flipped=${flippedToCorrect}`
    )
  }
}

main()
