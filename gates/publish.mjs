#!/usr/bin/env node
// Push the verified HEAD of a unit branch and prove the remote holds exactly that SHA (Cardinal publish).
// Usage: publish.mjs <worktree> [--json]
// The lease is pinned to the remote head observed just before the push, so a concurrent push is never overwritten.
import { Gate, main, parseArgs, UsageError, git, gitOut } from "./lib/common.mjs";

function remoteSha(wt, branch) {
  const r = git(wt, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (r.code !== 0) throw new UsageError(`git ls-remote failed: ${r.stderr.trim()}`);
  return r.stdout.split(/\s/)[0];
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"] });
  const [wt] = args._;
  if (!wt) throw new UsageError("usage: publish.mjs <worktree> [--json]");
  const gate = new Gate("publish", { json: args.json });
  const branch = gitOut(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") throw new UsageError("worktree is on a detached HEAD");
  const head = gitOut(wt, ["rev-parse", "HEAD"]);

  const before = remoteSha(wt, branch);
  if (before === head) {
    gate.pass("push", `origin/${branch} already at ${head.slice(0, 12)}`);
    return gate.finish({ branch, sha: head });
  }
  const push = git(wt, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${before}`, "origin", `HEAD:refs/heads/${branch}`]);
  gate.check(push.code === 0, "push", `pushed ${head.slice(0, 12)}`, `push refused: ${push.stderr.trim()}`);
  const after = remoteSha(wt, branch);
  gate.check(after === head, "remote sha", `origin/${branch} is ${head.slice(0, 12)}`, `origin/${branch} is ${after || "missing"}, expected ${head}`);
  return gate.finish({ branch, sha: head });
});
