#!/usr/bin/env node
// Put one state label on an issue and post an outcome comment once (Cardinal settle).
// Usage: settle.mjs <issue> --state <ready|in-progress|done|error|needs-human|investigate> [--comment-file <f>] [--repo-dir <d>] [--json]
// Idempotent: other state labels are removed, the target label is added only if missing, and the comment
// is skipped when an existing comment has the same first line (fixed prefixes make that line stable).
import { readFileSync } from "node:fs";
import { Gate, main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { openForge } from "./lib/forge.mjs";

const STATES = ["ready", "in-progress", "done", "error", "needs-human", "investigate"];
const firstLine = (s) => s.trim().split("\n")[0].trim();

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["state", "comment-file", "repo-dir"] });
  const [issue] = args._;
  if (!issue || !/^\d+$/.test(issue) || !STATES.includes(args.state)) {
    throw new UsageError(`usage: settle.mjs <issue> --state <${STATES.join("|")}> [--comment-file f]`);
  }
  const dir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(dir);
  const prefix = config.label_prefix;
  const gate = new Gate("settle", { json: args.json });

  const forge = openForge(config, { cwd: dir });
  const view = forge.issue(issue, ["labels", "comments"]);
  if (!view.ok) throw new UsageError(`${forge.kind} issue view ${issue} failed: ${view.error}`);
  const { labels, comments } = view;
  const have = new Set(labels);
  const target = `${prefix}:${args.state}`;
  const remove = STATES.map((s) => `${prefix}:${s}`).filter((l) => l !== target && have.has(l));

  if (have.has(target) && !remove.length) {
    gate.pass("label", `${target} already set`);
  } else {
    const r = forge.relabel(issue, { add: have.has(target) ? [] : [target], remove });
    gate.check(r.ok, "label", `${target}${remove.length ? ` (removed ${remove.join(", ")})` : ""}`, `${forge.kind} issue edit failed: ${r.error}`);
  }

  if (args["comment-file"]) {
    const body = readFileSync(args["comment-file"], "utf8");
    const head = firstLine(body);
    if (comments.some((c) => firstLine(c) === head)) {
      gate.pass("comment", "already posted");
    } else {
      const r = forge.comment(issue, args["comment-file"]);
      gate.check(r.ok, "comment", "posted", `${forge.kind} issue comment failed: ${r.error}`);
    }
  }
  return gate.finish({ issue: Number(issue), state: args.state });
});
