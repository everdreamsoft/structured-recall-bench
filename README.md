# Structured Recall Bench (SRB)

> Maintained by **EverDreamSoft** — the team behind [Sandra](https://github.com/everdreamsoft/sandra), a semantic graph database used as Anthropic MCP memory. Disclosure up front: Sandra is our system. This benchmark was built to measure a capability gap we believe the current category is structurally unable to address — see the thesis below. Every run is archived in `results/` with the exact prompt, seed, and model used, so our numbers can be independently reproduced or contested.

A benchmark exposing **exhaustive recall** and **knowledge reconciliation** gaps in agent memory systems. Tests five dimensions that semantic top-K retrievers cannot satisfy by construction:

1. **Enumeration over CSV-sourced fields** — *"list all active customers in France"*
2. **Enumeration over chat-sourced events** — *"which customers bought paper from us in 2025"*
3. **Cross-source aggregation** — *"total spend from French customers"*
4. **Knowledge-update reconciliation** — *"what is Alice's current employee count?"* (after chat/CSV v2 overrides)
5. **Mixed conditional lookup** — *"largest French customer by total spend"*

## Thesis

Benchmarks like LongMemEval, LoCoMo, and ConvoMem all measure the same thing: **can the system retrieve one relevant fact from a conversational haystack**. That is top-K similarity retrieval — exactly what Mem0, Zep, Supermemory, MemPalace, and Letta are optimized for. They cluster at 70–85% on those benchmarks because they all solve the same problem the same way.

What these benchmarks do **not** measure is whether a system can **enumerate every entity** matching a structured criterion, **aggregate** across them, or **reconcile** contradictory versions of a fact. A top-K index is architecturally incapable of returning "all N that match" — it returns the K most similar to the query, whether or not those are the ones you need.

Structured/graph systems (Sandra, Letta's SQL-backed memory, any retrieval-augmented agent with real filtering) solve these trivially by construction. SRB makes that gap measurable.

## What you should observe

When the benchmark runs cleanly against the category, the expected pattern is:

| Provider          | Expected composite | Why                                     |
| ----------------- | -----------------: | --------------------------------------- |
| `full-context`    |              90-98 | Positive control — haystack in-prompt   |
| `mem0` / `zep` / `supermemory` | 15-40 | Top-K cannot enumerate exhaustively      |
| `sandra`          |              85-100 | Structured graph with typed refs        |
| `filesystem`      |              80-95 | Stores raw text; LLM reads full context |

If `full-context` doesn't hit 85%+, the questions are ambiguous — file an issue. If `sandra` doesn't hit 85%+, we have a Sandra bug to fix. If a top-K retriever hits 60%+, the questions aren't discriminating — file an issue.

## Quickstart

Requires **bun ≥ 1.3** and, for non-dry-run mode, `OPENAI_API_KEY`.

```bash
git clone https://github.com/everdreamsoft/structured-recall-bench
cd structured-recall-bench
bun install

# 1. Generate the dataset (byte-deterministic, seed=42)
bun run generate

# 2. Validate self-consistency
bun run validate

# 3. Dry-run (no LLM calls) — lists questions, confirms wiring
bun run src/runner.ts --provider full-context --dry-run

# 4. Actual run with full-context baseline (requires OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...
bun run src/runner.ts --provider full-context
```

Output is archived at `results/YYYY-MM-DD_<provider>_seed42.json` — commit these for leaderboard reproducibility.

## Dataset

`datasets/customer-records-v1/` contains:

- **500 customers** generated with `@faker-js/faker` (seed=42) across 20 countries × 10 industries, with `annual_revenue_usd`, `employees`, `signup_date`, `status`
- **200 purchase events** referencing customers by name (product, amount, date in 2025)
- **50 updates**: field corrections (employees/revenue/industry), new late-cycle customers, churn events — applied in temporal order to derive the unified truth
- **~20 synthesized sessions** covering four interaction patterns:
  - **A)** Bulk CSV v1 uploads (~8 sessions) dumping the initial corpus
  - **B)** Conversational chat updates (~6 sessions) with purchase events and field corrections
  - **C)** CSV v2 differentials (~3 sessions) with the changed/new rows since v1
  - **D)** Narrative multi-entity recaps (~3 sessions) referencing several customers at once
- **100 questions** (5 classes × 20) with deterministic ground truth

All outputs are checked in. `bun run generate` is byte-reproducible — CI can verify with `git diff --exit-code datasets/`.

## Scoring

Deterministic, **no LLM-judge**:

| Class                         | Scorer                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `enumeration_csv`             | F1 on names (accent- and case-insensitive fuzzy match)              |
| `enumeration_chat`            | F1 on names                                                         |
| `aggregation_cross_source`    | Continuous: `max(0, 1 - relative_delta)`                             |
| `reconciliation_update`       | Exact match post-update; response = v1 value scored 0 as `stale-v1` |
| `mixed_conditional`           | Name fuzzy match + first-mention heuristic                          |

Composite = mean of per-class means. The reconciliation breakdown (`correct` / `stale-v1` / `wrong` / `no-answer`) is a diagnostic signal: high `stale-v1` means the provider retrieved the original fact instead of the latest.

## Supported providers

| Provider         | Available   | Source                                                |
| ---------------- | ----------- | ----------------------------------------------------- |
| `full-context`   | Built in    | `src/providers/full-context.ts`                       |
| `mem0`, `zep`, `supermemory`, `sandra`, `filesystem`, `rag` | When memorybench is cloned as a sibling directory | `github.com/supermemoryai/memorybench` |

To enable external providers:

```bash
# From one directory above structured-recall-bench:
git clone https://github.com/supermemoryai/memorybench
cd memorybench && bun install
```

## Methodology notes

- **Default LLM**: `gpt-4.1-mini`. Override via `SRB_ANSWER_MODEL`.
- **Answer prompt**: "Answer using ONLY the provided context. Prefer the most recent value if there are updates." Kept deliberately narrow — no chain-of-thought, no tool use — to match how most agent-memory products are wired today.
- **Same LLM, same temperature** across all providers. Any score difference is attributable to retrieval, not to answer generation.
- **Token budget**: the haystack is ~50-70k tokens — comfortably inside `gpt-4.1-mini`'s 128k context for the full-context baseline.

## License

MIT — see `LICENSE`.

## Disclosure

**Sandra** is developed by EverDreamSoft and is one of the providers benchmarked here. The benchmark was designed to be defensible if a reviewer inspects it: if a concurrent provider can do better with a feature it documents but isn't used here, we'll add support for it and re-run. Open a PR or issue if you spot test design that unfairly disadvantages another provider. Our position is that the dominant agent-memory category has an architectural gap; if that turns out to be wrong, the numbers here will say so first.
