// Check runs on one commit, and a bounded log tail per failed check. Shared by ci-log and post-merge.
import { UsageError, run } from "./common.mjs";

export const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function gh(args, cwd) {
  const r = run("gh", args, { cwd });
  if (r.code !== 0) throw new UsageError(`gh ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

// A re-run adds a newer check run with the same name. Prefer the higher id; without ids, the later
// start. A queued run has no start time yet, so it counts as the newest.
function newer(a, b) {
  if (Number.isInteger(a.id) && Number.isInteger(b.id)) return a.id > b.id;
  return String(a.started_at ?? "~") > String(b.started_at ?? "~");
}

// The newest check run of each name on one commit, sorted by name.
export function latestChecks(repo, sha, cwd) {
  const runs = JSON.parse(gh(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs"], cwd));
  const latest = new Map();
  for (const c of runs) {
    const prev = latest.get(c.name);
    if (!prev || newer(c, prev)) latest.set(c.name, c);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// The last `lines` lines of a check's log: the Actions job log, else the check's output summary and text.
export function checkTail(repo, check, lines, cwd) {
  const job = String(check.details_url).match(/\/actions\/runs\/\d+\/job\/(\d+)/);
  let tail;
  if (job) {
    // Job logs carry terminal color codes; gh refuses them unless allowed, so allow and strip them.
    const r = run("gh", ["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job[1]}/logs`], { cwd });
    tail = r.code === 0 ? r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") : `(job log unavailable: ${r.stderr.trim()})`;
  } else {
    const output = check.output ?? {};
    tail = [output.summary, output.text].filter(Boolean).join("\n") || "(no output)";
  }
  return tail.trimEnd().split("\n").slice(-lines).join("\n");
}
