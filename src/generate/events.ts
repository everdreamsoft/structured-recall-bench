/**
 * Purchase event generation — ~200 events referencing customers by name.
 *
 * Events skew toward active customers (the realistic pattern: churned/prospect
 * customers rarely buy). Multiple events per customer are allowed; some
 * customers get none.
 */

import { Faker, en } from "@faker-js/faker"
import type { CustomerRecord, PurchaseEvent } from "../types/domain"

export const PRODUCTS = [
  "paper",
  "packaging",
  "office supplies",
  "logistics services",
  "consulting",
  "software licenses",
  "hardware",
  "catering",
  "training",
  "raw materials",
] as const

export function generatePurchaseEvents(
  customers: CustomerRecord[],
  seed: number,
  n: number = 200
): PurchaseEvent[] {
  const faker = new Faker({ locale: [en], seed })
  const events: PurchaseEvent[] = []

  // Weighted pool: active customers appear 5× vs churned, 2× vs prospect.
  const pool: CustomerRecord[] = []
  for (const c of customers) {
    const weight = c.status === "active" ? 5 : c.status === "prospect" ? 2 : 1
    for (let i = 0; i < weight; i++) pool.push(c)
  }

  for (let i = 0; i < n; i++) {
    const customer = faker.helpers.arrayElement(pool)
    const product = faker.helpers.arrayElement(PRODUCTS)

    // Amounts scale loosely with customer revenue (small accounts don't buy $1M).
    const ceiling = Math.max(5_000, Math.round(customer.annual_revenue_usd * 0.05))
    const amount_usd = faker.number.int({ min: 2_000, max: ceiling })
    const roundedAmount = Math.round(amount_usd / 100) * 100

    const date = faker.date
      .between({ from: "2025-01-01T00:00:00Z", to: "2025-11-30T23:59:59Z" })
      .toISOString()
      .slice(0, 10)

    events.push({
      id: `evt-${String(i).padStart(4, "0")}`,
      customer_name: customer.name,
      product,
      amount_usd: roundedAmount,
      date,
    })
  }

  events.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))
  return events
}
