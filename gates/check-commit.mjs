#!/usr/bin/env node
// Gate after an implementer attempt. The implementer's own account never counts; this checks the commits.
// Usage: check-commit.mjs <worktree> --base <ref> --unit <id> [--issue <n>] [--inherited <sha>] [--no-cache] [--json]
// Checks: clean tree, non-empty diff, no conflict markers, trailers on every commit,
// no hidden or off-limits paths, test_command green at HEAD.
// --inherited: a takeover's original head, a full sha strictly behind HEAD. Commits it already holds need no trailers.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Gate, main, parseArgs, UsageError, loadConfig, git, gitOut } from "./lib/common.mjs";
import { changedFiles, pathViolations, runTests } from "./lib/repo.mjs";

const MARKER = /^(<{7}|>{7})( |$)/m;

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "no-cache"], options: ["base", "unit", "issue", "inherited"] });
  const [wt] = args._;
  if (!wt || !args.base || !args.unit) throw new UsageError("usage: check-commit.mjs <worktree> --base <ref> --unit <id> [--issue <n>] [--inherited <sha>]");
  const { config } = loadConfig(wt);
  const gate = new Gate("check-commit", { json: args.json });

  const dirty = gitOut(wt, ["status", "--porcelain"]);
  gate.check(!dirty, "clean tree", "all changes committed", `uncommitted changes:\n${dirty}`);

  const files = changedFiles(wt, args.base);
  gate.check(files.length > 0, "non-empty diff", `${files.length} files changed`, `no change against ${args.base}`);

  const marked = files.filter((f) => {
    const p = path.join(wt, f);
    return existsSync(p) && MARKER.test(readFileSync(p, "utf8"));
  });
  gate.check(!marked.length, "conflict markers", "none", `markers in: ${marked.join(", ")}`);

  const exempt = [];
  if (args.inherited !== undefined) {
    const want = args.inherited;
    const sha = git(wt, ["rev-parse", "--verify", "--quiet", `${want}^{commit}`]).stdout.trim();
    const head = gitOut(wt, ["rev-parse", "HEAD"]);
    const ok = /^[0-9a-f]{40}$/.test(want) && sha === want && sha !== head && git(wt, ["merge-base", "--is-ancestor", sha, "HEAD"]).code === 0;
    gate.check(ok, "inherited head", `commits up to ${want.slice(0, 12)} are inherited`, `--inherited ${JSON.stringify(want)} is not a full commit sha strictly behind HEAD`);
    if (ok) exempt.push(`^${sha}`);
  }
  const commits = gitOut(wt, ["rev-list", "--no-merges", `${args.base}..HEAD`, ...exempt]).split("\n").filter(Boolean);
  const missing = [];
  for (const c of commits) {
    // The whole message, not git's last-paragraph trailers: a blank line there cannot be fixed by a new commit.
    const message = gitOut(wt, ["show", "-s", "--format=%B", c]);
    const has = (k, v) => message.split("\n").some((l) => l.trim() === `${k}: ${v}`);
    if (!has("Cstack-Unit", args.unit)) missing.push(`${c.slice(0, 12)} lacks Cstack-Unit: ${args.unit}`);
    if (args.issue && !has("Refs", `#${args.issue}`)) missing.push(`${c.slice(0, 12)} lacks Refs: #${args.issue}`);
  }
  gate.check(
    !missing.length,
    "trailers",
    `${commits.length} commits carry the unit trailer`,
    `${missing.join("; ")}. Every commit needs these lines exactly, in its message.`,
  );

  const bad = pathViolations(files, config);
  gate.check(!bad.length, "paths", "no hidden or off-limits paths changed", bad.join("; "));

  const t = runTests(wt, config, { useCache: !args["no-cache"] });
  gate.check(t.ok, "tests", `test_command passed at tree ${t.tree.slice(0, 12)}${t.cached ? " (cached)" : ""}`, `test_command ${t.timedOut ? "timed out" : `exited ${t.code}`}:\n${t.tail}`);

  return gate.finish({ head: gitOut(wt, ["rev-parse", "HEAD"]), tree: t.tree });
});
