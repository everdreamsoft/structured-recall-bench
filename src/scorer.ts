/**
 * Deterministic scoring — no LLM-judge involvement.
 *
 * Each scorer takes the LLM response (free-form string) and the ground truth
 * structure, and returns a typed ScoreResult. Composite is the mean of the
 * per-class averages.
 */

import type {
  AggregationGroundTruth,
  AggregationScore,
  EnumerationGroundTruth,
  EnumerationScore,
  GroundTruthItem,
  MixedConditionalGroundTruth,
  MixedConditionalScore,
  ReconciliationGroundTruth,
  ReconciliationScore,
  ScoreResult,
  QuestionClass,
  QuestionItem,
} from "./types/domain"
import { containsValue, extractFirstNumber, extractMatchedNames, normalizeName } from "./utils/parse"

export function scoreResponse(
  response: string,
  gt: GroundTruthItem,
  canonicalNames: string[]
): ScoreResult {
  switch (gt.kind) {
    case "enumeration":
      return scoreEnumeration(response, gt, canonicalNames)
    case "aggregation":
      return scoreAggregation(response, gt)
    case "reconciliation":
      return scoreReconciliation(response, gt)
    case "mixed_conditional":
      return scoreMixedConditional(response, gt, canonicalNames)
  }
}

function scoreEnumeration(
  response: string,
  gt: EnumerationGroundTruth,
  canonicalNames: string[]
): EnumerationScore {
  const expectedSet = new Set(gt.expectedNames)
  // Match against ALL known customer names to distinguish false positives from
  // unrecognized tokens.
  const detected = extractMatchedNames(response, canonicalNames)

  const matchedCorrect: string[] = []
  const falsePositives: string[] = []
  for (const name of detected) {
    if (expectedSet.has(name)) matchedCorrect.push(name)
    else falsePositives.push(name)
  }
  const missed = gt.expectedNames.filter((n) => !detected.has(n))

  const tp = matchedCorrect.length
  const fp = falsePositives.length
  const fn = missed.length

  // Perfect-empty case: expected set is empty AND response mentioned no customers.
  // This is a correct "none" answer — score 1, not 0.
  if (tp === 0 && fp === 0 && fn === 0) {
    return {
      kind: "enumeration",
      precision: 1,
      recall: 1,
      f1: 1,
      score: 1,
      matchedCorrect: [],
      missed: [],
      falsePositives: [],
    }
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp) // no predictions → vacuously perfect precision
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn) // no expected → vacuously perfect recall
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    kind: "enumeration",
    precision,
    recall,
    f1,
    score: f1,
    matchedCorrect,
    missed,
    falsePositives,
  }
}

function scoreAggregation(response: string, gt: AggregationGroundTruth): AggregationScore {
  const extracted = extractFirstNumber(response)
  if (extracted === null) {
    return {
      kind: "aggregation",
      extracted: null,
      expected: gt.expectedValue,
      relativeDelta: null,
      score: 0,
      note: "no number extracted",
    }
  }
  if (gt.expectedValue === 0) {
    return {
      kind: "aggregation",
      extracted,
      expected: 0,
      relativeDelta: extracted === 0 ? 0 : 1,
      score: extracted === 0 ? 1 : 0,
    }
  }
  const delta = Math.abs(extracted - gt.expectedValue) / Math.abs(gt.expectedValue)
  // Continuous scoring: score = max(0, 1 - delta). Captures how close the
  // answer is rather than pass/fail. A top-K retriever that only sees 30%
  // of the haystack will typically have delta > 0.5 → score < 0.5. A
  // structured system sees all the data → delta near 0 → score near 1.
  // Legacy `toleranceRelative` kept for backwards compat; a binary pass
  // flag is derivable from score >= (1 - tolerance).
  const score = Math.max(0, 1 - delta)
  return {
    kind: "aggregation",
    extracted,
    expected: gt.expectedValue,
    relativeDelta: delta,
    score,
  }
}

function scoreReconciliation(response: string, gt: ReconciliationGroundTruth): ReconciliationScore {
  if (!response.trim()) {
    return {
      kind: "reconciliation",
      extracted: null,
      expected: gt.expectedValue,
      staleV1: gt.staleV1Value,
      score: 0,
      category: "no-answer",
    }
  }

  // For numeric fields, compare numerically with small tolerance
  if (gt.field === "employees" || gt.field === "annual_revenue_usd") {
    const extractedNum = extractFirstNumber(response)
    const expectedNum = Number(gt.expectedValue)
    const staleNum = Number(gt.staleV1Value)
    if (extractedNum === null) {
      return {
        kind: "reconciliation",
        extracted: null,
        expected: gt.expectedValue,
        staleV1: gt.staleV1Value,
        score: 0,
        category: "no-answer",
      }
    }
    const denom = Math.max(1, Math.abs(expectedNum))
    const relToExpected = Math.abs(extractedNum - expectedNum) / denom
    const relToStale =
      staleNum === 0 ? (extractedNum === 0 ? 0 : 1) : Math.abs(extractedNum - staleNum) / Math.abs(staleNum)

    if (relToExpected <= 0.01) {
      return {
        kind: "reconciliation",
        extracted: String(extractedNum),
        expected: gt.expectedValue,
        staleV1: gt.staleV1Value,
        score: 1,
        category: "correct",
      }
    }
    if (relToStale <= 0.01) {
      return {
        kind: "reconciliation",
        extracted: String(extractedNum),
        expected: gt.expectedValue,
        staleV1: gt.staleV1Value,
        score: 0,
        category: "stale-v1",
      }
    }
    return {
      kind: "reconciliation",
      extracted: String(extractedNum),
      expected: gt.expectedValue,
      staleV1: gt.staleV1Value,
      score: 0,
      category: "wrong",
    }
  }

  // String fields (status, industry) — substring check after normalization
  const hitsExpected = containsValue(response, gt.expectedValue)
  const hitsStale = containsValue(response, gt.staleV1Value)

  if (hitsExpected && !hitsStale) {
    return {
      kind: "reconciliation",
      extracted: gt.expectedValue,
      expected: gt.expectedValue,
      staleV1: gt.staleV1Value,
      score: 1,
      category: "correct",
    }
  }
  if (hitsStale && !hitsExpected) {
    return {
      kind: "reconciliation",
      extracted: gt.staleV1Value,
      expected: gt.expectedValue,
      staleV1: gt.staleV1Value,
      score: 0,
      category: "stale-v1",
    }
  }
  if (hitsExpected && hitsStale) {
    // Response mentions both — ambiguous, score 0 (the LLM didn't commit to one)
    return {
      kind: "reconciliation",
      extracted: "ambiguous",
      expected: gt.expectedValue,
      staleV1: gt.staleV1Value,
      score: 0,
      category: "wrong",
    }
  }
  return {
    kind: "reconciliation",
    extracted: normalizeName(response).slice(0, 60) || null,
    expected: gt.expectedValue,
    staleV1: gt.staleV1Value,
    score: 0,
    category: "wrong",
  }
}

function scoreMixedConditional(
  response: string,
  gt: MixedConditionalGroundTruth,
  canonicalNames: string[]
): MixedConditionalScore {
  const detected = extractMatchedNames(response, canonicalNames)
  // Heuristic: if the expected name is detected and no other spurious name
  // dominates, count as correct. If multiple names detected, only correct when
  // the expected name is mentioned first.
  if (detected.has(gt.expectedName)) {
    // If another name is mentioned, check whether expected appears first in the
    // response (stricter) — otherwise still credit because the LLM might list
    // multiple candidates with the top answer.
    const firstCustomerIndex = Math.min(
      ...[...detected].map((n) => {
        const idx = normalizeName(response).indexOf(normalizeName(n))
        return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
      })
    )
    const expectedIndex = normalizeName(response).indexOf(normalizeName(gt.expectedName))
    if (expectedIndex !== -1 && expectedIndex === firstCustomerIndex) {
      return { kind: "mixed_conditional", extracted: gt.expectedName, expected: gt.expectedName, score: 1 }
    }
    // Mentioned but not the top pick
    return { kind: "mixed_conditional", extracted: gt.expectedName, expected: gt.expectedName, score: 0 }
  }
  return { kind: "mixed_conditional", extracted: null, expected: gt.expectedName, score: 0 }
}

// ─── Composite ───────────────────────────────────────────────────────────

export interface CompositeSummary {
  composite: number
  perClass: Record<QuestionClass, { count: number; mean: number }>
  reconciliationBreakdown: { correct: number; "stale-v1": number; wrong: number; "no-answer": number }
}

export function composeSummary(
  results: Array<{ question: QuestionItem; score: ScoreResult }>
): CompositeSummary {
  const byClass: Partial<Record<QuestionClass, number[]>> = {}
  const reconBreak = { correct: 0, "stale-v1": 0, wrong: 0, "no-answer": 0 }

  for (const { question, score } of results) {
    const arr = byClass[question.questionClass] ?? []
    arr.push(score.score)
    byClass[question.questionClass] = arr

    if (score.kind === "reconciliation") reconBreak[score.category]++
  }

  const perClass = {} as Record<QuestionClass, { count: number; mean: number }>
  for (const cls of [
    "enumeration_csv",
    "enumeration_chat",
    "aggregation_cross_source",
    "reconciliation_update",
    "mixed_conditional",
  ] as QuestionClass[]) {
    const scores = byClass[cls] ?? []
    perClass[cls] = {
      count: scores.length,
      mean: scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length,
    }
  }

  const nonEmpty = Object.values(perClass).filter((x) => x.count > 0)
  const composite =
    nonEmpty.length === 0 ? 0 : nonEmpty.reduce((a, b) => a + b.mean, 0) / nonEmpty.length

  return { composite, perClass, reconciliationBreakdown: reconBreak }
}
