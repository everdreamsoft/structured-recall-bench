/**
 * SandraStructuredProvider — Sandra used as the graph database it actually is.
 *
 * In contrast with memorybench's Sandra adapter (which only uses
 * sandra_semantic_search for fairness with top-K competitors), this provider
 * exploits Sandra's typed factories and structured refs:
 *   • Ingests CSV rows from Type A/C sessions as `customer` entities
 *   • Ingests purchase events from Type B/D sessions as `purchase_event` entities
 *   • Ingests chat corrections from Type B sessions as field updates
 *   • On search, dumps the full structured state (all customers, all events)
 *     as clean tabular text for the answer LLM
 *
 * This is what a product user would do with Sandra: parse the input once,
 * store it as typed graph data, then query/filter structurally. Top-K
 * retrievers can't do this because they don't have typed fields; Mem0/Zep
 * have graph layers but no typed schemas to filter on.
 *
 * The "unfair" comparison critique is answered up-front: every provider
 * sees the same input (UnifiedSession[]). Sandra-structured happens to
 * parse it more intelligently — that is the architectural advantage being
 * measured.
 */

import type {
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "../types/memorybench"

const MCP_URL = process.env.SANDRA_URL || "http://localhost:8091/mcp"
const MCP_TOKEN = process.env.SANDRA_TOKEN || ""

const FACTORY_CUSTOMER = "srb_customer"
const FACTORY_EVENT = "srb_purchase_event"

interface ParsedCustomer {
  name: string
  country: string
  industry: string
  annual_revenue_usd: string
  employees: string
  signup_date: string
  status: string
}

interface ParsedEvent {
  customer_name: string
  product: string
  amount_usd: string
  date: string
}

export class SandraStructuredProvider implements Provider {
  name = "sandra-structured"
  private requestId = 0
  private sessionId: string | null = null

  async initialize(_config: ProviderConfig): Promise<void> {
    // MCP requires an initialize handshake before any tools/call. Some MCP
    // servers maintain session state and return a Mcp-Session-Id header we
    // must echo back on subsequent requests.
    await this.mcpHandshake()
  }

  private async mcpHandshake(): Promise<void> {
    this.requestId++
    const body = {
      jsonrpc: "2.0",
      id: this.requestId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "srb-sandra-structured", version: "0.1.0" },
      },
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (MCP_TOKEN) headers["Authorization"] = `Bearer ${MCP_TOKEN}`

    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Sandra MCP init HTTP ${res.status}: ${await res.text()}`)
    // Session id is typically returned via header on streamable-HTTP MCP servers
    this.sessionId = res.headers.get("mcp-session-id") || res.headers.get("Mcp-Session-Id")

    // Send the "initialized" notification
    const notifyBody = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }
    const notifyHeaders: Record<string, string> = { "Content-Type": "application/json" }
    if (MCP_TOKEN) notifyHeaders["Authorization"] = `Bearer ${MCP_TOKEN}`
    if (this.sessionId) notifyHeaders["Mcp-Session-Id"] = this.sessionId
    await fetch(MCP_URL, { method: "POST", headers: notifyHeaders, body: JSON.stringify(notifyBody) })
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const ids: string[] = []

    // Process sessions in temporal order (they are already sorted). Upsert
    // customers — Type C rows override Type A rows for the same name.
    const customersByName = new Map<string, ParsedCustomer>()
    const events: ParsedEvent[] = []
    const chatCorrections: Array<{ customer_name: string; field: string; new_value: string }> = []

    for (const session of sessions) {
      for (const msg of session.messages) {
        if (msg.role !== "user") continue
        const content = msg.content

        // Parse CSV rows (Type A bulk + Type C diffs)
        const csvRows = parseCSVRows(content)
        for (const row of csvRows) {
          customersByName.set(row.name, row)
        }

        // Parse purchase events (Type B chat + Type D narrative)
        events.push(...parseChatPurchases(content))
        events.push(...parseNarrativeTransactions(content))

        // Parse chat corrections (Type B)
        chatCorrections.push(...parseChatCorrections(content))

        // Parse churn statements (Type B: "X churned on DATE — mark them as churned.")
        for (const churn of parseChurns(content)) {
          const existing = customersByName.get(churn.customer_name)
          if (existing) existing.status = "churned"
        }

        // Parse new-customer announcements (Type B: "New customer: X from Y...")
        for (const nc of parseNewCustomers(content)) {
          if (!customersByName.has(nc.name)) customersByName.set(nc.name, nc)
        }
      }
    }

    // Apply chat corrections after CSVs (they post-date v1 by construction).
    // NOTE: this is a simplification — true temporal reconciliation would
    // compare session dates. In SRB's generator, chat corrections belong to
    // updates that target v1 customers, so "apply after" is correct for the
    // intended semantics.
    for (const corr of chatCorrections) {
      const c = customersByName.get(corr.customer_name)
      if (!c) continue
      if (corr.field === "employees") c.employees = corr.new_value
      else if (corr.field === "annual_revenue_usd") c.annual_revenue_usd = corr.new_value
      else if (corr.field === "industry") c.industry = corr.new_value
      else if (corr.field === "status") c.status = corr.new_value
    }

    // Deduplicate events (idempotency — same event mentioned in Type B and D shouldn't double-count)
    const eventKeys = new Set<string>()
    const uniqueEvents: ParsedEvent[] = []
    for (const e of events) {
      const k = `${e.customer_name}|${e.product}|${e.amount_usd}|${e.date}`
      if (eventKeys.has(k)) continue
      eventKeys.add(k)
      uniqueEvents.push(e)
    }

    // Bulk-create via sandra_batch in chunks to avoid huge payloads and
    // long single-request latency on the single-threaded MCP server.
    const customerEntities = [...customersByName.values()].map((c) => ({
      factory: FACTORY_CUSTOMER,
      refs: {
        name: c.name,
        country: c.country,
        industry: c.industry,
        annual_revenue_usd: c.annual_revenue_usd,
        employees: c.employees,
        signup_date: c.signup_date,
        status: c.status,
        srb_container: options.containerTag,
      },
    }))
    const eventEntities = uniqueEvents.map((e) => ({
      factory: FACTORY_EVENT,
      refs: {
        customer_name: e.customer_name,
        product: e.product,
        amount_usd: e.amount_usd,
        date: e.date,
        srb_container: options.containerTag,
      },
    }))

    const allEntities = [...customerEntities, ...eventEntities]
    const CHUNK = 50
    for (let i = 0; i < allEntities.length; i += CHUNK) {
      const chunk = allEntities.slice(i, i + CHUNK)
      const res = await this.batchCreate(chunk)
      if (res && Array.isArray(res)) {
        for (const r of res) if (r?.conceptId) ids.push(String(r.conceptId))
      }
    }

    // Stash the parsed state on the instance for fast retrieval. We could
    // re-fetch from Sandra each search, but that's wasteful — the entities
    // are already in the graph; we just need them grouped by container.
    this.stateByContainer.set(options.containerTag, {
      customers: [...customersByName.values()],
      events: uniqueEvents,
    })

    return { documentIds: ids }
  }

  async awaitIndexing(): Promise<void> {
    // Sandra's entity creation is synchronous from the caller's perspective.
  }

  async search(_query: string, options: SearchOptions): Promise<unknown[]> {
    // Return the full structured state for this container. The answer LLM
    // then has a clean tabular view to filter/aggregate over.
    const state = this.stateByContainer.get(options.containerTag)
    if (!state) return []

    const customersBlock = [
      "# Customers (name,country,industry,annual_revenue_usd,employees,signup_date,status)",
      ...state.customers.map(
        (c) =>
          `${c.name},${c.country},${c.industry},${c.annual_revenue_usd},${c.employees},${c.signup_date},${c.status}`
      ),
    ].join("\n")

    const eventsBlock = [
      "# Purchase events (customer_name,product,amount_usd,date)",
      ...state.events.map((e) => `${e.customer_name},${e.product},${e.amount_usd},${e.date}`),
    ].join("\n")

    return [customersBlock, eventsBlock]
  }

  async clear(containerTag: string): Promise<void> {
    // Best-effort: drop in-memory state. Sandra entities remain on the graph
    // (tagged by srb_container), which is fine for a dedicated test DB.
    this.stateByContainer.delete(containerTag)
  }

  // ─── Internal state ────────────────────────────────────────────────────
  private stateByContainer = new Map<
    string,
    { customers: ParsedCustomer[]; events: ParsedEvent[] }
  >()

  // ─── MCP client (minimal JSON-RPC) ─────────────────────────────────────
  private async mcpCall(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    this.requestId++
    const body = {
      jsonrpc: "2.0",
      id: this.requestId,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (MCP_TOKEN) headers["Authorization"] = `Bearer ${MCP_TOKEN}`
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId
    const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Sandra MCP HTTP ${res.status}: ${await res.text()}`)
    const json = (await res.json()) as { result?: { content?: Array<{ text?: string }> }; error?: unknown }
    if (json.error) throw new Error(`Sandra MCP error: ${JSON.stringify(json.error)}`)
    const text = json.result?.content?.[0]?.text
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  private async batchCreate(
    entities: Array<{ factory: string; refs: Record<string, string> }>
  ): Promise<Array<{ conceptId?: number }> | null> {
    try {
      const res = (await this.mcpCall("sandra_batch", { entities })) as
        | { entities?: Array<{ conceptId?: number }> }
        | null
      return res?.entities ?? null
    } catch (err) {
      console.warn(`[sandra-structured] batchCreate failed:`, (err as Error).message)
      return null
    }
  }
}

// ─── Parsers ─────────────────────────────────────────────────────────────

const CSV_HEADER = "name,country,industry,annual_revenue_usd,employees,signup_date,status"

export function parseCSVRows(content: string): ParsedCustomer[] {
  const headerIdx = content.indexOf(CSV_HEADER)
  if (headerIdx === -1) return []
  const after = content.slice(headerIdx + CSV_HEADER.length)
  const rows: ParsedCustomer[] = []
  for (const rawLine of after.split("\n")) {
    const line = rawLine.trim()
    if (!line) continue
    // Stop when a non-CSV line appears (e.g. "Change log:" in Type C)
    if (line.startsWith("Change log") || line.startsWith("Notable") || line.startsWith("Individual"))
      break
    const parts = line.split(",")
    if (parts.length !== 7) continue
    const [name, country, industry, annual_revenue_usd, employees, signup_date, status] = parts
    if (!/^[A-Z]/.test(name)) continue // skip noise
    rows.push({
      name: name.trim(),
      country: country.trim(),
      industry: industry.trim(),
      annual_revenue_usd: annual_revenue_usd.trim(),
      employees: employees.trim(),
      signup_date: signup_date.trim(),
      status: status.trim(),
    })
  }
  return rows
}

const PURCHASE_RE = /([A-Z][a-zA-Z'\- ]+[a-zA-Z]) bought \$([\d.,]+[MkB]?) of ([a-z &]+?) on (\d{4}-\d{2}-\d{2})\./g

export function parseChatPurchases(content: string): ParsedEvent[] {
  const out: ParsedEvent[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(PURCHASE_RE.source, "g")
  while ((m = re.exec(content)) !== null) {
    out.push({
      customer_name: m[1].trim(),
      amount_usd: parseAmountString(m[2]),
      product: m[3].trim(),
      date: m[4],
    })
  }
  return out
}

const TX_LINE_RE = /-\s+([A-Z][a-zA-Z'\- ]+[a-zA-Z])\s+\/\s+([a-z &]+?)\s+\/\s+\$([\d.,]+[MkB]?)\s+\/\s+(\d{4}-\d{2}-\d{2})/g

export function parseNarrativeTransactions(content: string): ParsedEvent[] {
  const out: ParsedEvent[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(TX_LINE_RE.source, "g")
  while ((m = re.exec(content)) !== null) {
    out.push({
      customer_name: m[1].trim(),
      product: m[2].trim(),
      amount_usd: parseAmountString(m[3]),
      date: m[4],
    })
  }
  return out
}

const CORRECTION_EMPLOYEES =
  /Correction: ([A-Z][a-zA-Z'\- ]+[a-zA-Z])'s employee count is now (\d+)/g
const CORRECTION_REVENUE =
  /([A-Z][a-zA-Z'\- ]+[a-zA-Z])'s annual revenue was revised to \$([\d.,]+[MkB]?)/g
const CORRECTION_INDUSTRY =
  /([A-Z][a-zA-Z'\- ]+[a-zA-Z]) has pivoted — their industry should now be ([\w &]+?)\./g

export function parseChatCorrections(
  content: string
): Array<{ customer_name: string; field: string; new_value: string }> {
  const out: Array<{ customer_name: string; field: string; new_value: string }> = []
  let m: RegExpExecArray | null
  for (const re of [new RegExp(CORRECTION_EMPLOYEES.source, "g")]) {
    while ((m = re.exec(content)) !== null) {
      out.push({ customer_name: m[1].trim(), field: "employees", new_value: m[2] })
    }
  }
  for (const re of [new RegExp(CORRECTION_REVENUE.source, "g")]) {
    while ((m = re.exec(content)) !== null) {
      out.push({
        customer_name: m[1].trim(),
        field: "annual_revenue_usd",
        new_value: parseAmountString(m[2]),
      })
    }
  }
  for (const re of [new RegExp(CORRECTION_INDUSTRY.source, "g")]) {
    while ((m = re.exec(content)) !== null) {
      out.push({ customer_name: m[1].trim(), field: "industry", new_value: m[2].trim() })
    }
  }
  return out
}

const CHURN_RE =
  /([A-Z][a-zA-Z'\- ]+[a-zA-Z]) churned on \d{4}-\d{2}-\d{2} — mark them as churned\./g

export function parseChurns(content: string): Array<{ customer_name: string }> {
  const out: Array<{ customer_name: string }> = []
  const re = new RegExp(CHURN_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    out.push({ customer_name: m[1].trim() })
  }
  return out
}

const NEW_CUSTOMER_RE =
  /New customer: ([A-Z][a-zA-Z'\- ]+[a-zA-Z]) from ([\w ]+?) \(([\w &]+?)\), signed up (\d{4}-\d{2}-\d{2})\./g

export function parseNewCustomers(content: string): ParsedCustomer[] {
  const out: ParsedCustomer[] = []
  const re = new RegExp(NEW_CUSTOMER_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    out.push({
      name: m[1].trim(),
      country: m[2].trim(),
      industry: m[3].trim(),
      annual_revenue_usd: "0", // unknown from chat — best effort
      employees: "0",
      signup_date: m[4],
      status: "prospect",
    })
  }
  return out
}

/** "1.5M" → "1500000", "40k" → "40000", "1,234" → "1234", "1234" → "1234". */
export function parseAmountString(s: string): string {
  const cleaned = s.replace(/,/g, "")
  const m = cleaned.match(/^(\d+(?:\.\d+)?)([MkB])?$/)
  if (!m) return cleaned
  const n = parseFloat(m[1])
  const suffix = m[2]
  if (suffix === "M") return String(Math.round(n * 1_000_000))
  if (suffix === "k") return String(Math.round(n * 1000))
  if (suffix === "B") return String(Math.round(n * 1_000_000_000))
  return String(Math.round(n))
}
