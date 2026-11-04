import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { makeRepo, commit, gate, git, write, failChecks, existsSync, path } from "./helpers.mjs";
import { isTest } from "../../gates/lib/repo.mjs";

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

test("isolate starts a new branch from the fetched origin base, not a stale local one", () => {
  const r = makeRepo({ paths_hidden: [] });
  const other = path.join(r.base, "other");
  git(r.base, "clone", "-q", r.origin, other);
  const tip = commit(other, { "src/new.js": "export const n = 1;\n" }, "Land on origin");
  git(other, "push", "-q", "origin", "main");
  const res = gate("isolate.mjs", [r.root, "cstack/u3", path.join(r.base, "wt3"), "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
  const out = JSON.parse(res.out);
  assert.equal(out.start, "origin/main");
  assert.equal(out.sha, tip);
  assert.ok(existsSync(path.join(r.base, "wt3/src/new.js")));
  assert.match(out.passes[0].detail, new RegExp(`from origin/main at ${tip.slice(0, 12)}`));
  assert.notEqual(git(r.root, "rev-parse", "main"), tip, "local main stays as it was");
});

test("isolate uses the local base with no origin remote, and honours an explicit --base", () => {
  const r = makeRepo({ paths_hidden: [] });
  const first = git(r.root, "rev-parse", "HEAD");
  git(r.root, "remote", "remove", "origin");
  const second = commit(r.root, { "src/local.js": "export const l = 1;\n" }, "Local only");
  const res = gate("isolate.mjs", [r.root, "cstack/u4", path.join(r.base, "wt4")]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, new RegExp(`from main at ${second.slice(0, 12)}`));
  const pinned = gate("isolate.mjs", [r.root, "cstack/u5", path.join(r.base, "wt5"), "--base", first, "--json"]);
  assert.equal(pinned.code, 0, pinned.out + pinned.err);
  assert.equal(JSON.parse(pinned.out).sha, first);
});

test("isolate stops when origin has no copy of the base branch", () => {
  const r = makeRepo({ paths_hidden: [], base_branch: "trunk" });
  git(r.root, "branch", "trunk");
  const res = gate("isolate.mjs", [r.root, "cstack/u6", path.join(r.base, "wt6")]);
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, /git fetch origin trunk failed/);
  assert.ok(!existsSync(path.join(r.base, "wt6")));
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

test("check-verdict counts a browser spec as a test, so a fix to one alone can pass", () => {
  for (const f of ["frontend/e2e/quiz.e2e.js", "e2e/helpers.js", "src/app.e2e.ts"]) assert.equal(isTest(f), true, f);
  for (const f of ["frontend/src/e2e.js", "src/e2e-utils/x.js", "src/foo.e2e"]) assert.equal(isTest(f), false, f);
});

test("check-commit approves a clean, tested, trailered commit", () => {
  const { wt } = isolated();
  commit(wt, { "src/feature.js": "export const f = 2;\n" }, "Add feature" + trailers("U1", 7));
  const res = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7", "--json"]);
  assert.equal(res.code, 0, res.out);
  assert.equal(gate("check-commit.mjs", [path.join(wt, "src"), "--base", "main", "--unit", "U1", "--issue", "7"]).code, 0, "config found from a subdirectory");
  const again = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7"]);
  assert.match(again.out, /\(cached\)/);
});

test("a cached failing test result is re-run, never reused", () => {
  const { wt } = isolated();
  commit(wt, { "src/broken": "x\n", "src/f.js": "1\n" }, "F" + trailers("U1"));
  const first = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--json"]);
  assert.equal(first.code, 1);
  // Same tree, cache on: the failure in the cache is ignored and the tests run again.
  const again = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--json"]);
  const tests = again.json.findings.find((f) => f.check === "tests");
  assert.ok(tests, "still failing");
  assert.doesNotMatch(tests.detail, /cached/);
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

test("check-commit accepts trailers split by a blank line, so a fix-forward can pass", () => {
  const { wt } = isolated();
  commit(wt, { "src/f.js": "1\n" }, "Add f\n\nCstack-Unit: U1\nCstack-Ticket: T1\nRefs: #7\n\nCo-Authored-By: X <x@y>");
  const res = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7"]);
  assert.equal(res.code, 0, res.out);
});

test("check-commit still wants the exact unit and issue, on a line of their own", () => {
  const { wt } = isolated();
  commit(wt, { "src/f.js": "1\n" }, "Add f\n\nThis is not Cstack-Unit: U1\n\nCstack-Unit: U2\nRefs: #8");
  const res = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--issue", "7"]);
  assert.equal(res.code, 1);
  assert.match(res.out, /lacks Cstack-Unit: U1/);
  assert.match(res.out, /lacks Refs: #7/);
});

test("check-commit flags a change to the cstack config", () => {
  const { wt, config } = isolated();
  commit(wt, { ".cstack/config.json": JSON.stringify({ ...config, autonomy: "send" }), "test/x.test.js": "t\n" }, "F" + trailers("U1"));
  const detail = gate("check-commit.mjs", [wt, "--base", "main", "--unit", "U1", "--json"]).json.findings.find((f) => f.check === "paths").detail;
  assert.match(detail, /\.cstack\/config\.json is off limits/);
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

const REPORT = "final-e2e-0123456789ab.json";

test("run-e2e --out writes the --json report into the run store and keeps stdout unchanged", () => {
  const { root, wt } = isolated();
  const file = path.join(root, ".cstack/runs/prog", REPORT);
  const json = gate("run-e2e.mjs", [wt, "--json", "--out", file]);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), json.json);
  assert.equal(readFileSync(file, "utf8"), json.out);
  // Text mode still prints text; a relative --out resolves against the cwd; a directory named ..x is inside the store.
  const text = gate("run-e2e.mjs", [wt, "--lanes", "E1.2", "--out", path.join("..x", REPORT)], { cwd: path.join(root, ".cstack/runs") });
  assert.match(text.out, /^FAIL E1.2: /m);
  const saved = JSON.parse(readFileSync(path.join(root, ".cstack/runs/..x", REPORT), "utf8"));
  assert.equal(saved.approved, false);
  assert.deepEqual(saved.findings.map((f) => f.check), ["E1.2"]);
  const setup = isolated({ setup_command: ["sh", "-c", "exit 3"] });
  const early = path.join(setup.root, ".cstack/runs/x", REPORT);
  gate("run-e2e.mjs", [setup.wt, "--out", early]);
  assert.equal(JSON.parse(readFileSync(early, "utf8")).findings[0].check, "setup");
});

test("run-e2e --out refuses other names, paths outside the run store, and an existing report", () => {
  const { root, base, wt } = isolated();
  const runs = path.join(root, ".cstack/runs");
  write(root, ".cstack/runs/p/verdict-U1-0123456789ab.json", "{}\n");
  write(root, ".cstack/runs/p/frontier.json", "{}\n");
  write(root, `.cstack/runs/p/${REPORT}`, "kept\n");
  for (const bad of [
    path.join(base, REPORT), runs, path.join(runs, "..", REPORT), path.join(runs, `x/${REPORT.replace(".json", ".txt")}`),
    path.join(wt, ".cstack/runs", REPORT), path.join(runs, "p/verdict-U1-0123456789ab.json"), path.join(runs, "p/frontier.json"),
    path.join(runs, "p/final-e2e-abc.json"), path.join(runs, "p/final-e2e-0123456789AB.json"),
  ]) {
    const res = gate("run-e2e.mjs", [wt, "--out", bad]);
    assert.equal(res.code, 2, bad);
    assert.match(res.err, /--out must be a file named final-e2e-<12 hex>.json inside/, bad);
  }
  const again = gate("run-e2e.mjs", [wt, "--out", path.join(runs, "p", REPORT)]);
  assert.equal(again.code, 2);
  assert.match(again.err, /already exists; --out never overwrites/);
  assert.equal(readFileSync(path.join(runs, "p", REPORT), "utf8"), "kept\n");
  assert.equal(readFileSync(path.join(runs, "p/verdict-U1-0123456789ab.json"), "utf8"), "{}\n");
  assert.equal(readFileSync(path.join(runs, "p/frontier.json"), "utf8"), "{}\n");
  assert.ok(!existsSync(path.join(base, REPORT)));
});

test("run-e2e --out refuses a symlinked directory under the run store that points outside it", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const { root, base, wt } = isolated();
  const outside = path.join(base, "elsewhere");
  mkdirSync(outside);
  mkdirSync(path.join(root, ".cstack/runs"), { recursive: true });
  symlinkSync(outside, path.join(root, ".cstack/runs/link"));
  const res = gate("run-e2e.mjs", [wt, "--out", path.join(root, ".cstack/runs/link", REPORT)]);
  assert.equal(res.code, 2);
  assert.match(res.err, /--out must be a file named/);
  assert.ok(!existsSync(path.join(outside, REPORT)));
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

test("check-verdict --store records the gate's own result in the ledger, never the verifier's", () => {
  const { wt, base } = isolated();
  const store = path.join(base, "store");
  assert.equal(gate("orch.mjs", ["--store", store, "init"]).code, 0);
  const ledger = (sha) => gate("orch.mjs", ["--store", store, "--json", "ledger", "check", "U1", sha]);
  const args = (v) => [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--store", store, "--unit", "U1", "--json"];
  const good = commit(wt, { "src/f.js": "1\n", "test/f.test.js": "t\n" }, "F" + trailers("U1"));
  const v = verdictFile(base, { unit: "U1", head_sha: good, requirements: [{ id: "R1", delivered: true, evidence: "ran it" }], findings: [], by: "opus" });
  let res = gate("check-verdict.mjs", args(v));
  assert.equal(res.code, 0, res.out);
  assert.match(res.json.passes.find((p) => p.check === "ledger").detail, /recorded approved for U1/);
  let row = ledger(good).json;
  assert.equal(row.verdict, "approved");
  assert.equal(row.verifier, "opus");
  assert.equal(row.evidence, v);

  // The verifier approves, but the gate finds a problem: the ledger holds the gate's rejection.
  const bad = commit(wt, { "src/g.js": "1\n" }, "G" + trailers("U1"));
  const v2 = verdictFile(base, { unit: "U2", head_sha: bad, requirements: [{ id: "R1", delivered: true, evidence: "ran it" }], findings: [] });
  res = gate("check-verdict.mjs", args(v2));
  assert.equal(res.code, 1);
  assert.match(res.json.findings.find((f) => f.check === "unit").detail, /verdict names unit U2, not U1/);
  row = ledger(bad).json;
  assert.equal(row.verdict, "rejected");
  assert.equal(row.verifier, "cstack-verifier");
  assert.equal(ledger(bad).code, 1);

  res = gate("check-verdict.mjs", args(verdictFile(base, { head_sha: bad, requirements: [] })));
  assert.match(res.json.findings.find((f) => f.check === "unit").detail, /verdict names unit nothing/);
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--store", store]).code, 2);
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--unit", "U1"]).code, 2);
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--store", path.join(base, "none"), "--unit", "U1"]).code, 2, "an uninitialized store");
});

test("check-verdict counts a rename out of src/ as a code change that needs a test", () => {
  const { wt, base } = isolated();
  mkdirSync(path.join(wt, "docs"));
  git(wt, "mv", "src/app.js", "docs/app.md");
  const sha = commit(wt, {}, "Move" + trailers("U1"));
  const v = verdictFile(base, { unit: "U1", head_sha: sha, requirements: [{ id: "R1", delivered: true, evidence: "read it" }] });
  const res = gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--json"]);
  assert.deepEqual(failChecks(res), ["tests changed"]);
  assert.match(res.out, /code changed \(src\/app\.js\) with no test change/);
});

test("check-verdict reads config docs_paths: a listed .html file is a doc, an unlisted .md file is code", () => {
  const verdict = (files) => {
    const { wt, base } = isolated({ docs_paths: ["site/**"] });
    const sha = commit(wt, files, "Change" + trailers("U1"));
    const v = verdictFile(base, { unit: "U1", head_sha: sha, requirements: [{ id: "R1", delivered: true, evidence: "read it" }] });
    return gate("check-verdict.mjs", [wt, "--verdict", v, "--base", "main", "--requirements", "R1", "--json"]);
  };
  const site = verdict({ "site/index.html": "<p>x</p>\n" });
  assert.equal(site.code, 0, site.out);
  assert.match(site.out, /docs or tests only/);
  const skill = verdict({ "skills/x/SKILL.md": "x\n" });
  assert.deepEqual(failChecks(skill), ["tests changed"]);
  assert.match(skill.out, /code changed \(skills\/x\/SKILL\.md\) with no test change/);
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
