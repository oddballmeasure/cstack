#!/usr/bin/env node
// Collect failed checks on a PR head with a bounded log tail each, for a CI-REPAIR ticket.
// Usage: ci-log.mjs <pr> [--repo-dir <d>] [--lines 80] [--json]
// Actions jobs: the job log tail. Other checks: the check's output summary and text.
// Exit 0 when nothing failed, 1 when failures were found, 2 on usage or GitHub errors.
import { Gate, main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { FAILED, gh, latestChecks, checkTail } from "./lib/checks.mjs";

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["repo-dir", "lines"] });
  const [pr] = args._;
  const lines = Number(args.lines || 80);
  if (!pr || !/^\d+$/.test(pr) || !Number.isInteger(lines) || lines < 1) throw new UsageError("usage: ci-log.mjs <pr> [--repo-dir d] [--lines n]");
  const dir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(dir);
  const repo = config.repo;
  const gate = new Gate("ci-log", { json: args.json });

  const sha = JSON.parse(gh(["pr", "view", pr, "--repo", repo, "--json", "headRefOid"], dir)).headRefOid;
  const failures = [];
  for (const c of latestChecks(repo, sha, dir).filter((c) => FAILED.has(c.conclusion))) {
    const tail = checkTail(repo, c, lines, dir);
    failures.push({ name: c.name, conclusion: c.conclusion, tail });
    gate.fail(c.name, `${c.conclusion}\n${tail}`);
  }
  if (!failures.length) gate.pass("checks", `no failed checks on ${sha.slice(0, 12)}`);
  return gate.finish({ pr: Number(pr), sha, failures });
});
