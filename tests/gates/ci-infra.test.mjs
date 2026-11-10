// gates/lib/ci-infra.mjs against recorded-shape CI logs in tests/fixtures/ci-logs/ (cstack#109).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFailure, INFRA_REASON } from "../../gates/lib/ci-infra.mjs";

const LOGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/ci-logs");
const log = (name) => readFileSync(path.join(LOGS, `${name}.txt`), "utf8");
const job = (o = {}) => ({ attempt: 1, runner: "runner-1", steps: [], reason: null, ...o });

test("an action that cannot install its tool is infrastructure, not the project (the gitleaks case)", () => {
  const r = classifyFailure({ conclusion: "failure", log: log("gitleaks-install"), job: job({ steps: [{ name: "Set up job", conclusion: "success" }, { name: "Scan for secrets", conclusion: "failure" }] }) });
  assert.equal(r.kind, "infra");
  assert.match(r.reason, /the action gitleaks\/gitleaks-action@v2 failed to install or download: Destination file path \/tmp\/gitleaks\.tmp already exists/);
  assert.equal(INFRA_REASON, "CI infrastructure");
});

test("a failing test or a lint action's findings are the project's", () => {
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: log("npm-test"), job: job({ steps: [{ name: "Run npm test", conclusion: "failure" }] }) }), { kind: "project", reason: 'the step "npm test" failed' });
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: log("lint-action"), job: null }), { kind: "project", reason: 'the step "golangci/golangci-lint-action@v6" failed' });
});

test("an error before any step ran, and a runner shutdown, are infrastructure", () => {
  const setup = classifyFailure({ conclusion: "failure", log: log("setup-job"), job: null });
  assert.equal(setup.kind, "infra");
  assert.match(setup.reason, /before any step ran: Failed to download archive/);
  const shutdown = classifyFailure({ conclusion: "cancelled", log: log("runner-shutdown"), job: job({ steps: [{ name: "Run npm test", conclusion: "cancelled" }] }) });
  assert.deepEqual(shutdown, { kind: "infra", reason: "runner error: The runner has received a shutdown signal" });
});

test("startup_failure, a job no runner took, a failed runner step and GitLab runner reasons are infrastructure", () => {
  assert.equal(classifyFailure({ conclusion: "startup_failure" }).kind, "infra");
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: "", job: job({ runner: null, steps: [] }) }), { kind: "infra", reason: "the job never ran on a runner" });
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: "", job: job({ steps: [{ name: "Set up job", conclusion: "failure" }] }) }), { kind: "infra", reason: 'the runner step "Set up job" failed' });
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: "boom", job: job({ steps: null, reason: "runner_system_failure" }) }), { kind: "infra", reason: "the runner failed the job (runner_system_failure)" });
});

test("without a step to blame, the project's failure names the step or the conclusion", () => {
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: "FAIL x", job: job({ steps: null, reason: "script_failure" }) }), { kind: "project", reason: "the check concluded failure" });
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: "", job: job({ steps: [] }) }), { kind: "project", reason: "the check concluded failure" }, "no steps but a runner: it ran");
  assert.deepEqual(classifyFailure({ conclusion: "timed_out", log: "", job: job({ steps: [{ name: "Unit tests", conclusion: "failure" }] }) }), { kind: "project", reason: 'the step "Unit tests" failed' });
});

test("a test-runner action whose tests fail is the project's, whatever the tests print (review F1)", () => {
  const cypress = classifyFailure({ conclusion: "failure", log: log("cypress-action"), job: job({ steps: [{ name: "Run cypress-io/github-action@v6", conclusion: "failure" }] }) });
  assert.deepEqual(cypress, { kind: "project", reason: 'the step "cypress-io/github-action@v6" failed' }, "user already exists, ECONNREFUSED, ENOTFOUND and 429 come from the tests");
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: log("test-action-own-error"), job: null }), { kind: "project", reason: 'the step "dorny/test-reporter@v1" failed' });
  const wrapped = log("gitleaks-install").replace("Destination file path /tmp/gitleaks.tmp already exists", "Failed to install: exit code 1");
  assert.equal(classifyFailure({ conclusion: "failure", log: wrapped }).kind, "project", "a wrapped exit is never the action's own install error");
});

test("runner words printed by a step are the project's; only runner annotations count (review F2)", () => {
  assert.deepEqual(classifyFailure({ conclusion: "failure", log: log("test-prints-runner-words"), job: job({ steps: [{ name: "Run npm test", conclusion: "failure" }] }) }), { kind: "project", reason: 'the step "npm test" failed' });
});
