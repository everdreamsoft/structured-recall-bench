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
 * Extract the plausible aggregate answer from a response. LLMs often show
 * their work ("$A + $B + $C = $TOTAL") and the final answer is typically
 * the LAST monetary value with a $ prefix or M/B/k suffix. We pick that.
 *
 * Handles:
 *   $1,234,567       → 1234567
 *   $1.5M            → 1500000
 *   $2.3k or 2.3k    → 2300
 *   1234             → 1234
 */
export function extractFirstNumber(response: string): number | null {
  const cleaned = response.replace(/[,_]/g, "")

  // Collect all candidates with positions so we can pick the LAST.
  const candidates: Array<{ value: number; index: number }> = []

  // $ amounts with M/k/B suffix
  const mRegex = /\$?\s*(\d+(?:\.\d+)?)\s*(M|million|B|billion|k|K|thousand)\b/g
  let match: RegExpExecArray | null
  while ((match = mRegex.exec(cleaned)) !== null) {
    const n = parseFloat(match[1])
    const suffix = match[2].toLowerCase()
    let value = n
    if (suffix === "m" || suffix === "million") value = n * 1_000_000
    else if (suffix === "b" || suffix === "billion") value = n * 1_000_000_000
    else if (suffix === "k" || suffix === "thousand") value = n * 1000
    candidates.push({ value: Math.round(value), index: match.index })
  }

  // Plain dollar amounts
  const dRegex = /\$\s*(\d+(?:\.\d+)?)/g
  while ((match = dRegex.exec(cleaned)) !== null) {
    candidates.push({ value: Math.round(parseFloat(match[1])), index: match.index })
  }

  // Fall back to plain integers if nothing else. We relax to \d+ (any length)
  // because reconciliation questions on small fields like employee counts can
  // legitimately produce 1-2 digit answers (e.g. "86"). Aggregation picks the
  // LAST candidate anyway, so noise from page numbers or counters won't leak
  // into the final answer.
  if (candidates.length === 0) {
    const intRegex = /\b(\d+)\b/g
    while ((match = intRegex.exec(cleaned)) !== null) {
      candidates.push({ value: parseInt(match[1], 10), index: match.index })
    }
  }

  if (candidates.length === 0) return null
  // Return the LAST candidate by position — that's where the final answer
  // lives when the LLM shows its work.
  candidates.sort((a, b) => a.index - b.index)
  return candidates[candidates.length - 1].value
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
