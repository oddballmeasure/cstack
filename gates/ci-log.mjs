#!/usr/bin/env node
// Collect failed checks on a PR head with a bounded log tail each, and say what to do about them.
// Usage: ci-log.mjs <pr> [--repo-dir <d>] [--lines 80] [--rerun] [--json]
// Actions jobs: the job log tail. Other checks: the check's output summary and text.
// Each failure is kind `project` (a test, build or lint step failed) or `infra` (it failed before the project's own
// steps ran: a runner error, an action or tool install, startup_failure, a job no runner took), per
// gates/lib/ci-infra.mjs. The action:
//   none         nothing failed
//   repair       a project failure: a CI-REPAIR ticket for the project failures
//   rerun        only infra failures, each on its first attempt with a re-run handle; --rerun re-runs them once
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

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "rerun"], options: ["repo-dir", "lines"] });
  const [pr] = args._;
  const lines = Number(args.lines || 80);
  if (!pr || !/^\d+$/.test(pr) || !Number.isInteger(lines) || lines < 1) throw new UsageError("usage: ci-log.mjs <pr> [--repo-dir d] [--lines n] [--rerun]");
  const dir = args["repo-dir"] || process.cwd();
  const { config } = loadConfig(dir);
  const forge = openForge(config, { cwd: dir });
  const gate = new Gate("ci-log", { json: args.json });

  const sha = forge.change(pr, ["headRefOid"]).head;
  const failures = [];
  for (const c of forge.checks(sha).filter((c) => FAILED.has(c.conclusion))) {
    const log = forge.checkLog(c);
    const tail = log.trimEnd().split("\n").slice(-lines).join("\n");
    const job = forge.checkJob(c);
    const { kind, reason } = classifyFailure({ conclusion: c.conclusion, log, job });
    failures.push({ name: c.name, conclusion: c.conclusion, kind, reason, attempt: job?.attempt ?? null, handle: forge.rerunHandle(c), tail });
    gate.fail(c.name, `${c.conclusion} (${kind}: ${reason})\n${tail}`);
  }
  let { action, why } = decide(failures);
  const rerun = [];
  if (action === "rerun" && args.rerun) {
    const handles = [...new Set(failures.map((f) => f.handle))];
    const failed = handles.filter((h) => !forge.rerun(h).ok);
    rerun.push(...handles.filter((h) => !failed.includes(h)));
    if (failed.length) ({ action, why } = { action: "needs-human", why: `${INFRA_REASON}: the re-run of ${failed.join(", ")} could not start` });
    else why = `${why}; re-ran ${handles.join(", ")}`;
  }
  if (failures.length) gate.fail("action", `${action}: ${why}`);
  else gate.pass("checks", `no failed checks on ${sha.slice(0, 12)}`);
  return gate.finish({ pr: Number(pr), sha, action, reason: why, rerun, failures });
});
