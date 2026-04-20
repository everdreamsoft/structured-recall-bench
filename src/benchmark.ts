/**
 * SRBBenchmark — implements the memorybench Benchmark interface by loading the
 * pre-generated dataset from datasets/customer-records-v1/.
 *
 * Unlike LongMemEval where each question has its own haystack, SRB treats
 * the corpus as global: every question sees ALL sessions. This is deliberate —
 * the test is "can the memory system hold the whole corpus", not "can it find
 * the needle session". This is what exposes top-K retrievers: they ALL see
 * the same haystack, but only structured/graph systems can enumerate it.
 */

import { readFileSync } from "fs"
import { join } from "path"
import type {
  Benchmark,
  BenchmarkConfig,
  QuestionFilter,
  QuestionTypeRegistry,
  UnifiedQuestion,
  UnifiedSession,
} from "./types/memorybench"
import type { QuestionItem } from "./types/domain"

const DEFAULT_DATA_PATH = "datasets/customer-records-v1"

export const SRB_QUESTION_TYPES: QuestionTypeRegistry = {
  enumeration_csv: {
    id: "enumeration_csv",
    alias: "e-csv",
    description: "Enumeration over CSV-sourced fields (country/industry/status)",
  },
  enumeration_chat: {
    id: "enumeration_chat",
    alias: "e-chat",
    description: "Enumeration over chat-sourced purchase events",
  },
  aggregation_cross_source: {
    id: "aggregation_cross_source",
    alias: "agg",
    description: "Numeric aggregation joining CSV filter with chat events",
  },
  reconciliation_update: {
    id: "reconciliation_update",
    alias: "recon",
    description: "Must return post-update value, not stale v1",
  },
  mixed_conditional: {
    id: "mixed_conditional",
    alias: "mixed",
    description: "Single-answer lookup requiring CSV+chat join",
  },
}

export class SRBBenchmark implements Benchmark {
  name = "structured-recall-bench"
  private items: QuestionItem[] = []
  private sessions: UnifiedSession[] = []
  private dataPath = ""

  async load(config?: BenchmarkConfig): Promise<void> {
    this.dataPath = config?.dataPath ?? DEFAULT_DATA_PATH
    const base = join(process.cwd(), this.dataPath)

    const sessionsRaw = readFileSync(join(base, "sessions.json"), "utf8")
    const questionsRaw = readFileSync(join(base, "questions.json"), "utf8")

    this.sessions = JSON.parse(sessionsRaw) as UnifiedSession[]
    this.items = JSON.parse(questionsRaw) as QuestionItem[]
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let result = [...this.items]
    if (filter?.questionTypes?.length) {
      result = result.filter((q) => filter.questionTypes!.includes(q.questionClass))
    }
    if (filter?.offset) result = result.slice(filter.offset)
    if (filter?.limit) result = result.slice(0, filter.limit)

    return result.map((q) => ({
      questionId: q.questionId,
      question: q.question,
      questionType: q.questionClass,
      groundTruth: JSON.stringify(q.groundTruth),
      haystackSessionIds: q.haystackSessionIds,
      metadata: { groundTruth: q.groundTruth },
    }))
  }

  /** SRB uses a global haystack — every question sees every session. */
  getHaystackSessions(_questionId: string): UnifiedSession[] {
    return this.sessions
  }

  getGroundTruth(questionId: string): string {
    const q = this.items.find((x) => x.questionId === questionId)
    return q ? JSON.stringify(q.groundTruth) : ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return SRB_QUESTION_TYPES
  }

  // SRB-specific accessors (not on Benchmark interface)
  getQuestionItems(): QuestionItem[] {
    return this.items
  }
  getAllSessions(): UnifiedSession[] {
    return this.sessions
  }
}

export default SRBBenchmark
