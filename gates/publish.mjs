#!/usr/bin/env node
// Push the verified HEAD of a unit branch and prove the remote holds exactly that SHA (Cardinal publish).
// Usage: publish.mjs <worktree> --store <dir> --unit <id> [--json]
// Refuses before any push unless units.tsv records this branch for the unit and for no other unit, and the ledger
// approves HEAD for it (the reader behind `orch ledger check`). A suite unit (E2E, E2E-<suffix>) must have track e2e; program-final never publishes. The lease is pinned to the remote head observed just before the push,
// so a concurrent push is never overwritten.
import { Gate, main, parseArgs, UsageError, git, gitOut } from "./lib/common.mjs";
import { isPassing, isSuiteUnit, openStore, SUITE_ID } from "./lib/store.mjs";

function remoteSha(wt, branch) {
  const r = git(wt, ["ls-remote", "origin", `refs/heads/${branch}`]);
  if (r.code !== 0) throw new UsageError(`git ls-remote failed: ${r.stderr.trim()}`);
  return r.stdout.split(/\s/)[0];
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["store", "unit"] });
  const [wt] = args._;
  if (!wt || !args.store || !args.unit) throw new UsageError("usage: publish.mjs <worktree> --store <dir> --unit <id> [--json]");
  const gate = new Gate("publish", { json: args.json });
  const branch = gitOut(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") throw new UsageError("worktree is on a detached HEAD");
  const head = gitOut(wt, ["rev-parse", "HEAD"]);
  const sha12 = head.slice(0, 12);

  const store = openStore(args.store);
  let units, row;
  try {
    units = store.units.list();
    row = store.ledger.latest({ unit: args.unit, sha: head });
  } finally {
    store.close();
  }
  const unit = units.find((u) => u.id === args.unit);
  const others = units.filter((u) => u.id !== args.unit && u.branch === branch).map((u) => u.id);
  const problems = [];
  if (!unit) problems.push(`unit ${args.unit} is not in ${args.store}/units.tsv`);
  else if (unit.branch !== branch) problems.push(`unit ${args.unit} is on branch ${unit.branch || "(none)"}, not ${branch}`);
  // Suite units and program-final are the only units whose approval orch records by hand; hold them to their own shape.
  if (unit && SUITE_ID.test(args.unit) && !isSuiteUnit(unit)) problems.push(`unit ${args.unit} has track ${unit.track}, not e2e`);
  if (args.unit === "program-final") problems.push("program-final judges a merged base and is never published");
  if (others.length) problems.push(`${branch} is also claimed by ${others.join(", ")}`);
  gate.check(!problems.length, "unit", `${args.unit} owns ${branch}`, problems.join("; "));
  gate.check(
    !!row && isPassing(row.verdict),
    "ledger",
    `${row?.verdict} for ${args.unit} at ${sha12}`,
    `no approval for ${args.unit} at ${sha12} (${row ? row.verdict : "not verified"}); verify this head first`,
  );
  if (!gate.approved) return gate.finish({ branch, sha: head });

  const before = remoteSha(wt, branch);
  if (before === head) {
    gate.pass("push", `origin/${branch} already at ${sha12}`);
    return gate.finish({ branch, sha: head });
  }
  const push = git(wt, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${before}`, "origin", `HEAD:refs/heads/${branch}`]);
  gate.check(push.code === 0, "push", `pushed ${sha12}`, `push refused: ${push.stderr.trim()}`);
  const after = remoteSha(wt, branch);
  gate.check(after === head, "remote sha", `origin/${branch} is ${sha12}`, `origin/${branch} is ${after || "missing"}, expected ${head}`);
  return gate.finish({ branch, sha: head });
});
