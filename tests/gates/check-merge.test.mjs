import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeRepo, commit, gate, git, failChecks, path } from "./helpers.mjs";

// A repo whose origin has a PR branch, plus a ledger store and a fake gh scenario.
function setup({ cfg = {}, approve = true, review = true, pr = {}, checkRuns = [], extraRules = [] } = {}) {
  const r = makeRepo(cfg);
  const baseSha = git(r.root, "rev-parse", "HEAD");
  git(r.root, "checkout", "-q", "-b", "cstack/u1");
  const head = commit(r.root, { "src/f.js": "1\n" }, "F\n\nCstack-Unit: U1");
  git(r.root, "push", "-q", "origin", "cstack/u1");
  git(r.root, "checkout", "-q", "main");

  const store = mkdtempSync(path.join(tmpdir(), "cstack-store-"));
  const orch = (...a) => gate("orch.mjs", ["--store", store, ...a]);
  assert.equal(orch("init").code, 0);
  if (approve) assert.equal(orch("ledger", "record", "U1", head, "approved", "--pr", "5", "--evidence", "check-verdict approved", "--verifier", "fable").code, 0, "ledger record");
  if (review) {
    writeFileSync(path.join(store, "review-U1-rounds.tsv"), `round\thead\tmodel\tverdict\tusage\n1\t${head}\tsonnet\tAPPROVE\tnot exposed\n`);
    writeFileSync(path.join(store, "review-U1.tsv"), "id\tround\tseverity\tlocation\tclaim\toutcome\treplies\tevidence\nS1\t1\tnit\tsrc/f.js:1\tname\topen\t0\tx\n");
  }

  const view = {
    number: 5,
    state: "OPEN",
    isDraft: false,
    headRefOid: head,
    baseRefName: "main",
    baseRefOid: baseSha,
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    mergeCommit: null,
    files: [{ path: "src/f.js" }],
    ...pr,
  };
  const scenario = path.join(r.base, "gh.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      rules: [
        ...extraRules.map((x) => (typeof x === "function" ? x({ head, view }) : x)),
        { match: "^pr view 5", responses: [{ json: view }] },
        { match: "^api repos/o/r/commits/", responses: [{ stdout: JSON.stringify(checkRuns) + "\n" }] },
      ],
    }),
  );
  const run = (...a) => gate("check-merge.mjs", ["5", "--unit", "U1", "--repo-dir", r.root, "--store", store, "--json", ...a], { env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: path.join(r.base, "gh.log") } });
  return { ...r, head, baseSha, run, store, scenario };
}

const run1 = (status, conclusion, started = "2026-10-27T10:00:00Z", name = "ci") => ({ name, status, conclusion, started_at: started });

test("approves a verified, green, clean PR and does not merge without --merge", () => {
  const s = setup({ cfg: { required_checks: ["ci"] }, checkRuns: [run1("completed", "failure", "2026-10-27T09:00:00Z"), run1("completed", "success")] });
  const res = s.run();
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.json.merge_sha, null);
});

test("rejects each failure mode", () => {
  const s = setup({
    cfg: { required_checks: ["ci", "lint", "e2e"] },
    approve: false,
    review: false,
    pr: { isDraft: true, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "UNKNOWN" },
    checkRuns: [run1("in_progress", null), run1("completed", "failure", "2026-10-27T10:00:00Z", "lint")],
  });
  const res = s.run();
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res).sort(), ["check ci", "check e2e", "check lint", "ledger", "merge state", "pr state", "review", "reviews"].sort());
  assert.match(res.out, /still computing/);
});

test("an approval for a different head does not count", () => {
  const s = setup({ pr: { headRefOid: "b".repeat(40) } });
  assert.deepEqual(failChecks(s.run()).sort(), ["ledger", "review"]);
});

test("review: an open should finding blocks; a docs-only diff needs no review", () => {
  const s = setup();
  writeFileSync(path.join(s.store, "review-U1.tsv"), "S2\t1\tshould\tsrc/f.js:1\tmissing check\topen\t0\tx\n");
  const res = s.run();
  assert.deepEqual(failChecks(res), ["review"]);
  assert.match(res.out, /open review findings: S2/);
  const d = setup({ review: false, pr: { files: [{ path: "docs/a.md" }] } });
  const ok = d.run();
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /docs-only change/);
});

test("base moves: refuses when new base commits touch PR files, allows otherwise", () => {
  const s = setup();
  commit(s.root, { "src/f.js": "conflict\n" }, "base edit");
  git(s.root, "push", "-q", "origin", "main");
  const res = s.run();
  assert.deepEqual(failChecks(res), ["base"]);
  assert.match(res.out, /touched: src\/f.js/);

  const t = setup();
  commit(t.root, { "docs/other.md": "x\n" }, "base edit elsewhere");
  git(t.root, "push", "-q", "origin", "main");
  assert.equal(t.run().code, 0);
});

test("a failed fetch is a finding; required checks unreadable is a finding", () => {
  const s = setup({ cfg: { required_checks: ["ci"] }, extraRules: [{ match: "^api repos/o/r/commits/", responses: [{ code: 1, stderr: "HTTP 502" }] }] });
  git(s.root, "remote", "set-url", "origin", "/nonexistent/repo.git");
  const res = s.run();
  assert.deepEqual(failChecks(res).sort(), ["base", "required checks"]);
});

test("--merge under autonomy stop leaves the PR for a human", () => {
  const s = setup();
  const res = s.run("--merge");
  assert.deepEqual(failChecks(res), ["autonomy"]);
});

test("--merge under autonomy send merges at the verified head", () => {
  const s = setup({
    cfg: { autonomy: "send" },
    extraRules: [
      { match: "^pr merge 5 --repo o/r --merge --match-head-commit [0-9a-f]{40}$", responses: [{ stdout: "" }] },
      ({ head, view }) => ({ match: "^pr view 5", responses: [{ json: view }, { json: { ...view, state: "MERGED", mergeCommit: { oid: "m".repeat(40) } } }] }),
    ],
  });
  const res = s.run("--merge");
  assert.equal(res.code, 0, res.out);
  assert.equal(res.json.merge_sha, "m".repeat(40));
});

test("a merge error still counts when GitHub shows it merged at the head; otherwise fails", () => {
  const merged = setup({
    cfg: { autonomy: "send" },
    extraRules: [
      { match: "^pr merge", responses: [{ code: 1, stderr: "GraphQL: timeout" }] },
      ({ view }) => ({ match: "^pr view 5", responses: [{ json: view }, { json: { ...view, state: "MERGED", mergeCommit: { oid: "a".repeat(40) } } }] }),
    ],
  });
  const ok = merged.run("--merge");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /reported an error, GitHub shows it merged/);

  const failed = setup({ cfg: { autonomy: "send" }, extraRules: [{ match: "^pr merge", responses: [{ code: 1, stderr: "Head branch was modified" }] }] });
  const bad = failed.run("--merge");
  assert.deepEqual(failChecks(bad), ["merge"]);
  assert.match(bad.out, /Head branch was modified/);

  const silent = setup({ cfg: { autonomy: "send" }, extraRules: [{ match: "^pr merge", responses: [{ code: 1 }] }] });
  assert.match(silent.run("--merge").out, /merge failed: OPEN/);
});

test("defaults: repo dir is the cwd and the store comes from CSTACK_RUN", () => {
  const s = setup();
  assert.equal(gate("orch.mjs", ["--run", "r1", "init"], { cwd: s.root }).code, 0);
  assert.equal(gate("orch.mjs", ["--run", "r1", "ledger", "record", "U1", s.head, "approved", "--pr", "5", "--evidence", "x"], { cwd: s.root }).code, 0);
  writeFileSync(path.join(s.root, ".cstack/runs/r1/review-U1-rounds.tsv"), `1\t${s.head}\tsonnet\tAPPROVE\tnot exposed\n`);
  const res = gate("check-merge.mjs", ["5", "--unit", "U1"], { cwd: s.root, env: { FAKE_GH_SCENARIO: s.scenario, CSTACK_RUN: "r1" } });
  assert.equal(res.code, 0, res.out + res.err);
});

test("with no store and no CSTACK_RUN, ledger and review both fail", () => {
  const s = setup({ approve: false, review: false });
  const res = gate("check-merge.mjs", ["5", "--unit", "U1", "--repo-dir", s.root, "--json"], { env: { FAKE_GH_SCENARIO: s.scenario, CSTACK_RUN: "" } });
  assert.deepEqual(failChecks(res).sort(), ["ledger", "review"]);
});

test("usage errors exit 2", () => {
  const s = setup({ extraRules: [{ match: "^pr view 6", responses: [{ code: 1, stderr: "not found" }] }] });
  assert.equal(gate("check-merge.mjs", ["abc", "--unit", "U1"]).code, 2);
  assert.equal(gate("check-merge.mjs", ["5"]).code, 2);
  const res = gate("check-merge.mjs", ["6", "--unit", "U1", "--repo-dir", s.root], { env: { FAKE_GH_SCENARIO: s.scenario } });
  assert.equal(res.code, 2);
  assert.match(res.err, /gh pr view 6 failed/);
});
