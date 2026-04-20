/**
 * Domain types for the Structured Recall Bench dataset.
 *
 * The corpus is a synthetic CRM of ~500 customers with purchase events and
 * corrections spread across sessions. `UnifiedTruth` is the authoritative
 * post-reconciliation state used for scoring — computed deterministically
 * from (customers, events, updates) by src/generate/unified-truth.ts.
 */

export type CustomerStatus = "active" | "churned" | "prospect"

export interface CustomerRecord {
  name: string
  country: string
  industry: string
  annual_revenue_usd: number
  employees: number
  signup_date: string // ISO yyyy-mm-dd
  status: CustomerStatus
}

export interface PurchaseEvent {
  id: string
  customer_name: string
  product: string
  amount_usd: number
  date: string // ISO yyyy-mm-dd
}

/**
 * An update can target either a customer field (employee count, status,
 * revenue) or add a new purchase event. Applied in temporal order by
 * buildUnifiedTruth to derive the final state.
 */
export type UpdateEvent =
  | {
      kind: "customer_field"
      id: string
      date: string
      customer_name: string
      field: "status" | "employees" | "annual_revenue_usd" | "industry"
      new_value: string | number
    }
  | {
      kind: "new_customer"
      id: string
      date: string
      customer: CustomerRecord
    }
  | {
      kind: "churn"
      id: string
      date: string
      customer_name: string
    }

export interface UnifiedTruth {
  customers: CustomerRecord[] // final state after all updates
  events: PurchaseEvent[] // all purchase events (sorted by date)
  updatesApplied: number
  seed: number
  generatedAt: string
}

// ─── Questions & ground truth ────────────────────────────────────────────

export type QuestionClass =
  | "enumeration_csv"
  | "enumeration_chat"
  | "aggregation_cross_source"
  | "reconciliation_update"
  | "mixed_conditional"
  | "multi_condition_enum"
  | "multi_condition_agg"
  | "bootstrap_multihop"

export interface EnumerationGroundTruth {
  kind: "enumeration"
  expectedNames: string[] // canonical customer names
}

export interface AggregationGroundTruth {
  kind: "aggregation"
  expectedValue: number
  unit: "usd" | "count"
  toleranceRelative: number // e.g. 0.02 = ±2%
}

export interface ReconciliationGroundTruth {
  kind: "reconciliation"
  expectedValue: string // canonical string form ("450", "active", "Alice Dupont")
  staleV1Value: string // value from v1 that must NOT be answered
  field: "employees" | "status" | "annual_revenue_usd" | "industry"
  customer_name: string
}

export interface MixedConditionalGroundTruth {
  kind: "mixed_conditional"
  expectedName: string // single answer
}

export type GroundTruthItem =
  | EnumerationGroundTruth
  | AggregationGroundTruth
  | ReconciliationGroundTruth
  | MixedConditionalGroundTruth

export interface QuestionItem {
  questionId: string
  question: string
  questionClass: QuestionClass
  groundTruth: GroundTruthItem
  haystackSessionIds: string[] // always "all" in SRB, but stored explicitly for memorybench interface
}

// ─── Scoring ─────────────────────────────────────────────────────────────

export interface EnumerationScore {
  kind: "enumeration"
  precision: number
  recall: number
  f1: number
  score: number // = f1
  matchedCorrect: string[]
  missed: string[]
  falsePositives: string[]
}

export interface AggregationScore {
  kind: "aggregation"
  extracted: number | null
  expected: number
  relativeDelta: number | null
  /** Continuous score in [0, 1] = max(0, 1 - relativeDelta). */
  score: number
  note?: string
}

export interface ReconciliationScore {
  kind: "reconciliation"
  extracted: string | null
  expected: string
  staleV1: string
  score: 0 | 1
  category: "correct" | "stale-v1" | "wrong" | "no-answer"
}

export interface MixedConditionalScore {
  kind: "mixed_conditional"
  extracted: string | null
  expected: string
  score: 0 | 1
}

export type ScoreResult =
  | EnumerationScore
  | AggregationScore
  | ReconciliationScore
  | MixedConditionalScore
