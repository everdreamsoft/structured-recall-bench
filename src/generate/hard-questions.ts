/**
 * Hard tier questions — stacked-filter and cross-condition queries.
 *
 * Tier 2 "multi_condition": 4-6 stacked conditions per question, forcing
 * the planner to represent conjunctions beyond its basic (country,
 * industry, status) triad. Ground truth is computed deterministically
 * from the unified-truth state at generation time.
 *
 * These questions exist specifically to expose the ceiling of a
 * planner-based retrieval system. A planner with fixed schema can answer
 * them only if its schema includes all the filter fields in use; if it
 * doesn't, it must fall back (dump or refuse) and score poorly.
 */

import type {
  CustomerRecord,
  PurchaseEvent,
  QuestionItem,
  UnifiedTruth,
} from "../types/domain"
import { COUNTRIES, INDUSTRIES } from "./customers"
import { PRODUCTS } from "./events"

interface HardInput {
  truth: UnifiedTruth
  events: PurchaseEvent[]
  allSessionIds: string[]
  seed: number
}

/**
 * Generate ~20 multi-condition questions:
 *  • 10 multi_condition_enum — list customers matching N stacked filters
 *  • 10 multi_condition_agg  — sum spend for cohort matching N stacked filters
 */
export function buildHardQuestions(input: HardInput): QuestionItem[] {
  const out: QuestionItem[] = []

  // ─── 10 multi_condition_enum ─────────────────────────────────────────
  // Each spec stacks (country OR industry) + status + revenue threshold +
  // employees threshold [+ product bought]. Tuned so the expected answer
  // has between 1 and 10 matches — not trivial, not overwhelming.
  const enumSpecs: Array<{
    id: string
    question: string
    predicate: (c: CustomerRecord, customerEvents: PurchaseEvent[]) => boolean
  }> = [
    {
      id: "mc-enum-fr-fintech-active-500emp",
      question:
        "List active customers based in France in the Fintech industry with more than 500 employees.",
      predicate: (c) =>
        c.country === "France" &&
        c.industry === "Fintech" &&
        c.status === "active" &&
        c.employees > 500,
    },
    {
      id: "mc-enum-de-saas-active-rev5m",
      question:
        "List active customers from Germany in SaaS with annual revenue of at least $5,000,000.",
      predicate: (c) =>
        c.country === "Germany" &&
        c.industry === "SaaS" &&
        c.status === "active" &&
        c.annual_revenue_usd >= 5_000_000,
    },
    {
      id: "mc-enum-uk-manuf-active-100emp",
      question:
        "List active customers from the United Kingdom in Manufacturing with at least 100 employees.",
      predicate: (c) =>
        c.country === "United Kingdom" &&
        c.industry === "Manufacturing" &&
        c.status === "active" &&
        c.employees >= 100,
    },
    {
      id: "mc-enum-fr-active-signup-pre2023",
      question:
        "List active customers from France who signed up before 2023-01-01 and have more than 1000 employees.",
      predicate: (c) =>
        c.country === "France" &&
        c.status === "active" &&
        c.signup_date < "2023-01-01" &&
        c.employees > 1000,
    },
    {
      id: "mc-enum-it-prospects-small",
      question:
        "List prospects from Italy with fewer than 100 employees and annual revenue under $2,000,000.",
      predicate: (c) =>
        c.country === "Italy" &&
        c.status === "prospect" &&
        c.employees < 100 &&
        c.annual_revenue_usd < 2_000_000,
    },
    {
      id: "mc-enum-es-active-media-rev1m",
      question:
        "List active customers from Spain in the Media industry with revenue at least $1,000,000.",
      predicate: (c) =>
        c.country === "Spain" &&
        c.industry === "Media" &&
        c.status === "active" &&
        c.annual_revenue_usd >= 1_000_000,
    },
    {
      id: "mc-enum-us-fintech-churned",
      question:
        "List churned customers from the United States in the Fintech industry with more than 200 employees.",
      predicate: (c) =>
        c.country === "United States" &&
        c.industry === "Fintech" &&
        c.status === "churned" &&
        c.employees > 200,
    },
    {
      id: "mc-enum-jp-active-bought-hardware",
      question:
        "List active customers from Japan who purchased hardware.",
      predicate: (c, evs) =>
        c.country === "Japan" && c.status === "active" && evs.some((e) => e.product === "hardware"),
    },
    {
      id: "mc-enum-nl-active-signup-after-2022",
      question:
        "List active customers from the Netherlands who signed up on or after 2022-06-01 and have at least 300 employees.",
      predicate: (c) =>
        c.country === "Netherlands" &&
        c.status === "active" &&
        c.signup_date >= "2022-06-01" &&
        c.employees >= 300,
    },
    {
      id: "mc-enum-br-active-healthcare",
      question:
        "List active customers from Brazil in the Healthcare industry with revenue between $1,000,000 and $10,000,000.",
      predicate: (c) =>
        c.country === "Brazil" &&
        c.industry === "Healthcare" &&
        c.status === "active" &&
        c.annual_revenue_usd >= 1_000_000 &&
        c.annual_revenue_usd <= 10_000_000,
    },
  ]

  const eventsByCustomer = new Map<string, PurchaseEvent[]>()
  for (const e of input.events) {
    const arr = eventsByCustomer.get(e.customer_name) ?? []
    arr.push(e)
    eventsByCustomer.set(e.customer_name, arr)
  }

  for (const spec of enumSpecs) {
    const matches = input.truth.customers
      .filter((c) => spec.predicate(c, eventsByCustomer.get(c.name) ?? []))
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: spec.id,
      question: spec.question,
      questionClass: "multi_condition_enum",
      groundTruth: { kind: "enumeration", expectedNames: matches },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // ─── 10 multi_condition_agg ──────────────────────────────────────────
  const aggSpecs: Array<{
    id: string
    question: string
    predicate: (c: CustomerRecord, customerEvents: PurchaseEvent[]) => boolean
  }> = [
    {
      id: "mc-agg-fr-fintech-active",
      question:
        "What is the total purchase amount from active French customers in the Fintech industry?",
      predicate: (c) => c.country === "France" && c.industry === "Fintech" && c.status === "active",
    },
    {
      id: "mc-agg-de-saas-active-rev5m",
      question:
        "What is the total purchase amount from active German SaaS customers with revenue of at least $5,000,000?",
      predicate: (c) =>
        c.country === "Germany" &&
        c.industry === "SaaS" &&
        c.status === "active" &&
        c.annual_revenue_usd >= 5_000_000,
    },
    {
      id: "mc-agg-uk-active-500emp",
      question:
        "What is the total purchase amount from active UK customers with more than 500 employees?",
      predicate: (c) => c.country === "United Kingdom" && c.status === "active" && c.employees > 500,
    },
    {
      id: "mc-agg-us-fintech",
      question:
        "What is the total purchase amount from US Fintech customers in the Fintech industry (all statuses combined)?",
      predicate: (c) => c.country === "United States" && c.industry === "Fintech",
    },
    {
      id: "mc-agg-jp-active-signup-pre2023",
      question:
        "Total purchase amount from active Japanese customers who signed up before 2023-01-01.",
      predicate: (c) =>
        c.country === "Japan" && c.status === "active" && c.signup_date < "2023-01-01",
    },
    {
      id: "mc-agg-it-saas-active",
      question:
        "Total purchase amount from active Italian customers in the SaaS industry.",
      predicate: (c) => c.country === "Italy" && c.industry === "SaaS" && c.status === "active",
    },
    {
      id: "mc-agg-ca-active-rev1m",
      question:
        "Total purchase amount from active Canadian customers with revenue of at least $1,000,000.",
      predicate: (c) =>
        c.country === "Canada" && c.status === "active" && c.annual_revenue_usd >= 1_000_000,
    },
    {
      id: "mc-agg-au-retail-active",
      question:
        "Total purchase amount from active Australian customers in the Retail industry.",
      predicate: (c) => c.country === "Australia" && c.industry === "Retail" && c.status === "active",
    },
    {
      id: "mc-agg-se-active-100emp",
      question:
        "Total purchase amount from active Swedish customers with at least 100 employees.",
      predicate: (c) => c.country === "Sweden" && c.status === "active" && c.employees >= 100,
    },
    {
      id: "mc-agg-es-food-bev",
      question:
        "Total purchase amount from Spanish customers in the Food & Beverage industry (all statuses).",
      predicate: (c) => c.country === "Spain" && c.industry === "Food & Beverage",
    },
  ]

  for (const spec of aggSpecs) {
    const matchedNames = new Set(
      input.truth.customers
        .filter((c) => spec.predicate(c, eventsByCustomer.get(c.name) ?? []))
        .map((c) => c.name)
    )
    const total = input.events
      .filter((e) => matchedNames.has(e.customer_name))
      .reduce((s, e) => s + e.amount_usd, 0)
    out.push({
      questionId: spec.id,
      question: spec.question,
      questionClass: "multi_condition_agg",
      groundTruth: {
        kind: "aggregation",
        expectedValue: total,
        unit: "usd",
        toleranceRelative: 0.1,
      },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // ─── Tier 3 — bootstrap / multi-hop ──────────────────────────────────
  // Each question requires computing an intermediate value from one
  // query, then feeding it into a second query. The provider's planner
  // is intentionally NOT extended to chain plans — this is a capability
  // test of a real user-facing product. We expect Sandra to fall back
  // to its dump and let the answer LLM reason through it, so scores
  // will depend on LLM reasoning rather than planner exactness.
  out.push(...buildBootstrapQuestions(input, eventsByCustomer))

  return out
}

function buildBootstrapQuestions(
  input: HardInput,
  eventsByCustomer: Map<string, PurchaseEvent[]>
): QuestionItem[] {
  const out: QuestionItem[] = []
  const customers = input.truth.customers
  const events = input.events
  const byName = new Map(customers.map((c) => [c.name, c] as const))

  const spendByCustomer = new Map<string, number>()
  for (const e of events) {
    spendByCustomer.set(e.customer_name, (spendByCustomer.get(e.customer_name) ?? 0) + e.amount_usd)
  }

  const topSpenderIn = (predicate: (c: CustomerRecord) => boolean): string | null => {
    const ranked = customers
      .filter(predicate)
      .map((c) => ({ name: c.name, spend: spendByCustomer.get(c.name) ?? 0 }))
      .filter((x) => x.spend > 0)
      .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name))
    return ranked[0]?.name ?? null
  }

  // Q1: List customers sharing Priscilla Collins's country
  const priscilla = byName.get("Priscilla Collins")
  if (priscilla) {
    const expected = customers
      .filter((c) => c.country === priscilla.country && c.name !== priscilla.name)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-same-country-as-priscilla",
      question:
        "List the names of every customer based in the same country as Priscilla Collins (excluding Priscilla herself).",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q2: Total purchases from customers in the industry of the top French spender
  const topFr = topSpenderIn((c) => c.country === "France")
  if (topFr) {
    const industry = byName.get(topFr)!.industry
    const cohort = new Set(customers.filter((c) => c.industry === industry).map((c) => c.name))
    const total = events.filter((e) => cohort.has(e.customer_name)).reduce((s, e) => s + e.amount_usd, 0)
    out.push({
      questionId: "mh-spend-in-industry-of-top-fr",
      question:
        "What is the total purchase amount from every customer in the same industry as our top-spending customer based in France?",
      questionClass: "bootstrap_multihop",
      groundTruth: {
        kind: "aggregation",
        expectedValue: total,
        unit: "usd",
        toleranceRelative: 0.1,
      },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q3: Customers sharing the industry of the largest UK spender
  const topUk = topSpenderIn((c) => c.country === "United Kingdom")
  if (topUk) {
    const industry = byName.get(topUk)!.industry
    const expected = customers
      .filter((c) => c.industry === industry && c.name !== topUk)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-same-industry-as-top-uk",
      question:
        "Which customers work in the same industry as our highest-spending customer based in the United Kingdom (excluding them)?",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q4: Top 3 highest-spending customers overall
  const top3 = [...spendByCustomer.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([n]) => n)
    .sort()
  out.push({
    questionId: "mh-top3-overall",
    question:
      "Who are the 3 highest-spending customers overall (across all countries and industries)? List their names.",
    questionClass: "bootstrap_multihop",
    groundTruth: { kind: "enumeration", expectedNames: top3 },
    haystackSessionIds: input.allSessionIds,
  })

  // Q5: Customers whose revenue is higher than Priscilla Collins's current revenue
  if (priscilla) {
    const expected = customers
      .filter((c) => c.annual_revenue_usd > priscilla.annual_revenue_usd && c.name !== priscilla.name)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-richer-than-priscilla",
      question:
        "List the customers whose annual revenue is strictly higher than Priscilla Collins's current annual revenue.",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q6: In the country with the most active customers, list all prospects there
  const activeCountByCountry = new Map<string, number>()
  for (const c of customers) {
    if (c.status === "active") {
      activeCountByCountry.set(c.country, (activeCountByCountry.get(c.country) ?? 0) + 1)
    }
  }
  const dominantCountry = [...activeCountByCountry.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0]?.[0]
  if (dominantCountry) {
    const expected = customers
      .filter((c) => c.country === dominantCountry && c.status === "prospect")
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-prospects-in-dominant-country",
      question:
        "In the country that has the most active customers, list every customer whose status is 'prospect'.",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q7: Customers with more employees than the top-spending German customer
  const topDe = topSpenderIn((c) => c.country === "Germany")
  if (topDe) {
    const threshold = byName.get(topDe)!.employees
    const expected = customers
      .filter((c) => c.employees > threshold)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-bigger-than-top-de",
      question:
        "List every customer who has strictly more employees than our top-spending customer based in Germany.",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q8: Sum revenue of the industry of the oldest-signup active customer
  const oldestActive = [...customers]
    .filter((c) => c.status === "active")
    .sort((a, b) => a.signup_date.localeCompare(b.signup_date) || a.name.localeCompare(b.name))[0]
  if (oldestActive) {
    const industry = oldestActive.industry
    const total = customers
      .filter((c) => c.industry === industry)
      .reduce((s, c) => s + c.annual_revenue_usd, 0)
    out.push({
      questionId: "mh-sum-revenue-industry-of-oldest-active",
      question:
        "What is the total annual revenue summed across every customer in the same industry as our earliest-signup active customer?",
      questionClass: "bootstrap_multihop",
      groundTruth: {
        kind: "aggregation",
        expectedValue: total,
        unit: "usd",
        toleranceRelative: 0.1,
      },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q9: Customers in the country with the highest total purchase amount
  const spendByCountry = new Map<string, number>()
  for (const e of events) {
    const c = byName.get(e.customer_name)
    if (!c) continue
    spendByCountry.set(c.country, (spendByCountry.get(c.country) ?? 0) + e.amount_usd)
  }
  const topSpendCountry = [...spendByCountry.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  )[0]?.[0]
  if (topSpendCountry) {
    const expected = customers
      .filter((c) => c.country === topSpendCountry)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-customers-in-top-spend-country",
      question:
        "Which country produced the highest total 2025 purchase amount? List every customer based in that country.",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  // Q10: Average-revenue peers of top-spending Swiss customer (enumeration)
  const topCh = topSpenderIn((c) => c.country === "Switzerland")
  if (topCh) {
    const industry = byName.get(topCh)!.industry
    const expected = customers
      .filter((c) => c.industry === industry && c.country === "Switzerland" && c.name !== topCh)
      .map((c) => c.name)
      .sort()
    out.push({
      questionId: "mh-same-industry-country-as-top-ch",
      question:
        "List every Swiss customer in the same industry as our highest-spending Swiss customer (excluding them).",
      questionClass: "bootstrap_multihop",
      groundTruth: { kind: "enumeration", expectedNames: expected },
      haystackSessionIds: input.allSessionIds,
    })
  }

  return out
}
