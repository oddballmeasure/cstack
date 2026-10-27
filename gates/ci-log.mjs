#!/usr/bin/env node
// Collect failed checks on a PR head with a bounded log tail each, for a CI-REPAIR ticket.
// Usage: ci-log.mjs <pr> [--repo-dir <d>] [--lines 80] [--json]
// Actions jobs: the job log tail. Other checks: the check's output summary and text.
// Exit 0 when nothing failed, 1 when failures were found, 2 on usage or GitHub errors.
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

function gh(args, cwd) {
  const r = run("gh", args, { cwd });
  if (r.code !== 0) throw new UsageError(`gh ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

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
  const runs = JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs"], dir));
  const latest = new Map();
  for (const c of runs) {
    const prev = latest.get(c.name);
    if (!prev || String(c.started_at) > String(prev.started_at)) latest.set(c.name, c);
  }
  const failures = [];
  for (const c of [...latest.values()].filter((c) => FAILED.has(c.conclusion)).sort((a, b) => a.name.localeCompare(b.name))) {
    const job = String(c.details_url).match(/\/actions\/runs\/\d+\/job\/(\d+)/);
    let tail;
    if (job) {
      // Job logs carry terminal color codes; gh refuses them unless allowed, so allow and strip them.
      const r = run("gh", ["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job[1]}/logs`], { cwd: dir });
      tail = r.code === 0 ? r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") : `(job log unavailable: ${r.stderr.trim()})`;
    } else {
      tail = [c.output.summary, c.output.text].filter(Boolean).join("\n") || "(no output)";
    }
    tail = tail.trimEnd().split("\n").slice(-lines).join("\n");
    failures.push({ name: c.name, conclusion: c.conclusion, tail });
    gate.fail(c.name, `${c.conclusion}\n${tail}`);
  }
  if (!failures.length) gate.pass("checks", `no failed checks on ${sha.slice(0, 12)}`);
  return gate.finish({ pr: Number(pr), sha, failures });
});
