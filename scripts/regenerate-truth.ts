#!/usr/bin/env bun
/**
 * Standalone validator: re-runs the self-consistency check against the
 * currently checked-in dataset without regenerating anything. Useful in CI
 * and as a post-edit sanity guard.
 *
 * Exit code 0 = consistent, 1 = errors found, 2 = dataset missing.
 */

import { existsSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

import { assertSelfConsistent } from "../src/generate/self-consistency"
import type {
  CustomerRecord,
  PurchaseEvent,
  QuestionItem,
  UnifiedTruth,
  UpdateEvent,
} from "../src/types/domain"
import type { UnifiedSession } from "../src/types/memorybench"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const DATA_DIR = resolve(__dirname, "..", "datasets", "customer-records-v1")

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function main() {
  const truthPath = join(DATA_DIR, "truth.json")
  const sessionsPath = join(DATA_DIR, "sessions.json")
  const questionsPath = join(DATA_DIR, "questions.json")

  for (const p of [truthPath, sessionsPath, questionsPath]) {
    if (!existsSync(p)) {
      console.error(`[validate] missing ${p} — run 'bun run generate' first.`)
      process.exit(2)
    }
  }

  const truth = readJson<UnifiedTruth>(truthPath)
  const sessions = readJson<UnifiedSession[]>(sessionsPath)
  const questions = readJson<QuestionItem[]>(questionsPath)

  // Reconstruct v1/events/updates isn't possible from truth alone (truth is
  // post-update). For a full validation, the generator should be re-run.
  // Here we do a lighter check: sessions/questions structural integrity.
  const lightReport = {
    sessions: sessions.length,
    questions: questions.length,
    byClass: questions.reduce<Record<string, number>>((acc, q) => {
      acc[q.questionClass] = (acc[q.questionClass] || 0) + 1
      return acc
    }, {}),
    truthCustomers: truth.customers.length,
    truthEvents: truth.events.length,
  }

  console.log(`[validate] light structural check`)
  console.log(`            ${JSON.stringify(lightReport, null, 2)}`)

  // Run the cross-check with the data we have: treat truth.customers as v1
  // (approximation — the real v1 was pre-update, but this still catches most
  // structural errors like dangling names or empty ground truth).
  const report = assertSelfConsistent({
    v1Customers: truth.customers,
    events: truth.events,
    updates: [] as UpdateEvent[], // not stored in dataset; accept the coverage gap
    sessions,
    questions,
  })

  console.log(`[validate] ok=${report.ok}`)
  console.log(`            stats=${JSON.stringify(report.stats)}`)
  if (report.warnings.length > 0) {
    console.log(`[validate] warnings:`)
    for (const w of report.warnings.slice(0, 15)) console.log(`            - ${w}`)
  }
  if (!report.ok) {
    console.error(`[validate] ERRORS:`)
    for (const e of report.errors) console.error(`            - ${e}`)
    process.exit(1)
  }
}

main()
