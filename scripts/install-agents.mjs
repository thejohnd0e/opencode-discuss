#!/usr/bin/env node
/**
 * Copies agents/discuss.md and agents/discuss-participant.md into the OpenCode
 * agents directory (~/.config/opencode/agents, or --target DIR).
 *
 * A file that is already identical is left alone. A file that differs is kept
 * as <name>.before-install-YYYYMMDD.bak before it is replaced. --dry-run only
 * prints what would happen. Runs under Node 18+ or Bun.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const AGENTS = ["discuss.md", "discuss-participant.md"]
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..", "agents")

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const at = args.indexOf("--target")
const target = at >= 0 && args[at + 1] ? resolve(args[at + 1]) : join(homedir(), ".config", "opencode", "agents")

const normalize = (text) => text.replace(/\r\n/g, "\n")
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "")

if (!dryRun) mkdirSync(target, { recursive: true })
for (const name of AGENTS) {
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(to)) {
    if (!dryRun) copyFileSync(from, to)
    console.log(`${dryRun ? "would install" : "installed"} ${to}`)
    continue
  }
  if (normalize(readFileSync(from, "utf8")) === normalize(readFileSync(to, "utf8"))) {
    console.log(`up to date ${to}`)
    continue
  }
  const backup = `${to}.before-install-${stamp}.bak`
  if (!dryRun) {
    copyFileSync(to, backup)
    copyFileSync(from, to)
  }
  console.log(`${dryRun ? "would replace" : "replaced"} ${to} (${dryRun ? "a backup would go to" : "backup:"} ${backup})`)
}
if (!dryRun) console.log("Reload OpenCode configuration (/reload) to pick up the agents.")
