#!/usr/bin/env node
// Put one state label on an issue and post an outcome comment once (Cardinal settle).
// Usage: settle.mjs <issue> --state <ready|in-progress|done|error|needs-human|investigate> [--comment-file <f>] [--repo-dir <d>] [--json]
// Idempotent: other state labels are removed, the target label is added only if missing, and the comment
// is skipped when an existing comment has the same first line (fixed prefixes make that line stable).
import { readFileSync } from "node:fs";
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";

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
  const repo = config.repo;
  const prefix = config.label_prefix;
  const gate = new Gate("settle", { json: args.json });

  const view = run("gh", ["issue", "view", issue, "--repo", repo, "--json", "labels,comments"], { cwd: dir });
  if (view.code !== 0) throw new UsageError(`gh issue view ${issue} failed: ${view.stderr.trim()}`);
  const { labels, comments } = JSON.parse(view.stdout);
  const have = new Set(labels.map((l) => l.name));
  const target = `${prefix}:${args.state}`;
  const remove = STATES.map((s) => `${prefix}:${s}`).filter((l) => l !== target && have.has(l));

  if (have.has(target) && !remove.length) {
    gate.pass("label", `${target} already set`);
  } else {
    const edit = ["issue", "edit", issue, "--repo", repo];
    if (!have.has(target)) edit.push("--add-label", target);
    if (remove.length) edit.push("--remove-label", remove.join(","));
    const r = run("gh", edit, { cwd: dir });
    gate.check(r.code === 0, "label", `${target}${remove.length ? ` (removed ${remove.join(", ")})` : ""}`, `gh issue edit failed: ${r.stderr.trim()}`);
  }

  if (args["comment-file"]) {
    const body = readFileSync(args["comment-file"], "utf8");
    const head = firstLine(body);
    if (comments.some((c) => firstLine(c.body) === head)) {
      gate.pass("comment", "already posted");
    } else {
      const r = run("gh", ["issue", "comment", issue, "--repo", repo, "--body-file", args["comment-file"]], { cwd: dir });
      gate.check(r.code === 0, "comment", "posted", `gh issue comment failed: ${r.stderr.trim()}`);
    }
  }
  return gate.finish({ issue: Number(issue), state: args.state });
});
