/**
 * Response parsing helpers — name fuzzy matching, number extraction.
 *
 * Deterministic, no LLM involvement. Used by the scorer to convert free-form
 * LLM responses into the structured form required to compare against ground truth.
 */

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Scan `response` for occurrences of any canonical name (and its variants).
 * Matching is case-insensitive and accent-insensitive. Returns the set of
 * canonical names (in their original casing) detected in the response.
 */
export function extractMatchedNames(response: string, canonicalNames: string[]): Set<string> {
  const normResponse = normalizeName(response)
  const found = new Set<string>()
  for (const canonical of canonicalNames) {
    const norm = normalizeName(canonical)
    if (norm.length === 0) continue
    // Use word-boundary-like check: normalized response must contain
    // " <norm> " (surrounded by spaces) OR start/end with it.
    const padded = ` ${normResponse} `
    if (padded.includes(` ${norm} `)) {
      found.add(canonical)
    }
  }
  return found
}

/**
 * Extract the first plausible monetary/integer value from a response. Handles:
 *   $1,234,567       → 1234567
 *   $1.5M            → 1500000
 *   $2.3k or 2.3k    → 2300
 *   1234             → 1234
 *   45%              → 45 (plain number, context-free)
 */
export function extractFirstNumber(response: string): number | null {
  const cleaned = response.replace(/[,_]/g, "")

  // Try $ amounts with M/k suffix first
  const mMatch = cleaned.match(/\$?\s*(\d+(?:\.\d+)?)\s*(M|million|B|billion|k|K|thousand)\b/)
  if (mMatch) {
    const n = parseFloat(mMatch[1])
    const suffix = mMatch[2].toLowerCase()
    if (suffix === "m" || suffix === "million") return Math.round(n * 1_000_000)
    if (suffix === "b" || suffix === "billion") return Math.round(n * 1_000_000_000)
    if (suffix === "k" || suffix === "thousand") return Math.round(n * 1000)
  }

  // Any dollar amount
  const dollarMatch = cleaned.match(/\$\s*(\d+(?:\.\d+)?)/)
  if (dollarMatch) return Math.round(parseFloat(dollarMatch[1]))

  // Plain integer >= 100 (avoid matching single digits used as counters)
  const intMatch = cleaned.match(/\b(\d{3,})\b/)
  if (intMatch) return parseInt(intMatch[1], 10)

  return null
}

/**
 * True if `response` contains `needle` as a whole value — case-insensitive
 * substring check after normalization. Used for reconciliation scoring where
 * the expected value can be "450", "active", or a string industry name.
 */
export function containsValue(response: string, needle: string): boolean {
  const r = normalizeName(response)
  const n = normalizeName(needle)
  if (n.length === 0) return false
  return ` ${r} `.includes(` ${n} `) || r.startsWith(`${n} `) || r.endsWith(` ${n}`) || r === n
}
