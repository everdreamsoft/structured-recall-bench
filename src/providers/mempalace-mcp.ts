/**
 * MemPalace MCP provider — phase B of the MemPalace integration.
 *
 * Unlike the CLI provider (phase A) which shells out to `mempalace mine` and
 * `mempalace search`, this provider speaks the MCP stdio protocol directly to
 * `python -m mempalace.mcp_server --palace <dir>`. It uses two tools:
 *   - mempalace_add_drawer : one call per message, wing=<run>, room=<sessionId>
 *   - mempalace_search     : semantic search, scoped to the run's wing
 *
 * Why this matters:
 *   - MCP search is SEMANTIC (cosine embedding), whereas CLI `search` is
 *     exact-word only. Phase B may recall differently from phase A.
 *   - This matches the ingest granularity used by Zep/Supermemory/Mem0
 *     (one-record-per-message) so the comparison is fair.
 *
 * Each run spawns a dedicated MCP server subprocess keyed by containerTag and
 * tears it down on clear(). The palace directory is a fresh tmpdir so runs do
 * not cross-contaminate.
 */

import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn, type ChildProcessWithoutNullStreams } from "child_process"
import { homedir } from "os"

import type {
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "../types/memorybench"

interface RunState {
  palaceDir: string
  wing: string
  proc: ChildProcessWithoutNullStreams
  buffer: string
  pending: Map<string, (v: JsonRpcEnvelope) => void>
  nextId: number
}

interface JsonRpcEnvelope {
  jsonrpc: "2.0"
  id?: string | number
  method?: string
  params?: unknown
  result?: { content?: Array<{ type: string; text: string }> } & Record<string, unknown>
  error?: { code: number; message: string; data?: unknown }
}

const DEFAULT_PY = join(homedir(), ".local/pipx/venvs/mempalace/bin/python")

export class MemPalaceMCPProvider implements Provider {
  name = "mempalace-mcp"
  private runs = new Map<string, RunState>()
  private python: string

  constructor(python?: string) {
    this.python = python ?? process.env.MEMPALACE_PYTHON ?? DEFAULT_PY
  }

  async initialize(_config: ProviderConfig): Promise<void> {
    // Lazy — server starts in ingest().
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const palaceDir = mkdtempSync(join(tmpdir(), `mempalace-mcp-${options.containerTag}-`))
    const wing = `srb_${options.containerTag.replace(/[^a-zA-Z0-9_]/g, "_")}`
    const proc = spawn(this.python, ["-m", "mempalace.mcp_server", "--palace", palaceDir], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    const run: RunState = {
      palaceDir,
      wing,
      proc,
      buffer: "",
      pending: new Map(),
      nextId: 1,
    }
    this.runs.set(options.containerTag, run)

    proc.stdout.setEncoding("utf8")
    proc.stdout.on("data", (chunk: string) => this.onStdout(run, chunk))
    proc.stderr.on("data", () => {
      // MemPalace logs progress noise to stderr — ignore.
    })
    proc.on("exit", (code) => {
      for (const [, resolve] of run.pending) {
        resolve({ jsonrpc: "2.0", error: { code: -1, message: `server exited ${code}` } })
      }
      run.pending.clear()
    })

    // MCP handshake
    await this.rpc(run, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "srb-mempalace-mcp", version: "0.1" },
    })
    this.notify(run, "notifications/initialized", {})

    // Ingest: one drawer per message. Room = sessionId, content = speaker + text.
    const documentIds: string[] = []
    for (const session of sessions) {
      const room = this.sanitize(session.sessionId)
      const date = (session.metadata?.date as string | undefined) ?? ""
      for (let i = 0; i < session.messages.length; i++) {
        const m = session.messages[i]
        const speaker = m.speaker || m.role
        const prefix = date ? `[${date}] ` : ""
        const content = `${prefix}${speaker}: ${m.content}`
        await this.rpc(run, "tools/call", {
          name: "mempalace_add_drawer",
          arguments: {
            wing,
            room,
            content,
            source_file: `${session.sessionId}#${i}`,
            added_by: "srb",
          },
        })
        documentIds.push(`${session.sessionId}#${i}`)
      }
    }

    return { documentIds }
  }

  async awaitIndexing(): Promise<void> {
    // add_drawer is synchronous — nothing more to wait for.
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const run = this.runs.get(options.containerTag)
    if (!run) throw new Error(`No ingest for containerTag ${options.containerTag}`)

    // mempalace_search caps query at 250 chars.
    const q = query.slice(0, 250)
    const limit = Math.min(options.limit ?? 20, 100)
    const resp = await this.rpc(run, "tools/call", {
      name: "mempalace_search",
      arguments: { query: q, wing: run.wing, limit },
    })
    const text = this.extractText(resp)
    if (!text) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return [{ content: text }]
    }
    const results = this.coerceResults(parsed)
    return results
  }

  async clear(containerTag: string): Promise<void> {
    const run = this.runs.get(containerTag)
    if (!run) return
    try {
      run.proc.stdin.end()
    } catch {}
    try {
      run.proc.kill("SIGTERM")
    } catch {}
    if (existsSync(run.palaceDir)) rmSync(run.palaceDir, { recursive: true, force: true })
    this.runs.delete(containerTag)
  }

  // ─── MCP plumbing ───────────────────────────────────────────────────────

  private sanitize(s: string): string {
    return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "default"
  }

  private onStdout(run: RunState, chunk: string): void {
    run.buffer += chunk
    let idx: number
    while ((idx = run.buffer.indexOf("\n")) !== -1) {
      const line = run.buffer.slice(0, idx).trim()
      run.buffer = run.buffer.slice(idx + 1)
      if (!line) continue
      let env: JsonRpcEnvelope
      try {
        env = JSON.parse(line) as JsonRpcEnvelope
      } catch {
        continue
      }
      if (env.id !== undefined) {
        const key = String(env.id)
        const resolver = run.pending.get(key)
        if (resolver) {
          run.pending.delete(key)
          resolver(env)
        }
      }
    }
  }

  private notify(run: RunState, method: string, params: unknown): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"
    run.proc.stdin.write(payload)
  }

  private rpc(run: RunState, method: string, params: unknown): Promise<JsonRpcEnvelope> {
    const id = String(run.nextId++)
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
    return new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (run.pending.has(id)) {
          run.pending.delete(id)
          reject(new Error(`MCP ${method} timed out after 60s`))
        }
      }, 60_000)
      run.pending.set(id, (env) => {
        clearTimeout(timer)
        if (env.error) {
          reject(new Error(`MCP ${method} error ${env.error.code}: ${env.error.message}`))
        } else {
          resolve(env)
        }
      })
      run.proc.stdin.write(payload)
    })
  }

  private extractText(env: JsonRpcEnvelope): string | null {
    const content = env.result?.content
    if (Array.isArray(content) && content.length > 0 && content[0]?.type === "text") {
      return content[0].text
    }
    return null
  }

  private coerceResults(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed.map((x) => this.normalizeHit(x))
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      if (Array.isArray(obj.results)) return obj.results.map((x) => this.normalizeHit(x))
      if (Array.isArray(obj.drawers)) return obj.drawers.map((x) => this.normalizeHit(x))
      return [this.normalizeHit(parsed)]
    }
    return []
  }

  private normalizeHit(x: unknown): unknown {
    if (x && typeof x === "object") {
      const obj = x as Record<string, unknown>
      const content = obj.content ?? obj.text ?? obj.drawer ?? JSON.stringify(obj).slice(0, 2000)
      return { content, ...obj }
    }
    return { content: String(x) }
  }
}
