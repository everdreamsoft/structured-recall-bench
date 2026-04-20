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

const DEFAULT_MODEL = process.env.SRB_ANSWER_MODEL ?? "gpt-4o-mini"

const SYSTEM_PROMPT = `You are a helpful assistant analyzing a synthetic CRM dataset. The user has given you access to customer records (from CSV uploads) and purchase events / corrections (from chat messages). Answer the user's question using ONLY the provided context. If the question asks for a list of names, respond with a comma-separated list. If it asks for a number, respond with the number. Be concise and precise. If the context contains updates or corrections to earlier data, prefer the most recent value.`

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
