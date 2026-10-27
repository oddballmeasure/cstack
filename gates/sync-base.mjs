#!/usr/bin/env node
// Bring a unit branch up to date with its base (Cardinal sync).
// Usage: sync-base.mjs <worktree> [--json]
// Outcomes: up-to-date (exit 0), merged (exit 0, new merge commit), conflict (exit 1; the merge stays in
// progress with markers in the tree so a SYNC ticket can resolve them). Fetch or merge errors exit 2.
import { Gate, main, parseArgs, UsageError, loadConfig, git, gitOut } from "./lib/common.mjs";

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"] });
  const [wt] = args._;
  if (!wt) throw new UsageError("usage: sync-base.mjs <worktree> [--json]");
  const { config } = loadConfig(wt);
  const base = config.base_branch;
  const gate = new Gate("sync-base", { json: args.json });

  if (gitOut(wt, ["status", "--porcelain", "--untracked-files=no"])) throw new UsageError("worktree has uncommitted changes; commit or reset before syncing");
  const fetch = git(wt, ["fetch", "--quiet", "origin", base]);
  if (fetch.code !== 0) throw new UsageError(`git fetch origin ${base} failed: ${fetch.stderr.trim()}`);
  const branch = gitOut(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);

  if (git(wt, ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"]).code === 0) {
    gate.pass("base", `already contains origin/${base}`);
    return gate.finish({ outcome: "up-to-date", head: gitOut(wt, ["rev-parse", "HEAD"]) });
  }
  const m = git(wt, ["-c", "user.name=cstack", "-c", "user.email=cstack@users.noreply.github.com", "merge", "--no-ff", "-m", `Merge ${base} into ${branch}`, `origin/${base}`]);
  if (m.code === 0) {
    gate.pass("base", `merged origin/${base}`);
    return gate.finish({ outcome: "merged", head: gitOut(wt, ["rev-parse", "HEAD"]) });
  }
  const conflicted = gitOut(wt, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  gate.fail("base", `merge of origin/${base} conflicts in: ${conflicted.join(", ")}`);
  return gate.finish({ outcome: "conflict", conflicted });
});
