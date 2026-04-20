/**
 * Full-context baseline provider.
 *
 * Stores all ingested sessions in memory and returns them all on every search.
 * This is the "positive control" — if the questions are well-formed, an LLM
 * given the entire corpus as context should score ~90-98% (but not 100%, since
 * some noise in responses is inevitable). Any other provider that underperforms
 * full-context is demonstrating an architectural retrieval gap, not a failure
 * to answer the questions.
 *
 * Kept inline (not exported as a memorybench provider) because its value is
 * as a self-contained sanity check, not as something to ship to other
 * benchmarks.
 */

import type {
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "../types/memorybench"

export class FullContextProvider implements Provider {
  name = "full-context"
  private byContainer = new Map<string, UnifiedSession[]>()

  async initialize(_config: ProviderConfig): Promise<void> {
    // No setup — pure in-memory.
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const existing = this.byContainer.get(options.containerTag) ?? []
    this.byContainer.set(options.containerTag, [...existing, ...sessions])
    return { documentIds: sessions.map((s) => s.sessionId) }
  }

  async awaitIndexing(): Promise<void> {
    // Synchronous — nothing to await.
  }

  async search(_query: string, options: SearchOptions): Promise<unknown[]> {
    return this.byContainer.get(options.containerTag) ?? []
  }

  async clear(containerTag: string): Promise<void> {
    this.byContainer.delete(containerTag)
  }
}
