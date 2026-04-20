/**
 * Synthesize ~20 UnifiedSession[] from the dataset, covering all 4 patterns:
 *   A) Bulk CSV v1 upload (chunks of v1 customers)
 *   B) Chat-style updates & purchase events
 *   C) CSV v2 differential (field updates + late new customers)
 *   D) Narrative multi-entity references
 *
 * Coverage invariants enforced by the orchestrator's self-consistency check:
 *   - every v1 customer appears at least once in a Type A session
 *   - every purchase event appears exactly once (Type B or D)
 *   - every update appears exactly once (Type B, field-half + churn + some
 *     new_customer; Type C for the rest)
 */

import { Faker, en } from "@faker-js/faker"
import type {
  CustomerRecord,
  PurchaseEvent,
  UpdateEvent,
} from "../types/domain"
import type { UnifiedMessage, UnifiedSession } from "../types/memorybench"

const CSV_HEADER = "name,country,industry,annual_revenue_usd,employees,signup_date,status"

export interface SessionSynthesisInput {
  v1Customers: CustomerRecord[]
  events: PurchaseEvent[]
  updates: UpdateEvent[]
  seed: number
}

export interface UpdateRouting {
  /** Updates routed to Type B (conversational chat). */
  chatUpdates: UpdateEvent[]
  /** Updates routed to Type C (CSV v2 differentials). */
  csvUpdates: UpdateEvent[]
}

/**
 * Deterministically split updates by channel. We send field corrections
 * toward chat or CSV based on their id parity, all churns go to chat
 * (narrative fit), new_customers mostly to CSV (appears as new row).
 */
export function routeUpdates(updates: UpdateEvent[]): UpdateRouting {
  const chatUpdates: UpdateEvent[] = []
  const csvUpdates: UpdateEvent[] = []

  for (const u of updates) {
    if (u.kind === "churn") {
      chatUpdates.push(u)
    } else if (u.kind === "new_customer") {
      csvUpdates.push(u)
    } else {
      // customer_field: route by id parity for deterministic split
      const lastDigit = parseInt(u.id.slice(-1), 10)
      if (lastDigit % 2 === 0) chatUpdates.push(u)
      else csvUpdates.push(u)
    }
  }
  return { chatUpdates, csvUpdates }
}

export function synthesizeSessions(input: SessionSynthesisInput): UnifiedSession[] {
  const { v1Customers, events, updates, seed } = input
  const faker = new Faker({ locale: [en], seed })
  const routing = routeUpdates(updates)

  const sessions: UnifiedSession[] = []

  // ─── Type A: 8 bulk CSV v1 sessions ────────────────────────────────────
  const shuffled = [...v1Customers]
  // Shuffle deterministically
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = faker.number.int({ min: 0, max: i })
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  const aSessionCount = 8
  const chunkSize = Math.ceil(shuffled.length / aSessionCount)
  for (let i = 0; i < aSessionCount; i++) {
    const chunk = shuffled.slice(i * chunkSize, (i + 1) * chunkSize)
    if (chunk.length === 0) continue
    const date = isoDate(2025, 1, 3 + i * 2) // Jan 5, 7, 9, ... 19
    sessions.push(buildTypeASession(i, chunk, date))
  }

  // ─── Type D: 3 narrative sessions (pull ~15 events out, 3-5 customers each)
  const dSessionCount = 3
  const eventsForD: PurchaseEvent[] = []
  const eventPool = [...events]
  for (let i = 0; i < dSessionCount; i++) {
    const pick = Math.min(5, Math.floor(eventPool.length * 0.08)) // ~8% goes to D
    for (let k = 0; k < pick && eventPool.length > 0; k++) {
      const idx = faker.number.int({ min: 0, max: eventPool.length - 1 })
      eventsForD.push(eventPool.splice(idx, 1)[0])
    }
  }

  // ─── Type B: 6 chat sessions — carry remaining events + chatUpdates ─────
  const bSessionCount = 6
  const bSessions: UnifiedSession[] = []
  const eventsPerB = Math.ceil(eventPool.length / bSessionCount)
  const updatesPerB = Math.ceil(routing.chatUpdates.length / bSessionCount)

  for (let i = 0; i < bSessionCount; i++) {
    const sessionEvents = eventPool.slice(i * eventsPerB, (i + 1) * eventsPerB)
    const sessionUpdates = routing.chatUpdates.slice(i * updatesPerB, (i + 1) * updatesPerB)
    // Date: Feb to Sep, spaced roughly monthly
    const date = isoDate(2025, 2 + i, 10 + (i % 10))
    bSessions.push(buildTypeBSession(i, sessionEvents, sessionUpdates, date))
  }

  // ─── Type C: 3 CSV v2 diff sessions ────────────────────────────────────
  const cSessionCount = 3
  const cSessions: UnifiedSession[] = []
  const updatesPerC = Math.ceil(routing.csvUpdates.length / cSessionCount)
  for (let i = 0; i < cSessionCount; i++) {
    const chunk = routing.csvUpdates.slice(i * updatesPerC, (i + 1) * updatesPerC)
    if (chunk.length === 0) continue
    const date = isoDate(2025, 10 + i, 15 + (i % 5)) // Oct 15, Nov 16, Dec 17 (early)
    cSessions.push(buildTypeCSession(i, chunk, v1Customers, date))
  }

  // ─── Build Type D with selected events ─────────────────────────────────
  const dSessions: UnifiedSession[] = []
  const eventsForDChunks = chunkArray(eventsForD, dSessionCount)
  for (let i = 0; i < dSessionCount; i++) {
    const chunk = eventsForDChunks[i] || []
    if (chunk.length === 0) continue
    const date = isoDate(2025, 5 + i * 2, 20) // May, Jul, Sep
    dSessions.push(buildTypeDSession(i, chunk, date))
  }

  sessions.push(...bSessions, ...cSessions, ...dSessions)

  // Sort all sessions by metadata.date ascending
  sessions.sort((a, b) => {
    const da = String(a.metadata?.date ?? "")
    const db = String(b.metadata?.date ?? "")
    return da.localeCompare(db)
  })

  return sessions
}

// ─── Builders per type ───────────────────────────────────────────────────

function buildTypeASession(idx: number, chunk: CustomerRecord[], date: string): UnifiedSession {
  const rows = chunk
    .map(
      (c) =>
        `${c.name},${c.country},${c.industry},${c.annual_revenue_usd},${c.employees},${c.signup_date},${c.status}`
    )
    .join("\n")

  const userMsg: UnifiedMessage = {
    role: "user",
    content:
      `Here's batch ${idx + 1} of the customer export from Salesforce. Please ingest these records.\n\n` +
      CSV_HEADER +
      "\n" +
      rows,
    timestamp: date,
  }

  const countryCounts = chunk.reduce<Record<string, number>>((acc, c) => {
    acc[c.country] = (acc[c.country] || 0) + 1
    return acc
  }, {})
  const topCountries = Object.entries(countryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => c)
    .join(", ")

  const assistantMsg: UnifiedMessage = {
    role: "assistant",
    content: `Ingested ${chunk.length} customers. The top countries in this batch are ${topCountries}. Let me know when you have the next batch.`,
    timestamp: date,
  }

  return {
    sessionId: `session-A${String(idx + 1).padStart(2, "0")}-csv-v1`,
    messages: [userMsg, assistantMsg],
    metadata: { date, type: "A", pattern: "bulk_csv_v1" },
  }
}

function buildTypeBSession(
  idx: number,
  events: PurchaseEvent[],
  updates: UpdateEvent[],
  date: string
): UnifiedSession {
  const messages: UnifiedMessage[] = []

  // Pair events and updates into 2-5 turns
  const items: Array<{ kind: "event"; e: PurchaseEvent } | { kind: "update"; u: UpdateEvent }> = []
  for (const e of events) items.push({ kind: "event", e })
  for (const u of updates) items.push({ kind: "update", u })

  // Interleave deterministically by id
  items.sort((a, b) => {
    const ai = a.kind === "event" ? a.e.id : a.u.id
    const bi = b.kind === "event" ? b.e.id : b.u.id
    return ai.localeCompare(bi)
  })

  // Group into ~3 turn-pairs
  const turnCount = Math.min(5, Math.max(2, Math.ceil(items.length / 3)))
  const itemsPerTurn = Math.ceil(items.length / turnCount)

  for (let t = 0; t < turnCount; t++) {
    const turnItems = items.slice(t * itemsPerTurn, (t + 1) * itemsPerTurn)
    if (turnItems.length === 0) continue

    const userLines: string[] = []
    for (const item of turnItems) {
      if (item.kind === "event") {
        userLines.push(
          `${item.e.customer_name} bought $${formatAmount(item.e.amount_usd)} of ${item.e.product} on ${item.e.date}.`
        )
      } else if (item.u.kind === "customer_field") {
        userLines.push(formatFieldUpdateSentence(item.u))
      } else if (item.u.kind === "churn") {
        userLines.push(`${item.u.customer_name} churned on ${item.u.date} — mark them as churned.`)
      } else if (item.u.kind === "new_customer") {
        userLines.push(
          `New customer: ${item.u.customer.name} from ${item.u.customer.country} (${item.u.customer.industry}), signed up ${item.u.customer.signup_date}.`
        )
      }
    }

    const userMsg: UnifiedMessage = {
      role: "user",
      content: `Quick updates:\n${userLines.map((l) => `• ${l}`).join("\n")}`,
      timestamp: date,
    }
    messages.push(userMsg)
    messages.push({
      role: "assistant",
      content: `Logged.`,
      timestamp: date,
    })
  }

  if (messages.length === 0) {
    // Guarantee every session has at least one turn
    messages.push({
      role: "user",
      content: `No updates this period — just confirming the CRM is up to date.`,
      timestamp: date,
    })
    messages.push({
      role: "assistant",
      content: `Understood, nothing to log.`,
      timestamp: date,
    })
  }

  return {
    sessionId: `session-B${String(idx + 1).padStart(2, "0")}-chat`,
    messages,
    metadata: { date, type: "B", pattern: "chat_updates" },
  }
}

function buildTypeCSession(
  idx: number,
  updates: UpdateEvent[],
  v1Customers: CustomerRecord[],
  date: string
): UnifiedSession {
  const byName = new Map(v1Customers.map((c) => [c.name, c] as const))
  const rows: string[] = []
  const notes: string[] = []

  for (const u of updates) {
    if (u.kind === "customer_field") {
      const v1 = byName.get(u.customer_name)
      if (!v1) continue
      // Render the row with the NEW value for the updated field
      const merged: CustomerRecord = { ...v1 }
      if (u.field === "employees") merged.employees = Number(u.new_value)
      else if (u.field === "annual_revenue_usd") merged.annual_revenue_usd = Number(u.new_value)
      else if (u.field === "industry") merged.industry = String(u.new_value)
      else if (u.field === "status") merged.status = u.new_value as CustomerRecord["status"]
      rows.push(
        `${merged.name},${merged.country},${merged.industry},${merged.annual_revenue_usd},${merged.employees},${merged.signup_date},${merged.status}`
      )
      notes.push(`${u.customer_name}: ${u.field} updated.`)
    } else if (u.kind === "new_customer") {
      const c = u.customer
      rows.push(
        `${c.name},${c.country},${c.industry},${c.annual_revenue_usd},${c.employees},${c.signup_date},${c.status}`
      )
      notes.push(`New entry: ${c.name}.`)
    }
  }

  const userMsg: UnifiedMessage = {
    role: "user",
    content:
      `Fresh Salesforce export v${idx + 2} — here are the changed/new rows since the last sync:\n\n` +
      CSV_HEADER +
      "\n" +
      rows.join("\n") +
      `\n\nChange log:\n${notes.map((n) => `- ${n}`).join("\n")}`,
    timestamp: date,
  }

  const assistantMsg: UnifiedMessage = {
    role: "assistant",
    content: `Processed ${rows.length} updated/new rows. The CRM now reflects the latest values.`,
    timestamp: date,
  }

  return {
    sessionId: `session-C${String(idx + 1).padStart(2, "0")}-csv-v2`,
    messages: [userMsg, assistantMsg],
    metadata: { date, type: "C", pattern: "csv_v2_diff" },
  }
}

function buildTypeDSession(idx: number, events: PurchaseEvent[], date: string): UnifiedSession {
  const lines: string[] = []

  // Group events by customer
  const byCustomer = new Map<string, PurchaseEvent[]>()
  for (const e of events) {
    const arr = byCustomer.get(e.customer_name) || []
    arr.push(e)
    byCustomer.set(e.customer_name, arr)
  }

  const customerOrder = [...byCustomer.keys()].sort()
  for (const name of customerOrder) {
    const evs = byCustomer.get(name)!
    const totals = evs.reduce((acc, e) => acc + e.amount_usd, 0)
    const productSummary = [...new Set(evs.map((e) => e.product))].join(" and ")
    lines.push(
      `${name} came in with ${evs.length} order${evs.length > 1 ? "s" : ""} (${productSummary}) totaling $${formatAmount(totals)}.`
    )
  }

  const userMsg: UnifiedMessage = {
    role: "user",
    content:
      `Recap for the period ending ${date}. Notable customer activity:\n${lines.map((l) => `• ${l}`).join("\n")}\n\nIndividual transactions:\n` +
      events
        .map(
          (e) =>
            `  - ${e.customer_name} / ${e.product} / $${formatAmount(e.amount_usd)} / ${e.date}`
        )
        .join("\n"),
    timestamp: date,
  }

  const assistantMsg: UnifiedMessage = {
    role: "assistant",
    content: `Recap logged — ${events.length} transactions across ${byCustomer.size} accounts.`,
    timestamp: date,
  }

  return {
    sessionId: `session-D${String(idx + 1).padStart(2, "0")}-narrative`,
    messages: [userMsg, assistantMsg],
    metadata: { date, type: "D", pattern: "narrative_multi_entity" },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatFieldUpdateSentence(u: Extract<UpdateEvent, { kind: "customer_field" }>): string {
  if (u.field === "employees") {
    return `Correction: ${u.customer_name}'s employee count is now ${u.new_value}, not what we had before.`
  }
  if (u.field === "annual_revenue_usd") {
    return `${u.customer_name}'s annual revenue was revised to $${formatAmount(Number(u.new_value))}.`
  }
  if (u.field === "industry") {
    return `${u.customer_name} has pivoted — their industry should now be ${u.new_value}.`
  }
  return `${u.customer_name}: ${u.field} changed to ${u.new_value}.`
}

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return String(n)
}

function isoDate(year: number, month: number, day: number): string {
  const m = String(month).padStart(2, "0")
  const d = String(day).padStart(2, "0")
  return `${year}-${m}-${d}`
}

function chunkArray<T>(arr: T[], count: number): T[][] {
  if (count <= 0) return []
  const size = Math.ceil(arr.length / count)
  const out: T[][] = []
  for (let i = 0; i < count; i++) out.push(arr.slice(i * size, (i + 1) * size))
  return out
}
