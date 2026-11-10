// Tell a failed CI check that broke before the project's own steps ran (CI infrastructure) from one the project
// failed (a test, a build, a lint). cstack re-runs an infrastructure failure once and then asks a person; it never
// turns one into a code repair (cstack#109).
// classifyFailure({conclusion, log, job}) -> {kind: "infra" | "project", reason}
//   conclusion  the check's GitHub-style conclusion
//   log         the check's whole log (forge checkLog)
//   job         forge checkJob(check): {attempt, runner, steps: [{name, conclusion}] | null, reason} or null
// Infrastructure, in this order:
//   - conclusion startup_failure: the run never started
//   - a GitLab failure_reason that names the runner or the platform, not the job script
//   - a runner error anywhere in the log: shutdown signal, lost communication, a job no runner picked up
//   - an Actions job that never reached a runner: no runner name and no steps
//   - a failed runner step: Set up job, Initialize containers, Complete job
//   - in an Actions log, the first error before any step started, or inside a third-party action's step
//     (`uses: owner/repo@ref` or `docker://`) when the error is an install, download or network failure
// Anything else is the project's.

export const INFRA_REASON = "CI infrastructure";

const GITLAB_INFRA = new Set(["runner_system_failure", "stuck_or_timeout_failure", "scheduler_failure", "api_failure", "data_integrity_failure", "runner_unsupported", "unmet_prerequisites"]);
const RUNNER_ERRORS = [
  /The runner has received a shutdown signal/i,
  /lost communication with the server/i,
  /The job was not acquired by Runner/i,
  /The hosted runner .* encountered an error/i,
  /Runner .* (?:did not respond|went offline)/i,
];
const RUNNER_STEPS = /^(?:Set up job|Set up runner|Initialize containers|Complete job|Complete runner)$/i;
const ACTION_STEP = /^(?:[\w.-]+\/[\w./-]+@[\w./-]+|docker:\/\/\S+)$/;
const INSTALL_ERRORS = [
  /\balready exists\b/i,
  /Unable to (?:download|resolve action|locate executable|find)/i,
  /Failed to (?:download|fetch|install|resolve|extract)/i,
  /\b(?:ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENOSPC)\b/,
  /No space left on device/i,
  /Could not resolve host/i,
  /socket hang up/i,
  /rate limit exceeded/i,
  /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out|429 Too Many Requests)\b/i,
];

// An Actions log line, without its timestamp.
const bare = (line) => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "");

// The first error in an Actions log and the step it fell in: {step: <"Run ..." header text> | null, error, context}.
function firstError(log) {
  const lines = log.split("\n").map(bare);
  const at = lines.findIndex((l) => l.startsWith("##[error]"));
  if (at < 0) return null;
  let step = null;
  let start = 0;
  for (let i = at; i >= 0; i--) {
    if (lines[i].startsWith("##[group]Run ")) {
      step = lines[i].slice("##[group]Run ".length).trim();
      start = i;
      break;
    }
  }
  return { step, error: lines[at].slice("##[error]".length).trim(), context: lines.slice(start, at + 20).join("\n") };
}

const infra = (reason) => ({ kind: "infra", reason });

export function classifyFailure({ conclusion, log = "", job = null }) {
  if (conclusion === "startup_failure") return infra("startup_failure: the workflow run never started");
  if (job?.reason && GITLAB_INFRA.has(job.reason)) return infra(`the runner failed the job (${job.reason})`);
  const runnerError = RUNNER_ERRORS.map((re) => log.match(re)).find(Boolean);
  if (runnerError) return infra(`runner error: ${runnerError[0]}`);
  if (job?.steps && job.steps.length === 0 && !job.runner) return infra("the job never ran on a runner");
  const failedStep = job?.steps?.find((s) => s.conclusion === "failure");
  if (failedStep && RUNNER_STEPS.test(failedStep.name)) return infra(`the runner step "${failedStep.name}" failed`);
  const first = firstError(log);
  if (first && first.step === null) return infra(`failed while setting up the job, before any step ran: ${first.error}`);
  if (first && ACTION_STEP.test(first.step) && INSTALL_ERRORS.some((re) => re.test(first.context))) {
    return infra(`the action ${first.step} failed to install or download: ${first.error}`);
  }
  const where = first?.step ?? failedStep?.name;
  return { kind: "project", reason: where ? `the step "${where}" failed` : `the check concluded ${conclusion}` };
}
