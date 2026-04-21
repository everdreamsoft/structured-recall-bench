# Structured Recall Bench (SRB)

![SRB scoreboard](results/scoreboard.svg)

**→ [Interactive dashboard](https://raw.githack.com/everdreamsoft/structured-recall-bench/main/results/dashboard.html)** (per-class breakdown, recon diagnostics, latency, provider toggles).

A benchmark exposing **exhaustive recall** and **knowledge reconciliation** gaps in agent memory systems. Every run is archived in `results/` with the exact prompt, seed, and model used, so the numbers below can be independently reproduced or contested.

## Question classes

130 deterministic questions across 8 classes. Classes 1–5 (the core suite, 20 questions each) target capabilities that top-K similarity retrievers cannot satisfy by construction. Classes 6–8 (the hard suite, 10 questions each) stack additional constraints on top.

1. **Enumeration over CSV-sourced fields** — *"list all active customers in France"*
2. **Enumeration over chat-sourced events** — *"which customers bought paper from us in 2025"*
3. **Cross-source aggregation** — *"total spend from French customers"*
4. **Knowledge-update reconciliation** — *"what is Alice's current employee count?"* (after chat/CSV v2 overrides)
5. **Mixed conditional lookup** — *"largest French customer by total spend"*
6. **Multi-condition enumeration** — *"active French customers in Manufacturing with >500 employees"*
7. **Multi-condition aggregation** — *"mean deal size among active French customers"*
8. **Bootstrap multi-hop** — questions requiring the system to first enumerate a set, then aggregate/filter against unrelated facts

## Thesis

Benchmarks like LongMemEval, LoCoMo, and ConvoMem measure the same thing: **can the system retrieve one relevant fact from a conversational haystack**. That is top-K similarity retrieval — exactly what Mem0, Zep, Supermemory, MemPalace, and Letta are optimized for. They cluster at 70–85% on those benchmarks because they all solve the same problem the same way.

What these benchmarks do **not** measure is whether a system can **enumerate every entity** matching a structured criterion, **aggregate** across them, or **reconcile** contradictory versions of a fact. A top-K index is architecturally incapable of returning "all N that match" — it returns the K most similar to the query, whether or not those are the ones you need.

Structured/graph systems (Sandra with a query planner, any retrieval-augmented agent with real filtering) solve these trivially by construction. SRB makes that gap measurable.

## Results (seed 42, 130 questions, `gpt-4.1-mini`)

| Provider            | Composite | Enum CSV | Enum Chat | Agg  | Reconcile | Mixed | Multi-Enum | Multi-Agg | Bootstrap |
| ------------------- | --------: | -------: | --------: | ---: | --------: | ----: | ---------: | --------: | --------: |
| `sandra-structured` |      0.89 |     1.00 |      1.00 | 1.00 |      1.00 |  1.00 |       1.00 |      1.00 |      0.09 |
| `mempalace-mcp`     |      0.48 |     0.51 |      0.58 | 0.37 |      0.90 |  0.30 |       0.37 |      0.48 |      0.34 |
| `full-context`      |      0.40 |     0.46 |      0.49 | 0.20 |      0.90 |  0.20 |       0.40 |      0.29 |      0.29 |
| `sandra`            |      0.40 |     0.46 |      0.65 | 0.15 |      1.00 |  0.05 |       0.40 |      0.26 |      0.19 |
| `zep`               |      0.33 |     0.49 |      0.77 | 0.22 |      0.45 |  0.05 |       0.51 |      0.10 |      0.07 |
| `supermemory`       |      0.29 |     0.05 |      0.73 | 0.21 |      0.85 |  0.00 |       0.40 |      0.00 |      0.04 |
| `mem0`              |      0.25 |     0.04 |      0.49 | 0.18 |      0.65 |  0.00 |       0.50 |      0.00 |      0.15 |
| `mempalace`         |      0.19 |     0.04 |      0.78 | 0.05 |      0.40 |  0.00 |       0.10 |      0.00 |      0.11 |

Observations from the run:

- **`sandra-structured` (Sandra + a query planner that emits typed graph traversals) hits 1.00 on all seven structured classes.** The only class it drops is `bootstrap_multihop`, which is hard for every provider — see below.
- **`full-context` is only 0.40 — not a positive control.** With ~60k tokens in-prompt, `gpt-4.1-mini` fails to enumerate exhaustively (0.46 on `enumeration_csv`). The fact that *no* provider clears 50% without a query planner is the core finding, not a bug.
- **Top-K retrievers (mem0, zep, supermemory, mempalace) collapse on enumeration and mixed conditional** — 0.00–0.05 on `mixed_conditional`, often <0.10 on `enumeration_csv`. This is the structural gap the benchmark was built to expose.
- **`bootstrap_multihop` is hard for everyone (≤0.34).** Current systems can't reliably chain "enumerate set A, then aggregate B against A." This is the frontier.
- **Reconciliation does not require a graph.** Several top-K systems do reasonably well (0.65–0.90), because reconciliation is just "return the latest fact," which similarity retrieval often lucks into.

See `results/dashboard.html` (generated from the JSON files) for the full interactive view.

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

Output is archived at `results/YYYY-MM-DD_<provider>_seed42.json` — commit these for leaderboard reproducibility. The hard-suite runs are stored alongside as `*_seed42_hard.json`.

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
- **130 questions** (5 core × 20 + 3 hard × 10) with deterministic ground truth

All outputs are checked in. `bun run generate` is byte-reproducible — CI can verify with `git diff --exit-code datasets/`.

## Scoring

Deterministic, **no LLM-judge**:

| Class                         | Scorer                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `enumeration_csv` / `_chat`   | F1 on names (accent- and case-insensitive fuzzy match)              |
| `aggregation_cross_source`    | Continuous: `max(0, 1 - relative_delta)`                            |
| `reconciliation_update`       | Exact match post-update; response = v1 value scored 0 as `stale-v1` |
| `mixed_conditional`           | Name fuzzy match + first-mention heuristic                          |
| `multi_condition_*`           | F1 / relative-delta with all predicates applied                     |
| `bootstrap_multihop`          | Composite of sub-step scores                                        |

Composite = mean of per-class means. The reconciliation breakdown (`correct` / `stale-v1` / `wrong` / `no-answer`) is a diagnostic signal: high `stale-v1` means the provider retrieved the original fact instead of the latest.

## Supported providers

**Built-in** (no external dependency — cloning SRB is enough):

| Provider            | Source                                                 |
| ------------------- | ------------------------------------------------------ |
| `full-context`      | `src/providers/full-context.ts`                        |
| `sandra-structured` | `src/providers/sandra-structured.ts` (graph + planner) |
| `mempalace`         | `src/providers/mempalace.ts`                           |
| `mempalace-mcp`     | `src/providers/mempalace-mcp.ts`                       |
| `mem0-planned`      | `src/providers/mem0-planned.ts`                        |

**Via memorybench** (requires cloning `github.com/supermemoryai/memorybench` as a sibling directory):

| Provider                                         | Notes                                      |
| ------------------------------------------------ | ------------------------------------------ |
| `mem0`, `zep`, `supermemory`, `filesystem`, `rag` | Hosted/managed retrievers — each needs its own API key (see `.env.example`) |

```bash
# From one directory above structured-recall-bench:
git clone https://github.com/supermemoryai/memorybench
cd memorybench && bun install
```

Reproducing *only* the built-in providers (`sandra-structured`, `full-context`, `mempalace-mcp`, `mempalace`) does not require memorybench. The archived JSON in `results/` lets you inspect the full leaderboard without running the top-K providers yourself.

## Methodology notes

- **Default LLM**: `gpt-4.1-mini`. Override via `SRB_ANSWER_MODEL`.
- **Answer prompt**: "Answer using ONLY the provided context. Prefer the most recent value if there are updates." Kept deliberately narrow — no chain-of-thought, no tool use — to match how most agent-memory products are wired today.
- **Same LLM, same temperature** across all providers. Any score difference is attributable to retrieval, not to answer generation.
- **Token budget**: the haystack is ~50–70k tokens — comfortably inside `gpt-4.1-mini`'s 128k context for the full-context baseline.

## License

MIT — see `LICENSE`.

## Disclosure

This benchmark is maintained by **EverdreamSoft**, the team behind [Sandra](https://github.com/everdreamsoft/sandra) — a semantic graph database exposed as an MCP server. Sandra is one of the providers benchmarked here, and `sandra-structured` (Sandra + a query planner) tops the leaderboard. That outcome is the reason we built the benchmark; it is also the reason we made every run reproducible from a fixed seed, kept the scorer deterministic (no LLM-judge), and checked in the raw JSON for every provider. If a concurrent provider can do better with a feature it documents but we didn't use, we'll add support and re-run. Open a PR or issue if you spot test design that unfairly disadvantages another provider. Our position is that the dominant agent-memory category has an architectural gap; if that turns out to be wrong, the numbers in `results/` will say so first.
