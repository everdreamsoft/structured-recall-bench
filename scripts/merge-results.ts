#!/usr/bin/env bun
/**
 * Merge base (100Q) and hard (30Q) result files per provider into a single
 * 130Q archive. The composite is recomputed via composeSummary over all
 * 8 question classes.
 *
 * Input:  results/YYYY-MM-DD_<provider>_seed42.json       (100Q base)
 *         results/YYYY-MM-DD_<provider>_seed42_hard.json  (30Q hard)
 *
 * Output: results/YYYY-MM-DD_<provider>_seed42_130q.json  (merged)
 */

import { readFileSync, writeFileSync, readdirSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

import { composeSummary } from "../src/scorer"
import type { QuestionItem, ScoreResult } from "../src/types/domain"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..")
const RESULTS_DIR = join(REPO_ROOT, "results")
const DATA_DIR = join(REPO_ROOT, "datasets", "customer-records-v1")

interface ResultRow {
  questionId: string
  questionClass: string
  response: string
  score: ScoreResult
  searchMs: number
  answerMs: number
}

interface ResultsPayload {
  provider: string
  benchmark?: string
  dataset?: string
  seed?: number
  model?: string
  timestamp?: string
  summary: { composite: number; perClass: Record<string, { count: number; mean: number }> }
  results: ResultRow[]
}

function main() {
  const questions = JSON.parse(readFileSync(join(DATA_DIR, "questions.json"), "utf8")) as QuestionItem[]
  const qById = new Map(questions.map((q) => [q.questionId, q]))

  const baseFiles = readdirSync(RESULTS_DIR).filter(
    (f) => f.endsWith("_seed42.json") && !f.includes("_hard") && !f.includes("_130q")
  )

  console.log(
    `${"provider".padEnd(22)}  ${"base".padStart(5)}  ${"hard".padStart(5)}  ${"merged".padStart(6)}  ${"composite".padStart(9)}`
  )
  console.log(`${"-".repeat(22)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(6)}  ${"-".repeat(9)}`)

  for (const base of baseFiles) {
    const hard = base.replace("_seed42.json", "_seed42_hard.json")
    const basePath = join(RESULTS_DIR, base)
    const hardPath = join(RESULTS_DIR, hard)

    const baseData = JSON.parse(readFileSync(basePath, "utf8")) as ResultsPayload
    let hardData: ResultsPayload | null = null
    try {
      hardData = JSON.parse(readFileSync(hardPath, "utf8")) as ResultsPayload
    } catch {
      // No hard file — provider wasn't run on tier 2/3 yet.
    }

    const allResults: ResultRow[] = [...(baseData.results ?? [])]
    if (hardData) {
      // Deduplicate by questionId: hard wins if collision (shouldn't happen
      // because classes don't overlap, but defensive).
      const seen = new Set(allResults.map((r) => r.questionId))
      for (const r of hardData.results ?? []) {
        if (seen.has(r.questionId)) continue
        allResults.push(r)
        seen.add(r.questionId)
      }
    }

    const forSummary = allResults
      .map((r) => ({ question: qById.get(r.questionId)!, score: r.score }))
      .filter((x) => x.question != null)
    const summary = composeSummary(forSummary)

    const merged: ResultsPayload = {
      ...baseData,
      provider: baseData.provider,
      summary: summary as ResultsPayload["summary"],
      results: allResults,
    }

    const outPath = basePath.replace("_seed42.json", "_seed42_130q.json")
    writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n", "utf8")

    console.log(
      `${baseData.provider.padEnd(22)}  ${String(baseData.results?.length ?? 0).padStart(5)}  ${String(hardData?.results?.length ?? 0).padStart(5)}  ${String(allResults.length).padStart(6)}  ${summary.composite.toFixed(3).padStart(9)}`
    )
  }
}

main()
