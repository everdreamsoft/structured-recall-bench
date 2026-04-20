#!/usr/bin/env bun
/**
 * Generator orchestrator — `bun run generate`.
 *
 * Produces three artifacts in datasets/customer-records-v1/:
 *   truth.json      — unified final state (customers + events + metadata)
 *   sessions.json   — UnifiedSession[] pre-generated, ordered by date
 *   questions.json  — 100 questions + deterministic ground truth
 *
 * All outputs are byte-reproducible: running `bun run generate` twice
 * yields identical files. CI can verify with `git diff --exit-code datasets/`.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"
import { fileURLToPath } from "url"
import { dirname, resolve } from "path"

import { generateCustomers } from "./customers"
import { generatePurchaseEvents } from "./events"
import { generateUpdates } from "./updates"
import { buildUnifiedTruth } from "./unified-truth"
import { synthesizeSessions } from "./sessions"
import { buildQuestions } from "./questions"
import { assertSelfConsistent } from "./self-consistency"

const SEED = 42
const CUSTOMER_COUNT = 500
const EVENT_COUNT = 200
const UPDATE_COUNT = 50

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "../..")
const OUT_DIR = join(REPO_ROOT, "datasets", "customer-records-v1")

function main() {
  console.log(`[generate] seed=${SEED} customers=${CUSTOMER_COUNT} events=${EVENT_COUNT} updates=${UPDATE_COUNT}`)

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  // Each generator gets a derived sub-seed so independent invocations remain
  // reproducible even if the call order changes.
  const v1Customers = generateCustomers(SEED, CUSTOMER_COUNT)
  console.log(`[generate] v1 customers: ${v1Customers.length}`)

  const events = generatePurchaseEvents(v1Customers, SEED + 1, EVENT_COUNT)
  console.log(`[generate] purchase events: ${events.length}`)

  const updates = generateUpdates(v1Customers, SEED + 2, UPDATE_COUNT)
  console.log(`[generate] updates: ${updates.length}`)

  const truth = buildUnifiedTruth(v1Customers, events, updates, SEED)
  const truthStamped = { ...truth, generatedAt: "seed=42" }
  console.log(
    `[generate] unified truth: ${truth.customers.length} customers (v1=${v1Customers.length}, applied ${truth.updatesApplied} updates)`
  )

  const sessions = synthesizeSessions({ v1Customers, events, updates, seed: SEED + 3 })
  console.log(`[generate] sessions: ${sessions.length}`)

  const allSessionIds = sessions.map((s) => s.sessionId)
  const questions = buildQuestions({
    truth,
    v1Customers,
    events,
    updates,
    allSessionIds,
    seed: SEED,
  })
  console.log(`[generate] questions: ${questions.length}`)

  // Self-consistency
  const report = assertSelfConsistent({ v1Customers, events, updates, sessions, questions })
  console.log(`[generate] consistency: ok=${report.ok}`)
  console.log(`            stats=${JSON.stringify(report.stats)}`)
  if (report.warnings.length > 0) {
    console.log(`[generate] warnings:`)
    for (const w of report.warnings.slice(0, 10)) console.log(`            - ${w}`)
    if (report.warnings.length > 10) console.log(`            (+${report.warnings.length - 10} more)`)
  }
  if (!report.ok) {
    console.error(`[generate] ERRORS:`)
    for (const e of report.errors) console.error(`            - ${e}`)
    process.exit(1)
  }

  // Write artifacts (stable JSON formatting: 2-space indent, trailing newline)
  writeJsonStable(join(OUT_DIR, "truth.json"), truthStamped)
  writeJsonStable(join(OUT_DIR, "sessions.json"), sessions)
  writeJsonStable(join(OUT_DIR, "questions.json"), questions)
  writeFileSync(join(OUT_DIR, "seed.txt"), `${SEED}\n`, "utf8")

  // Per-class question counts for sanity
  const byClass = questions.reduce<Record<string, number>>((acc, q) => {
    acc[q.questionClass] = (acc[q.questionClass] || 0) + 1
    return acc
  }, {})
  console.log(`[generate] questions by class: ${JSON.stringify(byClass)}`)

  console.log(`[generate] wrote ${OUT_DIR}`)
}

function writeJsonStable(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8")
}

main()
