/**
 * Answer generation — calls an LLM with the question and the retrieved context
 * (sessions returned by the provider's search). Keeps the prompt narrow:
 * no chain-of-thought, no tool use, just "here is context, here is question,
 * give your answer". This matches how most agent-memory products are wired
 * today and keeps the benchmark fair across providers.
 *
 * Model is gpt-4o-mini by default (cheap, fast, 128k context). Override via
 * SRB_ANSWER_MODEL env var. Requires OPENAI_API_KEY.
 */

import { generateText } from "ai"
import { openai } from "@ai-sdk/openai"
import type { UnifiedSession } from "../types/memorybench"

const DEFAULT_MODEL = process.env.SRB_ANSWER_MODEL ?? "gpt-4.1-mini"

const SYSTEM_PROMPT = `You are a data analyst answering questions about a CRM dataset. The context contains customer records (CSV rows formatted as: name,country,industry,annual_revenue_usd,employees,signup_date,status) and purchase events / corrections from chat messages.

HOW TO ANSWER:
1. Scan the ENTIRE context carefully — do not skip any CSV row or message. The data is spread across multiple sessions.
2. For enumeration questions ("list all X where Y"), return EVERY matching customer. Exhaustiveness is mandatory — a partial list is wrong.
3. For aggregation questions ("total X" / "sum of Y"), compute the total by summing ALL relevant amounts. Do your best even with partial data; always give a number.
4. For "who is the largest/top X" questions, always name your best candidate based on the data. Do not refuse.
5. If the context contains updates or corrections to earlier data, ALWAYS use the most recent value.
6. Answer using ONLY information present in the context. Do not invent names.

FORMAT:
- List questions → comma-separated names ONLY (e.g., "Alice Dupont, Bob Smith")
- Number questions → the number with $ prefix for money (e.g., "$1,234,567")
- Single-name questions → just the full name
- If genuinely zero records match an enumeration, answer exactly "None"`

export interface AnswerInput {
  question: string
  retrieved: unknown[] // what the provider returned; may be sessions or provider-specific hits
  /** If sessions were returned, flatten them into CSV-ish text for the prompt. */
  questionDate?: string
}

export async function generateAnswer(input: AnswerInput): Promise<string> {
  const context = flattenContext(input.retrieved)
  const prompt = `Context:\n${context}\n\nQuestion: ${input.question}\n\nAnswer:`

  const { text } = await generateText({
    model: openai(DEFAULT_MODEL),
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0,
  })
  return text.trim()
}

function flattenContext(retrieved: unknown[]): string {
  // If the items look like UnifiedSession objects, concatenate their messages.
  const parts: string[] = []
  for (const item of retrieved) {
    if (isUnifiedSession(item)) {
      const lines = item.messages.map((m) => `[${m.role}] ${m.content}`)
      parts.push(`--- session ${item.sessionId}${item.metadata?.date ? ` (${String(item.metadata.date)})` : ""} ---\n${lines.join("\n")}`)
    } else if (typeof item === "string") {
      parts.push(item)
    } else {
      parts.push(JSON.stringify(item))
    }
  }
  return parts.join("\n\n")
}

function isUnifiedSession(x: unknown): x is UnifiedSession {
  return (
    typeof x === "object" &&
    x !== null &&
    "sessionId" in x &&
    "messages" in x &&
    Array.isArray((x as { messages: unknown }).messages)
  )
}
