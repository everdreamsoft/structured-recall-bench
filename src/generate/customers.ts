/**
 * Seeded customer generation — produces CustomerRecord[] deterministically.
 *
 * The canonical reference axis is `name` (unique across the corpus), so the
 * scoring layer can match LLM answers to the ground truth by fuzzy name.
 * We enforce uniqueness by retrying on collisions.
 */

import { Faker, en } from "@faker-js/faker"
import type { CustomerRecord, CustomerStatus } from "../types/domain"

export const COUNTRIES = [
  "France",
  "Germany",
  "United Kingdom",
  "Italy",
  "Spain",
  "Netherlands",
  "Switzerland",
  "Sweden",
  "Denmark",
  "Poland",
  "United States",
  "Canada",
  "Mexico",
  "Brazil",
  "Australia",
  "Japan",
  "South Korea",
  "Singapore",
  "India",
  "Ireland",
] as const

export const INDUSTRIES = [
  "Fintech",
  "SaaS",
  "Manufacturing",
  "Food & Beverage",
  "Healthcare",
  "Retail",
  "Energy",
  "Media",
  "Education",
  "Logistics",
] as const

export function generateCustomers(seed: number, n: number = 500): CustomerRecord[] {
  const faker = new Faker({ locale: [en], seed })

  const records: CustomerRecord[] = []
  const usedNames = new Set<string>()

  while (records.length < n) {
    const first = faker.person.firstName()
    const last = faker.person.lastName()
    const name = `${first} ${last}`

    if (usedNames.has(name)) continue
    usedNames.add(name)

    const country = faker.helpers.arrayElement(COUNTRIES)
    const industry = faker.helpers.arrayElement(INDUSTRIES)

    // Revenue follows a rough log-normal-ish distribution so that large
    // accounts are rarer than small ones (matches real CRM shapes).
    const revBucket = faker.number.int({ min: 1, max: 100 })
    let annual_revenue_usd: number
    if (revBucket <= 60) annual_revenue_usd = faker.number.int({ min: 100_000, max: 2_000_000 })
    else if (revBucket <= 90) annual_revenue_usd = faker.number.int({ min: 2_000_000, max: 20_000_000 })
    else annual_revenue_usd = faker.number.int({ min: 20_000_000, max: 200_000_000 })
    annual_revenue_usd = Math.round(annual_revenue_usd / 1000) * 1000

    const employees = faker.number.int({ min: 5, max: 8000 })

    const signup_date = faker.date
      .between({ from: "2020-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z" })
      .toISOString()
      .slice(0, 10)

    const statusRoll = faker.number.int({ min: 1, max: 100 })
    const status: CustomerStatus = statusRoll <= 70 ? "active" : statusRoll <= 85 ? "prospect" : "churned"

    records.push({
      name,
      country,
      industry,
      annual_revenue_usd,
      employees,
      signup_date,
      status,
    })
  }

  // Sort by name for byte-stable output regardless of generator internals.
  records.sort((a, b) => a.name.localeCompare(b.name))
  return records
}
