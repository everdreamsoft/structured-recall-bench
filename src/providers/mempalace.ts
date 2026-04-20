/**
 * MemPalace CLI provider.
 *
 * MemPalace has no stable Python API surface — its __init__.py only exports
 * __version__. The supported integration path is the `mempalace` CLI, which
 * mines a directory of files into a palace and answers exact-word searches.
 *
 * Strategy:
 *   1. ingest(): materialize each UnifiedSession as a markdown file inside a
 *      temp directory keyed by containerTag, then run
 *        mempalace init <dir> --yes
 *        mempalace mine <dir> --mode convos --wing <tag> --extract general
 *      with --palace pointing at an isolated palace directory so runs don't
 *      cross-contaminate one another (MemPalace's default palace is global).
 *   2. search(): run `mempalace search <query> --wing <tag> --results N`
 *      and return the raw lines as pseudo-documents for the answer LLM.
 *   3. clear(): rm -rf both the session dir and the palace dir.
 *
 * Requires `mempalace` on PATH (install via `pipx install mempalace`).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"

import type {
  IngestOptions,
  IngestResult,
  Provider,
  ProviderConfig,
  SearchOptions,
  UnifiedSession,
} from "../types/memorybench"

interface RunState {
  sessionDir: string
  palaceDir: string
  wing: string
}

export class MemPalaceProvider implements Provider {
  name = "mempalace"
  private runs = new Map<string, RunState>()
  private bin = "mempalace"

  async initialize(_config: ProviderConfig): Promise<void> {
    const probe = spawnSync(this.bin, ["--help"], { encoding: "utf8" })
    if (probe.status !== 0) {
      throw new Error(
        `mempalace binary not found on PATH. Install via \`pipx install mempalace\`.`
      )
    }
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    const root = mkdtempSync(join(tmpdir(), `mempalace-${options.containerTag}-`))
    const sessionDir = join(root, "sessions")
    const palaceDir = join(root, "palace")
    mkdirSync(sessionDir, { recursive: true })
    mkdirSync(palaceDir, { recursive: true })

    const wing = `srb_${options.containerTag.replace(/[^a-zA-Z0-9_]/g, "_")}`
    this.runs.set(options.containerTag, { sessionDir, palaceDir, wing })

    for (const session of sessions) {
      const file = join(sessionDir, `${session.sessionId}.md`)
      const date = (session.metadata?.date as string | undefined) ?? ""
      const header = [
        `---`,
        `sessionId: ${session.sessionId}`,
        date ? `date: ${date}` : null,
        `---`,
        ``,
      ].filter(Boolean).join("\n")
      const body = session.messages
        .map((m) => `**${m.speaker || m.role}**: ${m.content}`)
        .join("\n\n")
      writeFileSync(file, header + body + "\n", "utf8")
    }

    this.runCli(["init", sessionDir, "--yes"], palaceDir, 120_000)
    this.runCli(
      [
        "mine",
        sessionDir,
        "--mode",
        "convos",
        "--wing",
        wing,
        "--extract",
        "general",
        "--agent",
        "srb",
      ],
      palaceDir,
      1_800_000
    )

    return { documentIds: sessions.map((s) => s.sessionId) }
  }

  async awaitIndexing(): Promise<void> {
    // mine is synchronous — nothing to wait for.
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    const run = this.runs.get(options.containerTag)
    if (!run) throw new Error(`No ingest for containerTag ${options.containerTag}`)

    const limit = Math.min(options.limit ?? 20, 50)
    const out = this.runCli(
      ["search", query, "--wing", run.wing, "--results", String(limit)],
      run.palaceDir,
      60_000
    )
    // mempalace search prints human-readable blocks. Return the whole stdout
    // as one synthetic "document" plus the split lines for robustness.
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    return [{ content: out }, ...lines.map((l) => ({ content: l }))]
  }

  async clear(containerTag: string): Promise<void> {
    const run = this.runs.get(containerTag)
    if (!run) return
    const parent = join(run.sessionDir, "..")
    if (existsSync(parent)) rmSync(parent, { recursive: true, force: true })
    this.runs.delete(containerTag)
  }

  private runCli(args: string[], palaceDir: string, timeoutMs: number): string {
    const res = spawnSync(this.bin, ["--palace", palaceDir, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, MEMPALACE_PALACE: palaceDir },
    })
    if (res.status !== 0) {
      const stderr = (res.stderr || "").slice(0, 2000)
      throw new Error(
        `mempalace ${args[0]} exited ${res.status}: ${stderr || res.stdout?.slice(0, 500)}`
      )
    }
    return res.stdout || ""
  }
}
