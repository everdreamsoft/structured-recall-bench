/**
 * Memorybench interface contracts — vendored for standalone stability.
 *
 * Provenance: github.com/supermemoryai/memorybench @ 852c38e4acef
 *   src/types/benchmark.ts
 *   src/types/unified.ts
 *   src/types/provider.ts
 *
 * Why vendored and not imported:
 *   memorybench's package.json has no "main"/"exports", so it cannot be
 *   consumed as an npm/git dependency. Copying the 3 type files here keeps
 *   SRB fully standalone. If memorybench changes its interface upstream,
 *   SRB continues to work; bumping the copy becomes a one-line review.
 *
 * Do NOT edit these types to fit SRB-specific needs — put SRB-only types
 * in src/types/domain.ts instead.
 */

// ─── from benchmark.ts ────────────────────────────────────────────────────

export interface BenchmarkConfig {
  dataPath?: string
}

export interface QuestionFilter {
  questionTypes?: string[]
  limit?: number
  offset?: number
}

export interface Benchmark {
  name: string
  load(config?: BenchmarkConfig): Promise<void>
  getQuestions(filter?: QuestionFilter): UnifiedQuestion[]
  getHaystackSessions(questionId: string): UnifiedSession[]
  getGroundTruth(questionId: string): string
  getQuestionTypes(): QuestionTypeRegistry
}

// ─── from unified.ts ──────────────────────────────────────────────────────

export interface QuestionTypeInfo {
  id: string
  alias: string
  description: string
}

export type QuestionTypeRegistry = Record<string, QuestionTypeInfo>

export interface UnifiedMessage {
  role: "user" | "assistant"
  content: string
  timestamp?: string
  speaker?: string
}

export interface UnifiedSession {
  sessionId: string
  messages: UnifiedMessage[]
  metadata?: Record<string, unknown>
}

export interface UnifiedQuestion {
  questionId: string
  question: string
  questionType: string
  groundTruth: string
  haystackSessionIds: string[]
  metadata?: Record<string, unknown>
}

export type SearchResult = unknown

export interface EvaluationResult {
  questionId: string
  questionType: string
  question: string
  score: number
  label: "correct" | "incorrect"
  explanation: string
  hypothesis: string
  groundTruth: string
  searchResults: SearchResult[]
  searchDurationMs: number
  answerDurationMs: number
  totalDurationMs: number
}

// ─── from provider.ts ─────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  [key: string]: unknown
}

export interface IngestOptions {
  containerTag: string
  metadata?: Record<string, unknown>
}

export interface SearchOptions {
  containerTag: string
  limit?: number
  threshold?: number
}

export interface IngestResult {
  documentIds: string[]
  taskIds?: string[]
}

export interface IndexingProgress {
  completedIds: string[]
  failedIds: string[]
  total: number
}

export type IndexingProgressCallback = (progress: IndexingProgress) => void

export interface Provider {
  name: string
  initialize(config: ProviderConfig): Promise<void>
  ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult>
  awaitIndexing(
    result: IngestResult,
    containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void>
  search(query: string, options: SearchOptions): Promise<unknown[]>
  clear(containerTag: string): Promise<void>
}
