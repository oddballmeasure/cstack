import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hooks/scripts/guard.mjs");

function repo(config = { paths_hidden: ["tests/acceptance/**"], paths_off_limits: [".github/workflows/**"] }) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-guard-"));
  mkdirSync(path.join(root, ".cstack"));
  mkdirSync(path.join(root, "src"));
  if (config !== null) writeFileSync(path.join(root, ".cstack", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

function run(root, tool_name, tool_input, env = {}, cwd = root) {
  const r = spawnSync("node", [GUARD], {
    input: JSON.stringify({ tool_name, tool_input, cwd }),
    env: { ...process.env, CSTACK_ROLE: "", CSTACK_RUN: "", CSTACK_UNIT: "", CSTACK_COORDINATOR: "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, err: r.stderr };
}

test("allows ordinary reads and writes", () => {
  const r = repo();
  assert.equal(run(r, "Read", { file_path: path.join(r, "src/a.js") }).code, 0);
  assert.equal(run(r, "Write", { file_path: "src/a.js" }).code, 0);
  assert.equal(run(r, "Grep", { pattern: "x", path: r }).code, 0);
});

test("hidden-paths blocks Read, Edit, Grep and Glob targets inside the hidden area", () => {
  const r = repo();
  for (const [tool, input] of [
    ["Read", { file_path: path.join(r, "tests/acceptance/e1.test.js") }],
    ["Read", { file_path: "tests/acceptance" }],
    ["Edit", { file_path: "tests/acceptance/e1.test.js" }],
    ["Grep", { pattern: "x", path: "tests/acceptance" }],
    ["Glob", { pattern: "tests/acceptance/**/*.js" }],
    ["Grep", { pattern: "x", glob: "tests/acceptance/*" }],
  ]) {
    const out = run(r, tool, input);
    assert.equal(out.code, 2, `${tool} ${JSON.stringify(input)}`);
    assert.match(out.err, /hidden-paths/);
  }
});

test("hidden-paths resolves relative paths from a subdirectory", () => {
  const r = repo();
  const out = run(r, "Read", { file_path: "../tests/acceptance/e1.test.js" }, {}, path.join(r, "src"));
  assert.equal(out.code, 2);
});

test("hidden-paths blocks Bash commands that name the hidden area", () => {
  const r = repo();
  const out = run(r, "Bash", { command: "cat tests/acceptance/e1.test.js" });
  assert.equal(out.code, 2);
  assert.match(out.err, /hidden-paths/);
});

test("hidden-paths never matches Agent or Skill prompt text", () => {
  const r = repo();
  assert.equal(run(r, "Agent", { prompt: "do not read tests/acceptance" }).code, 0);
});

test("grader and e2e-author roles may read the hidden area", () => {
  const r = repo();
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/e1.test.js" }, { CSTACK_ROLE: "grader" }).code, 0);
  assert.equal(run(r, "Write", { file_path: "tests/acceptance/e1.test.js" }, { CSTACK_ROLE: "e2e-author" }).code, 0);
});

test("e2e-author may not write outside the hidden area", () => {
  const r = repo();
  const out = run(r, "Write", { file_path: "src/a.js" }, { CSTACK_ROLE: "e2e-author" });
  assert.equal(out.code, 2);
  assert.match(out.err, /off-limits/);
});

test("off-limits blocks writes to configured paths, .git and vendor dirs", () => {
  const r = repo();
  for (const p of [".github/workflows/ci.yml", ".git/config", "node_modules/x/index.js", ".cstack/config.json"]) {
    const out = run(r, "Write", { file_path: p });
    assert.equal(out.code, 2, p);
    assert.match(out.err, /off-limits/);
  }
  assert.equal(run(r, "Read", { file_path: ".github/workflows/ci.yml" }).code, 0, "reads stay allowed");
  assert.equal(run(r, "Write", { file_path: ".cstack/runs/issue-1/intake.json" }).code, 0, "the run store stays writable");
});

test("no-sleep-loops blocks polling loops and long sleeps", () => {
  const r = repo();
  for (const cmd of ["while true; do gh pr checks 1; sleep 30; done", "until done; do sleep 5; done", "for i in 1 2 3; do sleep 2; done", "sleep 60 && gh pr view"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-sleep-loops/);
  }
  assert.equal(run(r, "Bash", { command: "sleep 2 && ls" }).code, 0, "short single sleep is fine");
});

test("no-admin-merge blocks direct merges", () => {
  const r = repo();
  for (const cmd of ["gh pr merge 3 --merge", "gh pr merge 3 --admin --squash", "gh api -X PUT repos/o/r/pulls/3/merge"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Bash", { command: "gh pr view 3 --json mergeable" }).code, 0);
});

test("no-autonomy-raise blocks setting CSTACK_PROGRAM_AUTONOMY and allows reading it", () => {
  const r = repo();
  for (const cmd of [
    "CSTACK_PROGRAM_AUTONOMY=send node gates/check-merge.mjs 5 --unit U1 --merge",
    "export CSTACK_PROGRAM_AUTONOMY",
    "env CSTACK_PROGRAM_AUTONOMY = send x",
    "systemctl --user set-environment CSTACK_PROGRAM_AUTONOMY",
    "systemd-run --user --setenv=CSTACK_PROGRAM_AUTONOMY=send claude -p x",
  ]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-autonomy-raise/);
  }
  assert.equal(run(r, "Bash", { command: "printenv CSTACK_PROGRAM_AUTONOMY" }).code, 0);
});

test("no-deploy-approval blocks the approved deploy command and allows a plan", () => {
  const r = repo();
  for (const cmd of ["node /p/gates/deploy.mjs abc --approved", "node gates/deploy.mjs abc --repo-dir . --approved --json"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-deploy-approval/);
  }
  assert.equal(run(r, "Bash", { command: "node gates/deploy.mjs abc --plan --json" }).code, 0);
  assert.equal(run(r, "Bash", { command: "node gates/deploy.mjs abc --json" }).code, 0);
});

test("no-eval-publish blocks claude plugin eval without --no-publish", () => {
  const r = repo();
  for (const cmd of ["claude plugin eval . --ablation none", "cd /x && claude plugins eval /tmp/p --json out.json"]) {
    const out = run(r, "Bash", { command: cmd });
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-eval-publish/);
  }
  assert.equal(run(r, "Bash", { command: "claude plugin eval . --ablation none --no-publish" }).code, 0);
  assert.equal(run(r, "Bash", { command: "claude plugin eval --help" }).code, 0, "help runs nothing");
});

test("outside a cstack context every rule is off", () => {
  const r = repo(null); // .cstack/ exists but has no config.json: not a cstack repo
  for (const cmd of [
    "gh pr merge 1 --squash",
    "gh api -X PUT repos/o/r/pulls/3/merge",
    "while true; do sleep 30; done",
    "sleep 60",
    "export CSTACK_PROGRAM_AUTONOMY=send",
    "node gates/deploy.mjs abc --approved",
    "claude plugin eval .",
  ]) {
    assert.equal(run(r, "Bash", { command: cmd }).code, 0, cmd);
  }
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/x" }).code, 0);
  assert.equal(run(r, "Write", { file_path: ".git/config" }).code, 0);
});

test("a cstack env marker turns the Bash rules on without a config; path rules stay off", () => {
  const r = repo(null);
  for (const marker of ["CSTACK_ROLE", "CSTACK_RUN", "CSTACK_UNIT", "CSTACK_COORDINATOR"]) {
    const out = run(r, "Bash", { command: "gh pr merge 1" }, { [marker]: "1" });
    assert.equal(out.code, 2, marker);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Read", { file_path: "tests/acceptance/x" }, { CSTACK_RUN: "prog" }).code, 0);
});

test("a call from outside that targets a cstack repo is in context", () => {
  const r = repo();
  const elsewhere = repo(null);
  assert.equal(run(r, "Write", { file_path: path.join(r, ".cstack/config.json") }, {}, elsewhere).code, 2);
  assert.equal(run(r, "Read", { file_path: path.join(r, "tests/acceptance/e1.test.js") }, {}, elsewhere).code, 2);
  assert.equal(run(r, "Grep", { pattern: "x", path: path.join(r, "src") }, {}, elsewhere).code, 0);
  for (const cmd of [`cd ${r} && gh pr merge 1`, `git -C "${r}" status; gh pr merge 1`, `(cd '${r}/src' && gh pr merge 1)`]) {
    const out = run(r, "Bash", { command: cmd }, {}, elsewhere);
    assert.equal(out.code, 2, cmd);
    assert.match(out.err, /no-admin-merge/);
  }
  assert.equal(run(r, "Bash", { command: "cd /tmp && gh pr merge 1" }, {}, elsewhere).code, 0);
  assert.equal(run(r, "Bash", { command: "cd ~ && ls" }, {}, elsewhere).code, 0);
});

test("a config that does not parse blocks with a clear message", () => {
  const r = repo("{not json");
  const out = run(r, "Read", { file_path: "src/a.js" });
  assert.equal(out.code, 2);
  assert.match(out.err, /config/);
});

test("malformed hook input never blocks", () => {
  const r = spawnSync("node", [GUARD], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
});
