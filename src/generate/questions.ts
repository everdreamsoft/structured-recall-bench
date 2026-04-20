/**
 * Deterministic question + ground truth generation.
 *
 * 5 classes × 20 questions = 100 total.
 *
 * Each question's ground truth is computed from UnifiedTruth + events +
 * updates. The scoring layer then matches the LLM response against this
 * ground truth (see src/scorer.ts).
 */

import { Faker, en } from "@faker-js/faker"
import { COUNTRIES, INDUSTRIES } from "./customers"
import { PRODUCTS } from "./events"
import type {
  CustomerRecord,
  PurchaseEvent,
  QuestionItem,
  UnifiedTruth,
  UpdateEvent,
} from "../types/domain"

interface BuildQuestionsInput {
  truth: UnifiedTruth
  v1Customers: CustomerRecord[]
  events: PurchaseEvent[]
  updates: UpdateEvent[]
  allSessionIds: string[]
  seed: number
}

export function buildQuestions(input: BuildQuestionsInput): QuestionItem[] {
  const faker = new Faker({ locale: [en], seed: input.seed + 1000 })
  const q: QuestionItem[] = []

  q.push(...buildEnumerationCsv(input, faker))
  q.push(...buildEnumerationChat(input, faker))
  q.push(...buildAggregationCrossSource(input, faker))
  q.push(...buildReconciliationUpdate(input, faker))
  q.push(...buildMixedConditional(input, faker))

  return q
}

// ─── Class 1: enumeration_csv ──────────────────────────────────────────────

function buildEnumerationCsv(input: BuildQuestionsInput, faker: Faker): QuestionItem[] {
  const { truth, allSessionIds } = input
  const out: QuestionItem[] = []

  // 10 by (country, status)
  const countryStatusPairs: Array<[string, CustomerRecord["status"]]> = []
  for (const country of pickN(COUNTRIES as readonly string[], 10, faker)) {
    const status: CustomerRecord["status"] = faker.helpers.arrayElement([
      "active",
      "prospect",
      "churned",
    ] as const)
    countryStatusPairs.push([country, status])
  }

  for (const [country, status] of countryStatusPairs) {
    const expected = truth.customers
      .filter((c) => c.country === country && c.status === status)
      .map((c) => c.name)
      .sort()
    out.push(makeEnumerationQ(
      `ecsv-country-${slug(country)}-${status}`,
      `List the names of all ${status} customers from ${country}.`,
      expected,
      allSessionIds
    ))
  }

  // 10 by (industry, status)
  const industryStatusPairs: Array<[string, CustomerRecord["status"]]> = []
  for (const industry of pickN(INDUSTRIES as readonly string[], 10, faker)) {
    const status: CustomerRecord["status"] = faker.helpers.arrayElement([
      "active",
      "prospect",
      "churned",
    ] as const)
    industryStatusPairs.push([industry, status])
  }

  for (const [industry, status] of industryStatusPairs) {
    const expected = truth.customers
      .filter((c) => c.industry === industry && c.status === status)
      .map((c) => c.name)
      .sort()
    out.push(makeEnumerationQ(
      `ecsv-industry-${slug(industry)}-${status}`,
      `List the names of all ${status} customers in the ${industry} industry.`,
      expected,
      allSessionIds
    ))
  }

  return out.slice(0, 20)
}

// ─── Class 2: enumeration_chat ─────────────────────────────────────────────

function buildEnumerationChat(input: BuildQuestionsInput, faker: Faker): QuestionItem[] {
  const { events, allSessionIds } = input
  const out: QuestionItem[] = []

  // 10 by product
  for (const product of PRODUCTS) {
    const expected = [
      ...new Set(events.filter((e) => e.product === product).map((e) => e.customer_name)),
    ].sort()
    out.push(makeEnumerationQ(
      `echat-product-${slug(product)}`,
      `Which customers bought ${product} from us in 2025, based on purchase activity we discussed in chat?`,
      expected,
      allSessionIds
    ))
  }

  // 10 by month (pick 10 months from 2025-01 to 2025-10)
  const months = [
    "2025-01",
    "2025-02",
    "2025-03",
    "2025-04",
    "2025-05",
    "2025-06",
    "2025-07",
    "2025-08",
    "2025-09",
    "2025-10",
  ]
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
  ]
  for (let i = 0; i < 10; i++) {
    const m = months[i]
    const label = `${monthNames[i]} 2025`
    const expected = [
      ...new Set(events.filter((e) => e.date.startsWith(m)).map((e) => e.customer_name)),
    ].sort()
    out.push(makeEnumerationQ(
      `echat-month-${m}`,
      `Which customers made purchases in ${label}, according to the activity reports?`,
      expected,
      allSessionIds
    ))
  }

  return out.slice(0, 20)
}

// ─── Class 3: aggregation_cross_source ─────────────────────────────────────

function buildAggregationCrossSource(
  input: BuildQuestionsInput,
  faker: Faker
): QuestionItem[] {
  const { truth, events, allSessionIds } = input
  const out: QuestionItem[] = []

  // 10 by country: sum of event amounts for customers with that country
  const countriesToUse = pickN(COUNTRIES as readonly string[], 10, faker)
  for (const country of countriesToUse) {
    const customersInCountry = new Set(
      truth.customers.filter((c) => c.country === country).map((c) => c.name)
    )
    const total = events
      .filter((e) => customersInCountry.has(e.customer_name))
      .reduce((s, e) => s + e.amount_usd, 0)
    out.push({
      questionId: `agg-country-${slug(country)}`,
      question: `What is the total amount (in USD) of all purchases in 2025 from customers based in ${country}? Consider all customers in that country and sum their purchase activity.`,
      questionClass: "aggregation_cross_source",
      groundTruth: {
        kind: "aggregation",
        expectedValue: total,
        unit: "usd",
        toleranceRelative: 0.1,
      },
      haystackSessionIds: allSessionIds,
    })
  }

  // 10 by industry
  const industriesToUse = INDUSTRIES.slice(0, 10)
  for (const industry of industriesToUse) {
    const customersInIndustry = new Set(
      truth.customers.filter((c) => c.industry === industry).map((c) => c.name)
    )
    const total = events
      .filter((e) => customersInIndustry.has(e.customer_name))
      .reduce((s, e) => s + e.amount_usd, 0)
    out.push({
      questionId: `agg-industry-${slug(industry)}`,
      question: `What is the total purchase amount (in USD) in 2025 from customers in the ${industry} industry? Sum across every customer we have in that industry.`,
      questionClass: "aggregation_cross_source",
      groundTruth: {
        kind: "aggregation",
        expectedValue: total,
        unit: "usd",
        toleranceRelative: 0.1,
      },
      haystackSessionIds: allSessionIds,
    })
  }

  return out.slice(0, 20)
}

// ─── Class 4: reconciliation_update ────────────────────────────────────────

function buildReconciliationUpdate(
  input: BuildQuestionsInput,
  faker: Faker
): QuestionItem[] {
  const { v1Customers, updates, truth, allSessionIds } = input
  const v1ByName = new Map(v1Customers.map((c) => [c.name, c] as const))
  const currentByName = new Map(truth.customers.map((c) => [c.name, c] as const))

  // Only customer_field updates qualify (churn changes status to "churned" but
  // that's also reconcilable; we'll focus on field updates for clarity).
  const fieldUpdates = updates.filter(
    (u): u is Extract<UpdateEvent, { kind: "customer_field" }> => u.kind === "customer_field"
  )

  // Pick 20 distinct field updates (one per customer+field). Sort by id for
  // determinism, then take first 20.
  const picked: typeof fieldUpdates = []
  const seen = new Set<string>()
  for (const u of fieldUpdates) {
    const key = `${u.customer_name}|${u.field}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push(u)
    if (picked.length >= 20) break
  }

  const out: QuestionItem[] = []
  for (const u of picked) {
    const v1 = v1ByName.get(u.customer_name)
    const current = currentByName.get(u.customer_name)
    if (!v1 || !current) continue

    const currentVal = String(current[u.field as keyof CustomerRecord])
    const v1Val = String(v1[u.field as keyof CustomerRecord])

    const fieldLabel =
      u.field === "annual_revenue_usd"
        ? "annual revenue (in USD)"
        : u.field === "employees"
          ? "employee count"
          : u.field

    out.push({
      questionId: `recon-${slug(u.customer_name)}-${u.field}`,
      question: `What is ${u.customer_name}'s current ${fieldLabel}? Use the most recent information available.`,
      questionClass: "reconciliation_update",
      groundTruth: {
        kind: "reconciliation",
        expectedValue: currentVal,
        staleV1Value: v1Val,
        field: u.field,
        customer_name: u.customer_name,
      },
      haystackSessionIds: allSessionIds,
    })
  }

  return out.slice(0, 20)
}

// ─── Class 5: mixed_conditional ────────────────────────────────────────────

function buildMixedConditional(input: BuildQuestionsInput, faker: Faker): QuestionItem[] {
  const { truth, events, allSessionIds } = input
  const out: QuestionItem[] = []

  const spendByCustomer = new Map<string, number>()
  for (const e of events) {
    spendByCustomer.set(e.customer_name, (spendByCustomer.get(e.customer_name) || 0) + e.amount_usd)
  }

  // Top-spender by country — pick 10 countries with at least 2 customers that have spend
  const countryCandidates = (COUNTRIES as readonly string[]).filter((country) => {
    const names = truth.customers.filter((c) => c.country === country).map((c) => c.name)
    const withSpend = names.filter((n) => spendByCustomer.has(n))
    return withSpend.length >= 2
  })
  for (const country of countryCandidates.slice(0, 10)) {
    const candidates = truth.customers
      .filter((c) => c.country === country)
      .map((c) => ({ name: c.name, spend: spendByCustomer.get(c.name) || 0 }))
      .filter((x) => x.spend > 0)
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

    if (candidates.length === 0) continue
    out.push({
      questionId: `mixed-country-top-${slug(country)}`,
      question: `Who is our top-spending customer based in ${country} for 2025, combining all their purchase activity?`,
      questionClass: "mixed_conditional",
      groundTruth: { kind: "mixed_conditional", expectedName: candidates[0].name },
      haystackSessionIds: allSessionIds,
    })
  }

  // Top-spender by industry — pick 10
  for (const industry of INDUSTRIES.slice(0, 10)) {
    const candidates = truth.customers
      .filter((c) => c.industry === industry)
      .map((c) => ({ name: c.name, spend: spendByCustomer.get(c.name) || 0 }))
      .filter((x) => x.spend > 0)
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))

    if (candidates.length === 0) continue
    out.push({
      questionId: `mixed-industry-top-${slug(industry)}`,
      question: `Who is the highest-spending customer in the ${industry} industry for 2025, summing across all their 2025 orders?`,
      questionClass: "mixed_conditional",
      groundTruth: { kind: "mixed_conditional", expectedName: candidates[0].name },
      haystackSessionIds: allSessionIds,
    })
  }

  return out.slice(0, 20)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEnumerationQ(
  id: string,
  question: string,
  expectedNames: string[],
  allSessionIds: string[]
): QuestionItem {
  return {
    questionId: id,
    question,
    questionClass: question.toLowerCase().includes("purchase") || question.toLowerCase().includes("bought")
      ? "enumeration_chat"
      : "enumeration_csv",
    groundTruth: { kind: "enumeration", expectedNames },
    haystackSessionIds: allSessionIds,
  }
}

function pickN<T>(arr: readonly T[], n: number, faker: Faker): T[] {
  const copy = [...arr]
  const out: T[] = []
  while (out.length < n && copy.length > 0) {
    const idx = faker.number.int({ min: 0, max: copy.length - 1 })
    out.push(copy.splice(idx, 1)[0])
  }
  return out
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}
