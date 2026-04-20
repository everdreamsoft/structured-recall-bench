/**
 * Query planner — converts a natural-language question into a structured
 * query plan that the executor can run against the typed entity state.
 *
 * This is what makes Sandra "native": instead of dumping everything and
 * letting the answer LLM do JOIN+FILTER+SUM manually over 45k tokens of
 * context, we plan the query up-front and execute it precisely. The
 * answer LLM then receives a tiny, already-computed result.
 *
 * Plans are intentionally narrow — just enough to cover the 5 SRB question
 * classes. A production implementation would have a richer schema or use
 * tool-use with Sandra's MCP query interface.
 */

import { generateText } from "ai"
import { openai } from "@ai-sdk/openai"

const PLANNER_MODEL = process.env.SRB_PLANNER_MODEL ?? "gpt-4.1-mini"

export type QueryScope =
  | "list_customers" // filter CRM rows and list names
  | "list_events_customers" // filter events, list the distinct customers
  | "sum_events_by_customer_filter" // filter customers, sum all their event amounts
  | "reconcile_customer_field" // return a single customer's current field value
  | "top_spending_customer_by_filter" // filter customers, pick the one with highest event total
  | "fallback" // planner couldn't parse — caller should fall back to dump

export interface QueryPlan {
  scope: QueryScope
  filters: {
    country?: string
    industry?: string
    status?: "active" | "churned" | "prospect"
    product?: string
    month?: string // "2025-03"
    customer_name?: string
    field?: "annual_revenue_usd" | "employees" | "industry" | "status" | "country"
  }
  rationale?: string
}

const SYSTEM_PROMPT = `You are a query planner for a CRM analytics benchmark. Convert the user's natural-language question into a JSON query plan.

The CRM has customer records (name, country, industry, annual_revenue_usd, employees, signup_date, status) and purchase_event records (customer_name, product, amount_usd, date). All events are 2025.

Output a single JSON object with fields:
- scope: one of the values below
- filters: object with any combination of {country, industry, status, product, month, customer_name, field}
- rationale: one sentence

Scope values:
  "list_customers"                      — "list all X customers from Y" / status-based enumeration
  "list_events_customers"               — "which customers bought X" / "who made purchases in MONTH"
  "sum_events_by_customer_filter"       — "total purchases from French customers" / aggregation
  "reconcile_customer_field"            — "what is X's current REVENUE/EMPLOYEES/STATUS"
  "top_spending_customer_by_filter"     — "who is the largest/top-spending X customer"
  "fallback"                            — ambiguous / unsupported

Countries must be written exactly: "France", "Germany", "United Kingdom", "Italy", "Spain", "Netherlands", "Switzerland", "Sweden", "Denmark", "Poland", "United States", "Canada", "Mexico", "Brazil", "Australia", "Japan", "South Korea", "Singapore", "India", "Ireland"

Industries: "Fintech", "SaaS", "Manufacturing", "Food & Beverage", "Healthcare", "Retail", "Energy", "Media", "Education", "Logistics"

Products: "paper", "packaging", "office supplies", "logistics services", "consulting", "software licenses", "hardware", "catering", "training", "raw materials"

Status: "active", "churned", "prospect"

Months: ISO prefix "2025-01" through "2025-12"

Field (for reconciliation): "annual_revenue_usd", "employees", "industry", "status", "country"

Output JSON only. No prose, no markdown fences.`

export async function planQuery(question: string): Promise<QueryPlan> {
  try {
    const { text } = await generateText({
      model: openai(PLANNER_MODEL),
      system: SYSTEM_PROMPT,
      prompt: `Question: "${question}"\n\nJSON plan:`,
      temperature: 0,
    })
    const cleaned = stripCodeFence(text.trim())
    const parsed = JSON.parse(cleaned) as QueryPlan
    if (!parsed.scope || !parsed.filters) return { scope: "fallback", filters: {} }
    return parsed
  } catch (err) {
    return { scope: "fallback", filters: {}, rationale: `planner error: ${(err as Error).message}` }
  }
}

function stripCodeFence(s: string): string {
  if (s.startsWith("```")) {
    const end = s.lastIndexOf("```")
    return s
      .slice(s.indexOf("\n") + 1, end)
      .trim()
  }
  return s
}
