#!/usr/bin/env node
// Collect failed checks on a PR head with a bounded log tail each, and say what to do about them.
// Usage: ci-log.mjs <pr> [--repo-dir <d>] [--lines 80] [--rerun [--timeout 540]] [--json]
// Actions jobs: the job log tail. Other checks: the check's output summary and text.
// Each failure is kind `project` (a test, build or lint step failed) or `infra` (it failed before the project's own
// steps ran: a runner error, an action or tool install, startup_failure, a job no runner took), per
// gates/lib/ci-infra.mjs (the local forge runs ci_command itself, so its failures are always `project`). The action:
//   none         nothing failed
//   repair       a project failure: a CI-REPAIR ticket for the project failures
//   rerun        only infra failures, each on its first attempt with a re-run handle; --rerun re-runs them once
//   wait         as rerun, but a failed run still has checks running. --rerun first waits for the run to complete,
//                polling every CSTACK_CI_LOG_POLL_MS (default 30000) for up to --timeout seconds (default 540)
//   needs-human  only infra failures, and one failed again on a re-run, or cannot be re-run: reason "CI infrastructure"
// Exit 0 when nothing failed, 1 when failures were found, 2 on usage or forge errors.
import { Gate, main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { FAILED, openForge } from "./lib/forge.mjs";
import { classifyFailure, INFRA_REASON } from "./lib/ci-infra.mjs";

function decide(failures) {
  if (!failures.length) return { action: "none", why: "no failed checks" };
  const project = failures.filter((f) => f.kind === "project");
  if (project.length) return { action: "repair", why: `the project's own steps failed in ${project.map((f) => f.name).join(", ")}` };
  const stuck = failures.filter((f) => f.attempt !== 1 || !f.handle);
  if (!stuck.length) return { action: "rerun", why: `${INFRA_REASON}: first attempt of ${failures.map((f) => f.name).join(", ")}` };
  const again = (f) => (!f.handle ? "cannot be re-run" : f.attempt > 1 ? `failed again on attempt ${f.attempt}` : "has no known attempt");
  return { action: "needs-human", why: `${INFRA_REASON}: ${stuck.map((f) => `${f.name} ${again(f)}`).join("; ")}` };
}

// One look at the head: each failed check classified, the action, and the failed runs that still have checks running.
function collect(forge, sha, lines) {
  const checks = forge.checks(sha);
  const failures = [];
  for (const c of checks.filter((c) => FAILED.has(c.conclusion))) {
    const log = forge.checkLog(c);
    const tail = log.trimEnd().split("\n").slice(-lines).join("\n");
    const job = forge.checkJob(c);
    // The local forge runs ci_command itself: no runner, so a failure is always the project's.
    const { kind, reason } = forge.kind === "local" ? { kind: "project", reason: "the local ci_command failed" } : classifyFailure({ conclusion: c.conclusion, log, job });
    failures.push({ name: c.name, conclusion: c.conclusion, kind, reason, attempt: job?.attempt ?? null, handle: forge.rerunHandle(c), tail });
  }
  const handles = new Set(failures.map((f) => f.handle));
  const running = [...new Set(checks.filter((c) => !c.conclusion && handles.has(forge.rerunHandle(c))).map((c) => forge.rerunHandle(c)))];
  return { failures, running, ...decide(failures) };
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "rerun"], options: ["repo-dir", "lines", "timeout"] });
  const [pr] = args._;
  const lines = Number(args.lines || 80);
  const timeout = Number(args.timeout ?? 540);
  if (!pr || !/^\d+$/.test(pr) || !Number.isInteger(lines) || lines < 1 || !(timeout > 0)) throw new UsageError("usage: ci-log.mjs <pr> [--repo-dir d] [--lines n] [--rerun [--timeout s]]");
  const dir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(dir);
  const forge = openForge(config, { cwd: dir });
  const gate = new Gate("ci-log", { json: args.json });
  const poll = Number(process.env.CSTACK_CI_LOG_POLL_MS || 30000);
  const started = Date.now();

  const sha = forge.change(pr, ["headRefOid"]).head;
  let r = collect(forge, sha, lines);
  // A re-run needs the failed run to be complete: a run with checks still going cannot be re-run yet, and asking
  // then would spend the one attempt. With --rerun, wait for it (up to --timeout); without, say so.
  while (r.action === "rerun" && r.running.length && args.rerun && Date.now() - started < timeout * 1000) {
    await new Promise((res) => setTimeout(res, poll));
    r = collect(forge, sha, lines);
  }
  for (const f of r.failures) gate.fail(f.name, `${f.conclusion} (${f.kind}: ${f.reason})\n${f.tail}`);
  let { action, why } = r;
  const rerun = [];
  if (action === "rerun" && r.running.length) ({ action, why } = { action: "wait", why: `${INFRA_REASON}: run ${r.running.join(", ")} still has checks running; run ci-log again once it completes` });
  else if (action === "rerun" && args.rerun) {
    const handles = [...new Set(r.failures.map((f) => f.handle))];
    const failed = handles.filter((h) => !forge.rerun(h).ok);
    rerun.push(...handles.filter((h) => !failed.includes(h)));
    if (failed.length) ({ action, why } = { action: "needs-human", why: `${INFRA_REASON}: the re-run of ${failed.join(", ")} could not start` });
    else why = `${why}; re-ran ${handles.join(", ")}`;
  }
  if (r.failures.length) gate.fail("action", `${action}: ${why}`);
  else gate.pass("checks", `no failed checks on ${sha.slice(0, 12)}`);
  return gate.finish({ pr: Number(pr), sha, action, reason: why, rerun, failures: r.failures });
});
