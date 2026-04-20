#!/usr/bin/env bun
/**
 * SRB runner CLI.
 *
 * Usage:
 *   bun run src/runner.ts --provider full-context
 *   bun run src/runner.ts --provider full-context --dry-run
 *   bun run src/runner.ts --provider full-context --questions 10
 *
 * Extending to memorybench providers:
 *   If /Users/.../memorybench is cloned alongside SRB, the runner will try to
 *   dynamic-import its provider factory. Not present → only full-context is
 *   available (other providers error out with a clear message).
 *
 * Archive path: results/YYYY-MM-DD_<provider>_seed42.json
 */

import { writeFileSync, mkdirSync, existsSync } from "fs"
import { join, resolve, dirname } from "path"
import { fileURLToPath } from "url"

import SRBBenchmark from "./benchmark"
import { FullContextProvider } from "./providers/full-context"
import { SandraStructuredProvider } from "./providers/sandra-structured"
import { scoreResponse, composeSummary } from "./scorer"
import { generateAnswer } from "./utils/llm"
import type { Provider } from "./types/memorybench"
import type { QuestionItem } from "./types/domain"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, "..")

interface CliArgs {
  provider: string
  questions?: number
  dryRun: boolean
  classes?: string[]
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { provider: "full-context", dryRun: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--provider" || a === "-p") out.provider = argv[++i]
    else if (a === "--questions" || a === "-n") out.questions = parseInt(argv[++i], 10)
    else if (a === "--dry-run") out.dryRun = true
    else if (a === "--classes") out.classes = argv[++i].split(",")
  }
  return out
}

async function loadProvider(name: string): Promise<Provider> {
  if (name === "full-context") return new FullContextProvider()
  if (name === "sandra-structured") return new SandraStructuredProvider()

  // Try loading from sibling memorybench clone
  const mbRoot = resolve(REPO_ROOT, "..", "memorybench")
  if (existsSync(mbRoot)) {
    try {
      const mod = await import(join(mbRoot, "src", "providers", "index.ts"))
      if (typeof mod.createProvider === "function") {
        return mod.createProvider(name) as Provider
      }
    } catch (err) {
      throw new Error(
        `Failed to load provider "${name}" from ${mbRoot}: ${(err as Error).message}\n` +
          `Make sure memorybench is installed as a sibling directory.`
      )
    }
  }

  throw new Error(
    `Provider "${name}" unavailable. Only "full-context" is built in. To use mem0/zep/supermemory/sandra, clone memorybench alongside SRB:\n` +
      `  git clone https://github.com/supermemoryai/memorybench ${mbRoot}`
  )
}

async function main() {
  const args = parseArgs(process.argv)
  console.log(`[runner] provider=${args.provider} dry-run=${args.dryRun}`)

  const bench = new SRBBenchmark()
  await bench.load({ dataPath: "datasets/customer-records-v1" })

  const items = bench.getQuestionItems()
  const sessions = bench.getAllSessions()
  const canonicalNames = [...new Set(sessions.flatMap((s) => extractCanonicalNamesFromSession(s)))]

  let questions: QuestionItem[] = items
  if (args.classes?.length) questions = questions.filter((q) => args.classes!.includes(q.questionClass))
  if (args.questions) {
    // Sample representatively across classes instead of taking the first N
    // (which would concentrate in whatever class is first in items[]).
    const byClass = new Map<string, QuestionItem[]>()
    for (const q of questions) {
      const arr = byClass.get(q.questionClass) ?? []
      arr.push(q)
      byClass.set(q.questionClass, arr)
    }
    const classes = [...byClass.keys()]
    const perClass = Math.max(1, Math.floor(args.questions / classes.length))
    const sampled: QuestionItem[] = []
    for (const cls of classes) sampled.push(...byClass.get(cls)!.slice(0, perClass))
    questions = sampled.slice(0, args.questions)
  }

  console.log(`[runner] ${questions.length} questions across ${sessions.length} sessions`)

  if (args.dryRun) {
    for (const q of questions.slice(0, 5)) {
      console.log(`  [${q.questionClass}] ${q.questionId}: ${q.question.slice(0, 90)}...`)
    }
    if (questions.length > 5) console.log(`  (+${questions.length - 5} more)`)
    console.log(`[runner] dry-run complete — no LLM calls made`)
    return
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error(
      `[runner] OPENAI_API_KEY is required for non-dry-run mode. Set it in your environment or use --dry-run.`
    )
    process.exit(1)
  }

  const provider = await loadProvider(args.provider)
  // Pass provider-specific apiKey when unambiguous; otherwise pass an empty
  // config so each provider reads its own env vars (SUPERMEMORY_API_KEY /
  // MEM0_API_KEY / ZEP_API_KEY / SANDRA_URL+TOKEN / ANTHROPIC_API_KEY).
  // Using process.env.OPENAI_API_KEY universally was wrong: Sandra's
  // extractor interpreted it as an Anthropic key because config.apiKey
  // takes precedence over env resolution inside the extractor.
  const providerConfig = resolveProviderConfig(args.provider)
  await provider.initialize(providerConfig)

  const containerTag = `srb-${Date.now()}`
  const ingestStart = Date.now()
  const ingestResult = await provider.ingest(sessions, { containerTag })
  await provider.awaitIndexing(ingestResult, containerTag)
  const ingestMs = Date.now() - ingestStart
  console.log(`[runner] ingested ${sessions.length} sessions in ${ingestMs}ms`)

  const results: Array<{
    questionId: string
    questionClass: string
    response: string
    score: ReturnType<typeof scoreResponse>
    searchMs: number
    answerMs: number
  }> = []

  async function withRetry<T>(fn: () => Promise<T>, label: string, fallback: T): Promise<T> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      }
    }
    const msg = (lastErr as Error)?.message ?? String(lastErr)
    console.warn(`  ${label} failed after retries: ${msg}`)
    return fallback
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    const searchStart = Date.now()
    const retrieved = await withRetry(
      () => provider.search(q.question, { containerTag, limit: 50 }),
      `[${i + 1}/${questions.length}] search`,
      [] as unknown[]
    )
    const searchMs = Date.now() - searchStart

    const answerStart = Date.now()
    const response = await withRetry(
      () => generateAnswer({ question: q.question, retrieved }),
      `[${i + 1}/${questions.length}] answer`,
      ""
    )
    const answerMs = Date.now() - answerStart

    const score = scoreResponse(response, q.groundTruth, canonicalNames)
    results.push({
      questionId: q.questionId,
      questionClass: q.questionClass,
      response,
      score,
      searchMs,
      answerMs,
    })
    console.log(
      `  [${i + 1}/${questions.length}] ${q.questionClass} ${q.questionId} score=${score.score.toFixed(2)}`
    )
  }

  await provider.clear(containerTag)

  const summary = composeSummary(results.map((r) => ({
    question: questions.find((q) => q.questionId === r.questionId)!,
    score: r.score,
  })))

  const today = new Date().toISOString().slice(0, 10)
  const outPath = join(REPO_ROOT, "results", `${today}_${args.provider}_seed42.json`)
  const resultsDir = dirname(outPath)
  if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true })

  const payload = {
    benchmark: "structured-recall-bench",
    dataset: "customer-records-v1",
    seed: 42,
    provider: args.provider,
    model: process.env.SRB_ANSWER_MODEL ?? "gpt-4o-mini",
    timestamp: new Date().toISOString(),
    summary,
    results,
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8")
  console.log(`[runner] composite=${summary.composite.toFixed(3)} → ${outPath}`)
  console.log(`[runner] per-class: ${JSON.stringify(
    Object.fromEntries(Object.entries(summary.perClass).map(([k, v]) => [k, v.mean.toFixed(3)]))
  )}`)
  console.log(`[runner] reconciliation breakdown: ${JSON.stringify(summary.reconciliationBreakdown)}`)
}

function resolveProviderConfig(name: string): { apiKey?: string } & Record<string, unknown> {
  // Each provider reads its own env vars. We only set apiKey when the
  // provider's initialize() expects a specific key and doesn't read env itself.
  switch (name) {
    case "full-context":
    case "sandra-structured":
      return {}
    case "supermemory":
      return { apiKey: process.env.SUPERMEMORY_API_KEY, baseUrl: process.env.SUPERMEMORY_BASE_URL }
    case "mem0":
      return { apiKey: process.env.MEM0_API_KEY }
    case "zep":
      return { apiKey: process.env.ZEP_API_KEY }
    case "sandra":
      // Sandra provider reads SANDRA_URL/SANDRA_TOKEN and (optionally)
      // ANTHROPIC_API_KEY from env. config.apiKey in its initialize() is
      // specifically the Anthropic extractor key — pass it only if the user
      // has ANTHROPIC_API_KEY; otherwise let the extractor fall through to
      // OPENAI_API_KEY (when SANDRA_EXTRACTOR_MODEL is an OpenAI model).
      return process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}
    default:
      return {}
  }
}

function extractCanonicalNamesFromSession(s: import("./types/memorybench").UnifiedSession): string[] {
  // A customer's name appears in CSV rows; pull anything that looks like "First Last" at line starts.
  const names = new Set<string>()
  for (const m of s.messages) {
    const lines = m.content.split("\n")
    for (const line of lines) {
      // Match "Name, Country," pattern
      const csvMatch = line.match(/^([A-Z][a-zA-ZÀ-ÿ'-]+ [A-Z][a-zA-ZÀ-ÿ'-]+),/)
      if (csvMatch) names.add(csvMatch[1])
      // Match "NewName from Country" or sentence start mentions
      const sentenceMatch = line.match(/^\s*•?\s*([A-Z][a-zA-ZÀ-ÿ'-]+ [A-Z][a-zA-ZÀ-ÿ'-]+)\b/)
      if (sentenceMatch) names.add(sentenceMatch[1])
    }
  }
  return [...names]
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
