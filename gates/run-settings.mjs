#!/usr/bin/env node
// The effective autonomy and parallelism for one run: config, overridden by <store>/run.json under the
// rule in gates/lib/run.mjs (run.json may only lower autonomy unless CSTACK_PROGRAM_AUTONOMY=send; ADR-006).
// Skills read autonomy here instead of from config, so a per-run --autonomy flag reaches every step.
// Usage: run-settings.mjs --store <dir> [--repo-dir <dir>] [--json]
// Prints "autonomy <level> (<source>)", "parallel <n> (<source>)" and, when an override was refused,
// "note: <why>". Exit 0, or 2 on usage errors.
import path from "node:path";
import { main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { effectiveAutonomy, effectiveParallel } from "./lib/run.mjs";

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["store", "repo-dir"] });
  if (args._.length || !args.store) throw new UsageError("usage: run-settings.mjs --store <dir> [--repo-dir <dir>] [--json]");
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
