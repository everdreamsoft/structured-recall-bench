/**
 * Update/correction generation — 50 field changes spread through the timeline.
 *
 * Mix of:
 *   • customer_field (status, employees, revenue, industry updates)
 *   • new_customer (late additions that only appear in updates, not v1 CSV)
 *   • churn (status → churned + effective date)
 *
 * All updates carry an ISO date. buildUnifiedTruth applies them in temporal
 * order so the final state reflects the latest mention of each field.
 */

import { Faker, en } from "@faker-js/faker"
import type { CustomerRecord, UpdateEvent } from "../types/domain"
import { COUNTRIES, INDUSTRIES } from "./customers"

export function generateUpdates(
  customers: CustomerRecord[],
  seed: number,
  n: number = 50
): UpdateEvent[] {
  const faker = new Faker({ locale: [en], seed })
  const updates: UpdateEvent[] = []

  // Targets for field updates: skew toward active customers (makes semantic
  // sense — you don't keep updating churned accounts).
  const activeCustomers = customers.filter((c) => c.status === "active")

  // Reserve ~10 slots for new_customer, ~10 for churn, rest for field updates
  const newCustomerCount = Math.round(n * 0.2)
  const churnCount = Math.round(n * 0.2)
  const fieldCount = n - newCustomerCount - churnCount

  // Field updates
  for (let i = 0; i < fieldCount; i++) {
    const customer = faker.helpers.arrayElement(activeCustomers)
    const field = faker.helpers.arrayElement([
      "employees",
      "annual_revenue_usd",
      "industry",
    ] as const)

    let new_value: string | number
    if (field === "employees") {
      // Usually a growth signal — bump by 10-50%
      const growth = faker.number.float({ min: 1.1, max: 1.5 })
      new_value = Math.round(customer.employees * growth)
    } else if (field === "annual_revenue_usd") {
      const growth = faker.number.float({ min: 1.05, max: 1.4 })
      new_value = Math.round((customer.annual_revenue_usd * growth) / 1000) * 1000
    } else {
      // industry switch — pick a different one
      const others = INDUSTRIES.filter((x) => x !== customer.industry)
      new_value = faker.helpers.arrayElement(others)
    }

    updates.push({
      kind: "customer_field",
      id: `upd-field-${String(i).padStart(3, "0")}`,
      date: randomUpdateDate(faker),
      customer_name: customer.name,
      field,
      new_value,
    })
  }

  // New customers (appear only in updates, not in CSV v1)
  const existingNames = new Set(customers.map((c) => c.name))
  for (let i = 0; i < newCustomerCount; i++) {
    let first: string, last: string, name: string
    do {
      first = faker.person.firstName()
      last = faker.person.lastName()
      name = `${first} ${last}`
    } while (existingNames.has(name))
    existingNames.add(name)

    const newCustomer: CustomerRecord = {
      name,
      country: faker.helpers.arrayElement(COUNTRIES),
      industry: faker.helpers.arrayElement(INDUSTRIES),
      annual_revenue_usd: Math.round(faker.number.int({ min: 200_000, max: 15_000_000 }) / 1000) * 1000,
      employees: faker.number.int({ min: 10, max: 800 }),
      signup_date: faker.date
        .between({ from: "2025-06-01T00:00:00Z", to: "2025-11-30T23:59:59Z" })
        .toISOString()
        .slice(0, 10),
      status: faker.helpers.arrayElement(["active", "prospect"] as const),
    }

    updates.push({
      kind: "new_customer",
      id: `upd-new-${String(i).padStart(3, "0")}`,
      date: newCustomer.signup_date,
      customer: newCustomer,
    })
  }

  // Churn events (status → churned, targets existing active customers)
  // Pick distinct customers to avoid double-churning one.
  const churnPool = [...activeCustomers]
  for (let i = 0; i < churnCount && churnPool.length > 0; i++) {
    const idx = faker.number.int({ min: 0, max: churnPool.length - 1 })
    const customer = churnPool.splice(idx, 1)[0]

    updates.push({
      kind: "churn",
      id: `upd-churn-${String(i).padStart(3, "0")}`,
      date: randomUpdateDate(faker),
      customer_name: customer.name,
    })
  }

  updates.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))
  return updates
}

function randomUpdateDate(faker: Faker): string {
  return faker.date
    .between({ from: "2025-03-01T00:00:00Z", to: "2025-11-30T23:59:59Z" })
    .toISOString()
    .slice(0, 10)
}
