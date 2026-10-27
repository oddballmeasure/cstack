import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { makeRepo, commit, gate, git, write, failChecks, existsSync, path } from "./helpers.mjs";

const trailers = (unit, issue) => `\n\nCstack-Unit: ${unit}${issue ? `\nRefs: #${issue}` : ""}`;

function isolated(cfg) {
  const r = makeRepo(cfg);
  const wt = path.join(r.base, "wt");
  const res = gate("isolate.mjs", [r.root, "cstack/u1", wt, "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
  return { ...r, wt };
}

// isolate

test("isolate creates a worktree without the hidden suite", () => {
  const { root, wt } = isolated();
  assert.ok(!existsSync(path.join(wt, "tests/acceptance")));
  assert.ok(existsSync(path.join(wt, "src/app.js")));
  assert.ok(existsSync(path.join(root, "tests/acceptance/lanes.txt")), "main checkout keeps it");
  assert.equal(git(wt, "status", "--porcelain"), "");
});

test("isolate reuses an existing branch and works with no hidden paths", () => {
  const r = makeRepo({ paths_hidden: [] });
  git(r.root, "branch", "cstack/u2");
  const res = gate("isolate.mjs", [r.root, "cstack/u2", path.join(r.base, "wt2")]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /existing branch/);
  assert.match(res.out, /no paths_hidden configured/);
});

test("isolate refuses bad input", () => {
  const r = makeRepo();
  assert.equal(gate("isolate.mjs", [r.root]).code, 2);
  assert.equal(gate("isolate.mjs", [r.root, "b", r.root]).code, 2, "existing dir");
  assert.equal(gate("isolate.mjs", [r.root, "b", path.join(r.base, "x"), "--base", "nope"]).code, 2, "bad base");
  const g = makeRepo({ paths_hidden: ["**/*.secret"] });
  assert.equal(gate("isolate.mjs", [g.root, "b", path.join(g.base, "y")]).code, 2, "glob without a prefix");
});

// check-commit

test("check-commit approves a clean, tested, trailered commit", () => {
  const { wt } = isolated();
  commit(wt, { "src/feature.js": "export const f = 2;\n" }, "Add feature" + trailers("U1", 7));
  const res = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7", "--json"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(gate("check-commit.mjs", [path.join(wt, "src"), "--base", "main", "--unit", "U1", "--issue", "7"]).code, 0, "config found from a subdirectory");
  const again = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7"]);
  assert.match(again.out, /\(cached\)/);
});

test("check-commit rejects each failure mode", () => {
  const { wt } = isolated({ paths_off_limits: ["ops/**"] });
  assert.deepEqual(failChecks(gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--json"])), ["non-empty diff"]);

  commit(wt, { "src/broken": "x\n", "src/c.js": "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> other\n", "ops/deploy.sh": "x\n" }, "Bad change");
  write(wt, "src/dirty.js", "uncommitted\n");
  const res = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7", "--no-cache", "--json"]);
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res).sort(), ["clean tree", "conflict markers", "paths", "tests", "trailers"].sort());
  assert.match(res.json.findings.find((f) => f.check === "trailers").detail, /Refs: #7/);
});

test("check-commit reports timeouts and commands that cannot start", () => {
  const a = isolated({ test_command: ["sh", "-c", "sleep 5"], limits: { test_timeout_seconds: 1 } });
  commit(a.wt, { "src/f.js": "1\n" }, "F" + trailers("U1"));
  assert.match(gate("check-commit.mjs", [a.wt, "--base", "main", "--unit", "U1"]).out, /test_command timed out/);
  const b = isolated({ test_command: ["./no-such-script"] });
  commit(b.wt, { "src/f.js": "1\n" }, "F" + trailers("U1"));
  assert.match(gate("check-commit.mjs", [b.wt, "--base", "main", "--unit", "U1"]).out, /test_command exited 127/);
});

test("path rules: dir/** covers the directory, and a glob does not over-match its prefix", () => {
  const { wt } = isolated({ paths_off_limits: ["vendored/**", "ops/*.sh", "**/*.key"] });
  commit(wt, { vendored: "file named like the dir\n", "ops/readme.md": "fine\n", "src/a.key": "k\n" }, "F" + trailers("U1"));
  const detail = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--json"]).json.findings.find((f) => f.check === "paths").detail;
  assert.match(detail, /vendored is off limits/);
  assert.match(detail, /src\/a.key is off limits/);
  assert.doesNotMatch(detail, /ops\/readme/);
});

test("gates exit 2 on missing or broken config and bad refs", () => {
  const r = makeRepo();
  assert.equal(gate("run-e2e.mjs", [r.root, "--sha", "no-such-ref"]).code, 2);
  write(r.root, ".cstack/config.json", "{");
  assert.match(gate("check-commit.mjs", [r.root, "--base", "main", "--unit", "U1"]).err, /does not parse/);
  assert.match(gate("check-commit.mjs", ["/", "--base", "main", "--unit", "U1"]).err, /no .cstack\/config.json/);
});

test("check-commit refuses bad usage", () => {
  const r = makeRepo();
  assert.equal(gate("check-commit.mjs", [r.root, "--base", "main"]).code, 2);
  assert.equal(gate("check-commit.mjs", [r.root, "--bogus"]).code, 2);
});

// run-e2e

test("run-e2e reports lanes without leaking hidden paths", () => {
  const { wt } = isolated();
  commit(wt, { "src/E1.1": "x\n" }, "E1.1" + trailers("U1"));
  const res = gate("run-e2e.mjs", [wt, "--json"]);
  assert.equal(res.code, 1);
  assert.equal(res.json.lanes["E1.1"], "pass");
  const e12 = res.json.findings.find((f) => f.check === "E1.2");
  assert.match(e12.detail, /expected E1.2 behaviour in <hidden>\/E1.2/);
  assert.doesNotMatch(res.out, /tests\/acceptance/);
  assert.equal(gate("run-e2e.mjs", [wt, "--lanes", "E1.1"]).code, 0);
  assert.match(gate("run-e2e.mjs", [wt, "--lanes", "E9.9"]).out, /lane not reported/);
});

test("run-e2e raw output is grader-only", () => {
  const { wt } = isolated();
  assert.equal(gate("run-e2e.mjs", [wt, "--raw"]).code, 2);
  const res = gate("run-e2e.mjs", [wt, "--raw"], { env: { CSTACK_ROLE: "grader" } });
  assert.match(res.err, /not ok 1 - E1.1/);
});

test("run-e2e fails on setup errors, missing TAP and missing config", () => {
  const a = isolated({ setup_command: ["sh", "-c", "exit 3"] });
  assert.match(gate("run-e2e.mjs", [a.wt]).out, /FAIL setup: setup_command exited 3/);
  const b = isolated({ setup_command: ["true"], e2e_command: ["sh", "-c", "echo hello"] });
  assert.match(gate("run-e2e.mjs", [b.wt]).out, /no lane results/);
  const c = isolated({ e2e_command: null });
  assert.equal(gate("run-e2e.mjs", [c.wt]).code, 2);
  assert.equal(gate("run-e2e.mjs", []).code, 2);
});

test("run-e2e times out and truncates long reasons", () => {
  const a = isolated({ e2e_command: ["sh", "-c", "sleep 5"], limits: { test_timeout_seconds: 1 } });
  assert.match(gate("run-e2e.mjs", [a.wt]).out, /timed out after 1s/);
  const long = "y".repeat(300);
  const b = isolated({ e2e_command: ["sh", "-c", `printf 'not ok 1 - E1.1 x\\n  ---\\n  message: ${long}\\n  ...\\nok 2 - E1.1 again\\nnot ok 3 - E1.2 bare\\nok 4 - E1.3 fine\\nnot ok 5 - E1.4 last\\n  error: |-\\n'`] });
  const res = gate("run-e2e.mjs", [b.wt, "--json"]);
  const f = Object.fromEntries(res.json.findings.map((x) => [x.check, x.detail]));
  assert.equal(f["E1.1"].length, 200);
  assert.equal(f["E1.2"], "failed (no message)");
  assert.equal(f["E1.4"], "failed (no message)");
});

// check-verdict

function verdictFile(dir, v) {
  const p = path.join(dir, "verdict.json");
  writeFileSync(p, JSON.stringify(v));
  return p;
}

test("check-verdict approves a delivered, tested head", () => {
  const { wt, base } = isolated();
  const sha = commit(wt, { "src/E1.1": "x\n", "src/f.js": "1\n", "test/f.test.js": "t\n" }, "F" + trailers("U1"));
  const v = verdictFile(base, { unit: "U1", head_sha: sha, requirements: [{ id: "R1", delivered: true, evidence: "ran it" }], findings: [] });
  assert.equal(gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1"]).code, 0);
  const res = gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--lanes", "E1.1", "--json"]);
  assert.equal(res.code, 0, res.out);
  assert.match(res.json.passes.find((p) => p.check === "tests at head").detail, /cached/);
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1"]).code, 0, "no lanes");
});

test("check-verdict reports a timed-out test command and a verdict with no fields", () => {
  const { wt, base } = isolated({ test_command: ["sh", "-c", "sleep 5"], limits: { test_timeout_seconds: 1 } });
  commit(wt, { "docs/a.md": "x\n" }, "D" + trailers("U1"));
  const v = verdictFile(base, {});
  const res = gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--json"]);
  const f = Object.fromEntries(res.json.findings.map((x) => [x.check, x.detail]));
  assert.match(f["tests at head"], /timed out/);
  assert.match(f.head, /verdict names nothing/);
  assert.equal(f["requirement R1"], "not assessed");
});

test("check-verdict rejects each failure mode", () => {
  const { wt, base } = isolated({ paths_off_limits: ["ops/**"] });
  commit(wt, { "src/f.js": "1\n", "src/broken": "x\n", "ops/x": "1\n" }, "F" + trailers("U1"));
  const v = verdictFile(base, {
    unit: "U1",
    head_sha: "0".repeat(40),
    requirements: [{ id: "R2", delivered: false, evidence: "" }, { id: "R3", delivered: true, evidence: " " }, { id: "R9", delivered: true, evidence: "x" }],
    findings: ["off by one"],
  });
  const res = gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1,R2,R3", "--lanes", "E1.2", "--json"]);
  assert.equal(res.code, 1);
  const got = failChecks(res);
  for (const c of ["head", "requirement R1", "requirement R2", "requirement R3", "requirement ids", "verifier findings", "tests changed", "paths", "tests at head", "e2e E1.2"]) {
    assert.ok(got.includes(c), `missing finding ${c}: ${got}`);
  }
});

test("check-verdict exempts docs-only changes and handles bad input", () => {
  const { wt, base } = isolated({ e2e_command: ["sh", "-c", "exit 1"] });
  const sha = commit(wt, { "docs/guide.md": "x\n" }, "Docs" + trailers("U1"));
  const v = verdictFile(base, { unit: "U1", head_sha: sha, requirements: [{ id: "R1", delivered: true, evidence: "read it" }] });
  const res = gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--lanes", "E1.1", "--json"]);
  assert.deepEqual(failChecks(res), ["e2e suite", "e2e E1.1"]);
  const broken = isolated({ e2e_command: null });
  const res2 = gate("check-verdict.mjs", [broken.wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--lanes", "E1.1", "--json"]);
  assert.match(res2.json.findings.find((f) => f.check === "e2e").detail, /e2e_command is not set/);
  writeFileSync(path.join(base, "bad.json"), "{");
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", path.join(base, "bad.json"), "--base", "main", "--requirements", "R1"]).code, 2);
  assert.equal(gate("check-verdict.mjs", [wt]).code, 2);
});
