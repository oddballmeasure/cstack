#!/usr/bin/env node
// The effective autonomy and parallelism for one run: config, overridden by <store>/run.json under the
// rule in gates/lib/run.mjs (run.json may only lower autonomy unless CSTACK_PROGRAM_AUTONOMY=send; ADR-006).
// Skills read autonomy here instead of from config, so a per-run --autonomy flag reaches every step.
// Usage: run-settings.mjs --store <dir> [--repo-dir <dir>] [--json]
// Prints "autonomy <level> (<source>)", "parallel <n> (<source>)" and, when an override was refused,
// "note: <why>".
// Usage: run-settings.mjs --permissions <role> [--repo-dir <dir>] [--worktree <dir>] [--plugin-dir <dir>] [--out <file>]
// Prints, or writes to --out, the Claude Code settings for a headless session in <role>: worker,
// coordinator, e2e-author (needs --worktree) or grader. Launch the session with
// `--permission-mode dontAsk --settings <file>` (ADR-009). The repo is --repo-dir, else the cwd.
// Exit 0, or 2 on usage errors.
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { effectiveAutonomy, effectiveParallel } from "./lib/run.mjs";
import { ROLES, permissionSettings } from "./lib/permissions.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: run-settings.mjs --store <dir> [--repo-dir <dir>] [--json] | --permissions <role> [--repo-dir <dir>] [--worktree <dir>] [--plugin-dir <dir>] [--out <file>]";

function permissions(args) {
  const role = args.permissions;
  if (!ROLES.includes(role)) throw new UsageError(`--permissions takes one of ${ROLES.join(", ")}`);
  if (role === "e2e-author" && !args.worktree) throw new UsageError("--permissions e2e-author needs --worktree <dir>");
  const { root, config } = loadConfig(args["repo-dir"] || process.cwd());
  const settings = permissionSettings(role, {
    pluginRoot: args["plugin-dir"] || PLUGIN_ROOT,
    repoRoot: root,
    home: os.homedir(),
    config,
    worktree: args.worktree,
  });
  const text = `${JSON.stringify(settings, null, 2)}\n`;
  if (!args.out) {
    process.stdout.write(text);
    return 0;
  }
  const out = path.resolve(args.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
  process.stdout.write(`${out}\n`);
  return 0;
}

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["store", "repo-dir", "permissions", "worktree", "plugin-dir", "out"] });
  if (args._.length) throw new UsageError(USAGE);
  if (args.permissions !== undefined) return permissions(args);
  if (!args.store) throw new UsageError(USAGE);
  const store = path.resolve(args.store);
  const { config } = loadConfig(args["repo-dir"] || store);
  const autonomy = effectiveAutonomy(config, store);
  const parallel = effectiveParallel(config, store);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ autonomy, parallel }, null, 2)}\n`);
    return 0;
  }
  const lines = [`autonomy ${autonomy.level} (${autonomy.source})`, `parallel ${parallel.value} (${parallel.source})`];
  if (autonomy.note) lines.push(`note: ${autonomy.note}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
});
