/**
 * Unified truth: final CRM state after applying all updates in temporal order.
 *
 * The scoring layer treats this as the authoritative answer. Any reconciliation
 * question (knowledge-update) compares the provider's response against the
 * post-update value here; the v1 CSV value is flagged separately as the
 * "stale answer" to categorize architectural failures.
 */

import type { CustomerRecord, PurchaseEvent, UnifiedTruth, UpdateEvent } from "../types/domain"

export function buildUnifiedTruth(
  v1Customers: CustomerRecord[],
  events: PurchaseEvent[],
  updates: UpdateEvent[],
  seed: number
): UnifiedTruth {
  // Start from a deep copy of v1 so the original stays pristine.
  const byName = new Map<string, CustomerRecord>()
  for (const c of v1Customers) byName.set(c.name, { ...c })

  // Sort updates by date ascending, then by id for tie-breaking.
  const sorted = [...updates].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)
  )

  let applied = 0
  for (const u of sorted) {
    if (u.kind === "customer_field") {
      const c = byName.get(u.customer_name)
      if (!c) continue // dangling update: skip silently (self-consistency check flags this)
      if (u.field === "employees") c.employees = Number(u.new_value)
      else if (u.field === "annual_revenue_usd") c.annual_revenue_usd = Number(u.new_value)
      else if (u.field === "industry") c.industry = String(u.new_value)
      else if (u.field === "status") c.status = u.new_value as CustomerRecord["status"]
      applied++
    } else if (u.kind === "new_customer") {
      if (!byName.has(u.customer.name)) {
        byName.set(u.customer.name, { ...u.customer })
        applied++
      }
    } else if (u.kind === "churn") {
      const c = byName.get(u.customer_name)
      if (!c) continue
      c.status = "churned"
      applied++
    }
  }

  const customers = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  const sortedEvents = [...events].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)
  )

  return {
    customers,
    events: sortedEvents,
    updatesApplied: applied,
    seed,
    generatedAt: "deterministic", // stamped by orchestrator, not here, to keep this pure
  }
}
