# Upstream PR note — memorybench Zep provider

Target repo: https://github.com/supermemoryai/memorybench
File: `src/providers/zep/index.ts`

## Bug

`ZepProvider.ingest()` passes `session.metadata.date` directly to
`client.graph.addBatch({ episodes: [{ createdAt: isoDate, ... }] })`.

When the dataset stores dates as bare `YYYY-MM-DD` (no time component),
the Zep Cloud API rejects the batch with:

```
POST https://api.getzep.com/api/v2/graph-batch
→ 400 Bad Request
  { "message": "invalid json" }
```

Reproduced against Zep Cloud (SDK `@getzep/zep-cloud`) on 2026-04-20:

| `createdAt` value          | Result              |
| -------------------------- | ------------------- |
| `"2025-01-03"`             | **400 invalid json** |
| `"2025-01-03T00:00:00Z"`   | 200 OK              |
| omitted                    | 200 OK (server fills now) |

The error message is misleading — the payload *is* valid JSON; Zep's
validator just folds date-format failures into a generic "invalid json".

## Fix

Normalize bare dates to midnight UTC before building the episode:

```diff
 for (const session of sessions) {
-  const isoDate = session.metadata?.date as string | undefined
+  const rawDate = session.metadata?.date as string | undefined
+  const isoDate =
+    rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T00:00:00Z` : rawDate

   for (const message of session.messages) {
     ...
```

Only rewrites bare `YYYY-MM-DD`; full ISO strings pass through unchanged.

## Repro (minimal)

```ts
import { ZepClient } from "@getzep/zep-cloud"
const client = new ZepClient({ apiKey: process.env.ZEP_API_KEY! })
await client.graph.create({ graphId: "repro", name: "repro" })
await client.graph.addBatch({
  graphId: "repro",
  episodes: [{ type: "message", data: "user: hi", createdAt: "2025-01-03" }],
}) // throws BadRequestError: invalid json
```

## Context

Discovered while running Structured Recall Bench
(https://github.com/everdreamsoft/structured-recall-bench) against the
`zep` provider. Dataset sessions carry `metadata.date = "YYYY-MM-DD"`,
which is common for daily-bucketed corpora.

After the fix, the full 20-session / 100-question benchmark runs
cleanly against Zep Cloud (composite 0.396 — ingestion ~15 min, no
API errors).
