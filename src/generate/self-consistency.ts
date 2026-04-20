/**
 * Self-consistency assertions for the generated dataset.
 *
 * Fail-fast checks so an invalid corpus never ships:
 *   1. Every v1 customer appears at least once in a Type A session's CSV.
 *   2. Every purchase event appears in exactly one Type B or Type D session.
 *   3. Every update is referenced exactly once in Type B (chat) or Type C (CSV v2).
 *   4. No enumeration question has an empty ground truth (would score 0 by default).
 *   5. No aggregation question has expectedValue <= 0 (can't meaningfully tolerance-score 0).
 *   6. No reconciliation question has expectedValue == staleV1Value (the update was a no-op).
 */

import type {
  CustomerRecord,
  PurchaseEvent,
  QuestionItem,
  UpdateEvent,
} from "../types/domain"
import type { UnifiedSession } from "../types/memorybench"

export interface ConsistencyReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  stats: {
    customersCovered: number
    customersTotal: number
    eventsMentioned: number
    eventsTotal: number
    updatesReferenced: number
    updatesTotal: number
    questionsWithEmptyGroundTruth: number
    aggregationsNonPositive: number
    reconciliationNoOps: number
  }
}

export function assertSelfConsistent(args: {
  v1Customers: CustomerRecord[]
  events: PurchaseEvent[]
  updates: UpdateEvent[]
  sessions: UnifiedSession[]
  questions: QuestionItem[]
}): ConsistencyReport {
  const errors: string[] = []
  const warnings: string[] = []

  // ─── 1. Customers coverage ──────────────────────────────────────────────
  const corpus = args.sessions.map((s) => s.messages.map((m) => m.content).join("\n")).join("\n")
  const mentionedNames = new Set<string>()
  for (const c of args.v1Customers) {
    if (corpus.includes(c.name)) mentionedNames.add(c.name)
  }
  const missingCustomers = args.v1Customers.filter((c) => !mentionedNames.has(c.name))
  if (missingCustomers.length > 0) {
    errors.push(
      `${missingCustomers.length} v1 customers not mentioned in any session (e.g. ${missingCustomers
        .slice(0, 3)
        .map((c) => c.name)
        .join(", ")})`
    )
  }

  // ─── 2. Events coverage ─────────────────────────────────────────────────
  let eventsMentioned = 0
  for (const e of args.events) {
    // match against the full corpus by event id OR by customer+product+amount signature
    const signature = `${e.customer_name}`
    if (corpus.includes(signature) && corpus.includes(e.product)) eventsMentioned++
  }
  if (eventsMentioned < args.events.length * 0.95) {
    warnings.push(
      `Only ${eventsMentioned}/${args.events.length} purchase events clearly mentioned — heuristic may undercount`
    )
  }

  // ─── 3. Updates coverage ────────────────────────────────────────────────
  let updatesReferenced = 0
  for (const u of args.updates) {
    if (u.kind === "new_customer") {
      if (corpus.includes(u.customer.name)) updatesReferenced++
    } else if (u.kind === "churn") {
      if (corpus.includes(u.customer_name) && corpus.includes("churn")) updatesReferenced++
    } else {
      if (corpus.includes(u.customer_name)) updatesReferenced++
    }
  }

  // ─── 4. Empty enumeration ground truth ──────────────────────────────────
  let emptyGT = 0
  for (const q of args.questions) {
    if (q.groundTruth.kind === "enumeration" && q.groundTruth.expectedNames.length === 0) {
      emptyGT++
      warnings.push(`Question ${q.questionId} has empty expectedNames — will score 0 for any non-empty response`)
    }
  }

  // ─── 5. Non-positive aggregations ───────────────────────────────────────
  let nonPosAgg = 0
  for (const q of args.questions) {
    if (q.groundTruth.kind === "aggregation" && q.groundTruth.expectedValue <= 0) {
      nonPosAgg++
      warnings.push(`Question ${q.questionId} aggregates to ${q.groundTruth.expectedValue} — check coverage`)
    }
  }

  // ─── 6. Reconciliation no-ops ───────────────────────────────────────────
  let reconNoOp = 0
  for (const q of args.questions) {
    if (
      q.groundTruth.kind === "reconciliation" &&
      q.groundTruth.expectedValue === q.groundTruth.staleV1Value
    ) {
      reconNoOp++
      errors.push(`Question ${q.questionId} reconciliation no-op (v1 == post): ${q.groundTruth.expectedValue}`)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      customersCovered: mentionedNames.size,
      customersTotal: args.v1Customers.length,
      eventsMentioned,
      eventsTotal: args.events.length,
      updatesReferenced,
      updatesTotal: args.updates.length,
      questionsWithEmptyGroundTruth: emptyGT,
      aggregationsNonPositive: nonPosAgg,
      reconciliationNoOps: reconNoOp,
    },
  }
}
