/**
 * mem0-planned — mem0 cloud wrapped with the same query planner that
 * sandra-structured uses.
 *
 * Why this exists: the question "is sandra-structured only winning because
 * we added a planner?" is the benchmark's most important defensibility
 * question. If we give mem0 the SAME planner and their score stays near
 * raw-mem0 levels, the planner is not the differentiator — the underlying
 * graph/index architecture is. If their score explodes to near-Sandra,
 * our thesis is wrong.
 *
 * Design: the planner outputs a structured QueryPlan (same as for Sandra).
 * For mem0 (which is a top-K semantic retriever), we translate the plan
 * into a set of targeted natural-language queries. Each query is sent to
 * mem0's search(); we union the top-K hits and pass them to the answer
 * LLM. This is what any production wrapper around mem0 would do.
 */

import { resolve } from "path"
import { fileURLToPath } from "url"
import { dirname } from "path"
import type {
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "../types/memorybench"
import { planQuery, type QueryPlan } from "./sandra-structured-planner"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MEMORYBENCH_ROOT = resolve(__dirname, "..", "..", "..", "memorybench")

const MEM0_TOPK_PER_QUERY = 20
const MEM0_MAX_QUERIES = 5

export class Mem0PlannedProvider implements Provider {
  name = "mem0-planned"
  private inner: Provider | null = null

  async initialize(config: ProviderConfig): Promise<void> {
    const mod = await import(`${MEMORYBENCH_ROOT}/src/providers/index.ts`)
    if (typeof mod.createProvider !== "function") {
      throw new Error(`memorybench not found at ${MEMORYBENCH_ROOT} — clone it alongside SRB`)
    }
    this.inner = mod.createProvider("mem0") as Provider
    await this.inner.initialize(config)
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.inner) throw new Error("not initialized")
    return this.inner.ingest(sessions, options)
  }

  async awaitIndexing(result: IngestResult, containerTag: string): Promise<void> {
    if (!this.inner) throw new Error("not initialized")
    return this.inner.awaitIndexing(result, containerTag)
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.inner) throw new Error("not initialized")

    const plan = await planQuery(query)
    const refinedQueries = planToQueries(plan, query)

    // Fetch top-K from each refined query and union the hits. This is the
    // "production wrapper" approach: multiple targeted searches instead of
    // a single raw question. Deduplication is shallow — the answer LLM
    // tolerates duplicate hits.
    const allHits: unknown[] = []
    const seen = new Set<string>()
    for (const q of refinedQueries.slice(0, MEM0_MAX_QUERIES)) {
      const hits = await this.inner.search(q, { ...options, limit: MEM0_TOPK_PER_QUERY })
      for (const h of hits) {
        const key = hashHit(h)
        if (seen.has(key)) continue
        seen.add(key)
        allHits.push(h)
      }
    }
    return allHits
  }

  async clear(containerTag: string): Promise<void> {
    if (!this.inner) throw new Error("not initialized")
    return this.inner.clear(containerTag)
  }
}

function hashHit(h: unknown): string {
  return typeof h === "string" ? h : JSON.stringify(h).slice(0, 200)
}

/**
 * Translate a structured QueryPlan into a set of natural-language queries
 * suited to a top-K semantic retriever. We intentionally generate MULTIPLE
 * queries per plan to maximize recall — this is the generous reading of
 * "what a mem0 production wrapper would do".
 */
export function planToQueries(plan: QueryPlan, originalQuestion: string): string[] {
  const queries: string[] = []
  const f = plan.filters

  switch (plan.scope) {
    case "list_customers": {
      if (f.country && f.status) {
        queries.push(`${f.status} customer from ${f.country}`)
        queries.push(`${f.country} customer ${f.status}`)
        queries.push(`customer country ${f.country} status ${f.status}`)
      }
      if (f.industry && f.status) {
        queries.push(`${f.status} ${f.industry} customer`)
        queries.push(`${f.industry} industry customer ${f.status}`)
      }
      if (f.country) queries.push(`customer from ${f.country}`)
      if (f.industry) queries.push(`${f.industry} customer`)
      if (f.status) queries.push(`${f.status} customer`)
      break
    }
    case "list_events_customers": {
      if (f.product) {
        queries.push(`customer bought ${f.product}`)
        queries.push(`${f.product} purchase`)
        queries.push(`${f.product} order customer`)
      }
      if (f.month) {
        queries.push(`purchases in ${f.month}`)
        queries.push(`customer purchase ${f.month}`)
      }
      break
    }
    case "sum_events_by_customer_filter": {
      if (f.country) {
        queries.push(`${f.country} customer purchases total`)
        queries.push(`${f.country} customer spend`)
        queries.push(`purchase from ${f.country} customer`)
      }
      if (f.industry) {
        queries.push(`${f.industry} customer purchase amount`)
        queries.push(`${f.industry} industry total spend`)
      }
      break
    }
    case "reconcile_customer_field": {
      if (f.customer_name && f.field) {
        queries.push(`${f.customer_name} ${f.field} current`)
        queries.push(`${f.customer_name} latest ${f.field}`)
        queries.push(`${f.customer_name} update`)
      }
      break
    }
    case "top_spending_customer_by_filter": {
      if (f.country) {
        queries.push(`top spending ${f.country} customer`)
        queries.push(`largest ${f.country} customer purchase`)
        queries.push(`${f.country} customer highest spend`)
      }
      if (f.industry) {
        queries.push(`top ${f.industry} customer purchase`)
        queries.push(`largest ${f.industry} customer`)
      }
      break
    }
    case "fallback":
    default:
      break
  }

  // Always include the original question as a safety net
  queries.push(originalQuestion)

  // Deduplicate
  return [...new Set(queries)]
}
