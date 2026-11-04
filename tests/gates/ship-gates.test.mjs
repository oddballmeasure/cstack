import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeRepo, commit, gate, git, write, failChecks, approve, path } from "./helpers.mjs";

function scenario(base, rules) {
  const p = path.join(base, `gh-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ rules }));
  return { FAKE_GH_SCENARIO: p, FAKE_GH_LOG: p + ".log" };
}
function isolated(cfg) {
  const r = makeRepo(cfg);
  const wt = path.join(r.base, "wt");
  assert.equal(gate("isolate.mjs", [r.root, "cstack/1-x", wt]).code, 0);
  return { ...r, wt };
}

// settle

test("settle swaps state labels and posts the comment once", async () => {
  const { readFileSync } = await import("node:fs");
  const r = makeRepo();
  const body = path.join(r.base, "c.md");
  writeFileSync(body, "cstack resolved this in #5\n\nmore\n");
  const env = scenario(r.base, [
    { match: "^issue view 3", responses: [{ json: { labels: [{ name: "cstack:in-progress" }, { name: "bug" }], comments: [{ body: "hello" }] } }] },
    { match: "^issue edit 3 --repo o/r --add-label cstack:done --remove-label cstack:in-progress$", responses: [{}] },
    { match: "^issue comment 3 --repo o/r --body-file ", responses: [{}] },
  ]);
  const res = gate("settle.mjs", ["3", "--state", "done", "--comment-file", body, "--repo-dir", r.root, "--json"], { env });
  assert.equal(res.code, 0, res.out + res.err);
  const log = readFileSync(env.FAKE_GH_LOG, "utf8");
  assert.match(log, /issue edit 3/);
  assert.match(log, /issue comment 3/);
});

test("settle is a no-op when the label and comment are already there", async () => {
  const { readFileSync } = await import("node:fs");
  const r = makeRepo();
  const body = path.join(r.base, "c.md");
  writeFileSync(body, "cstack resolved this in #5\n");
  const env = scenario(r.base, [{ match: "^issue view 3", responses: [{ json: { labels: [{ name: "cstack:done" }], comments: [{ body: "  cstack resolved this in #5\nold body" }] } }] }]);
  const res = gate("settle.mjs", ["3", "--state", "done", "--comment-file", body], { env, cwd: r.root });
  assert.equal(res.code, 0, res.out + res.err);
  assert.match(res.out, /already set/);
  assert.match(res.out, /already posted/);
  assert.doesNotMatch(readFileSync(env.FAKE_GH_LOG, "utf8"), /edit|comment 3/);
});

test("settle adds a missing label without removals and reports gh failures", () => {
  const r = makeRepo();
  const body = path.join(r.base, "c.md");
  writeFileSync(body, "cstack stopped at verify\n");
  const env = scenario(r.base, [
    { match: "^issue view 3", responses: [{ json: { labels: [], comments: [] } }] },
    { match: "^issue edit 3 --repo o/r --add-label cstack:error$", responses: [{ code: 1, stderr: "HTTP 403" }] },
    { match: "^issue comment", responses: [{ code: 1, stderr: "HTTP 500" }] },
  ]);
  const res = gate("settle.mjs", ["3", "--state", "error", "--comment-file", body, "--repo-dir", r.root, "--json"], { env });
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res), ["label", "comment"]);
  const env2 = scenario(r.base, [
    { match: "^issue view 3", responses: [{ json: { labels: [{ name: "cstack:done" }, { name: "cstack:error" }], comments: [] } }] },
    { match: "^issue edit 3 --repo o/r --remove-label cstack:error$", responses: [{}] },
  ]);
  assert.equal(gate("settle.mjs", ["3", "--state", "done", "--repo-dir", r.root], { env: env2 }).code, 0);
});

test("settle usage and gh view errors exit 2", () => {
  const r = makeRepo();
  assert.equal(gate("settle.mjs", ["3", "--state", "bogus", "--repo-dir", r.root]).code, 2);
  assert.equal(gate("settle.mjs", ["x", "--state", "done", "--repo-dir", r.root]).code, 2);
  const env = scenario(r.base, [{ match: "^issue view", responses: [{ code: 1, stderr: "not found" }] }]);
  assert.match(gate("settle.mjs", ["3", "--state", "done", "--repo-dir", r.root], { env }).err, /issue view 3 failed/);
});

// sync-base

test("sync-base: up to date, then merged, then conflict", () => {
  const { root, wt } = isolated();
  commit(wt, { "src/f.js": "unit\n" }, "unit work");
  let res = gate("sync-base.mjs", [wt, "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.json.outcome, "up-to-date");

  commit(root, { "docs/a.md": "base\n" }, "base moves elsewhere");
  git(root, "push", "-q", "origin", "main");
  res = gate("sync-base.mjs", [wt, "--json"]);
  assert.equal(res.json.outcome, "merged", res.out + res.err);
  assert.match(git(wt, "log", "-1", "--format=%s"), /^Merge main into cstack\/1-x$/);

  commit(root, { "src/f.js": "base edit\n" }, "base edits the same file");
  git(root, "push", "-q", "origin", "main");
  res = gate("sync-base.mjs", [wt, "--json"]);
  assert.equal(res.code, 1);
  assert.deepEqual(res.json.conflicted, ["src/f.js"]);
  assert.match(git(wt, "status", "--porcelain"), /^(UU|AA) src\/f.js/);
});

test("sync-base refuses a dirty tree, a failed fetch and bad usage", () => {
  const { wt } = isolated();
  write(wt, "src/app.js", "dirty\n");
  assert.match(gate("sync-base.mjs", [wt]).err, /uncommitted changes/);
  git(wt, "checkout", "--", "src/app.js");
  git(wt, "remote", "set-url", "origin", "/nonexistent.git");
  assert.match(gate("sync-base.mjs", [wt]).err, /git fetch origin main failed/);
  assert.equal(gate("sync-base.mjs", []).code, 2);
});

// publish

// A run store where unit U1 owns the worktree's branch, as cstack:unit stage 2 records it.
function unitStore(branch = "cstack/1-x") {
  const store = mkdtempSync(path.join(tmpdir(), "cstack-store-"));
  const orch = (...a) => gate("orch.mjs", ["--store", store, ...a]);
  assert.equal(orch("init").code, 0);
  assert.equal(orch("unit", "add", "U1", "--track", "issue").code, 0);
  assert.equal(orch("unit", "set", "U1", "--branch", branch).code, 0);
  return { store, orch, args: (wt, unit = "U1") => [wt, "--store", store, "--unit", unit] };
}
const remoteHead = (wt) => git(wt, "ls-remote", "origin", "refs/heads/cstack/1-x");

test("publish pushes an approved head, is idempotent, and refuses a moved remote", () => {
  const { wt, base } = isolated();
  const u = unitStore();
  const head = commit(wt, { "src/f.js": "1\n" }, "work");
  approve(u.store, "U1", head);
  let res = gate("publish.mjs", [...u.args(wt), "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(res.json.sha, head);
  assert.match(res.json.passes.find((p) => p.check === "ledger").detail, /^approved for U1 at /);
  assert.match(gate("publish.mjs", u.args(wt)).out, /already at/);

  // Someone else pushes to the branch: our lease (observed just before) still protects their work
  // because we re-read it, so simulate a race by making the push itself fail.
  const other = path.join(base, "other");
  git(base, "clone", "-q", "-b", "cstack/1-x", path.join(base, "origin.git"), other);
  commit(other, { "src/g.js": "theirs\n" }, "theirs");
  git(other, "push", "-q", "origin", "cstack/1-x");
  approve(u.store, "U1", commit(wt, { "src/h.js": "ours\n" }, "ours"));
  git(wt, "config", "remote.origin.pushurl", "/nonexistent.git");
  res = gate("publish.mjs", [...u.args(wt), "--json"]);
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res), ["push", "remote sha"]);
});

test("publish reports a missing remote branch when the first push fails", () => {
  const { wt } = isolated();
  const u = unitStore();
  approve(u.store, "U1", commit(wt, { "src/f.js": "1\n" }, "work"));
  git(wt, "config", "remote.origin.pushurl", "/nonexistent.git");
  assert.match(gate("publish.mjs", u.args(wt)).out, /is missing, expected/);
});

test("publish pushes nothing when check-verdict rejected the head, even after a hand-recorded approval", () => {
  const { wt, base } = isolated();
  const u = unitStore();
  const head = commit(wt, { "src/f.js": "1\n", "test/f.test.js": "t\n" }, "work");
  let res = gate("publish.mjs", [...u.args(wt), "--json"]);
  assert.equal(res.code, 1);
  assert.match(res.json.findings.find((f) => f.check === "ledger").detail, /no approval for U1 at .+ \(not verified\); verify this head first/);

  // The incident: check-verdict rejects, and the same command chain records an approval and publishes.
  const verdict = path.join(base, "verdict.json");
  writeFileSync(verdict, JSON.stringify({ unit: "U1", head_sha: head, requirements: [{ id: "R1", delivered: true, evidence: "ran it" }], findings: ["off by one"] }));
  assert.equal(gate("check-verdict.mjs", [wt, "--verdict", verdict, "--base", "main", "--requirements", "R1", "--store", u.store, "--unit", "U1"]).code, 1);
  assert.equal(u.orch("ledger", "record", "U1", head, "approved", "--evidence", verdict).code, 2);
  res = gate("publish.mjs", [...u.args(wt), "--json"]);
  assert.equal(res.code, 1);
  assert.deepEqual(failChecks(res), ["ledger"]);
  assert.match(res.json.findings[0].detail, /\(rejected\)/);
  assert.equal(remoteHead(wt), "", "nothing was pushed");
});

test("publish refuses a unit that does not own the branch, so a hand-recorded E2E approval publishes nothing else", () => {
  const { wt } = isolated();
  const u = unitStore();
  const head = commit(wt, { "src/f.js": "1\n" }, "work");
  assert.equal(u.orch("unit", "add", "E2E", "--track", "e2e").code, 0);
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/2-e2e").code, 0);
  assert.equal(u.orch("ledger", "record", "E2E", head, "approved", "--evidence", "e2e-plan.md", "--verifier", "check-e2e").code, 0);
  let res = gate("publish.mjs", [...u.args(wt, "E2E"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit"]);
  assert.match(res.json.findings[0].detail, /unit E2E is on branch cstack\/2-e2e, not cstack\/1-x/);
  assert.equal(u.orch("unit", "add", "U2", "--track", "issue").code, 0);
  res = gate("publish.mjs", [...u.args(wt, "U2"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit", "ledger"]);
  assert.match(res.json.findings[0].detail, /unit U2 is on branch \(none\)/);
  res = gate("publish.mjs", [...u.args(wt, "U9"), "--json"]);
  assert.match(res.json.findings[0].detail, /unit U9 is not in .+units\.tsv/);
  assert.equal(remoteHead(wt), "", "nothing was pushed");

  // Pointing E2E at another unit's branch does not help: U1 still claims it.
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/1-x").code, 0);
  res = gate("publish.mjs", [...u.args(wt, "E2E"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit"]);
  assert.equal(res.json.findings[0].detail, "cstack/1-x is also claimed by U1");
  assert.equal(remoteHead(wt), "", "nothing was pushed");

  // E2E publishes its own branch with the coordinator's recorded approval.
  git(wt, "checkout", "-q", "-b", "cstack/2-e2e");
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/2-e2e").code, 0);
  res = gate("publish.mjs", [...u.args(wt, "E2E"), "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
});

test("publish holds the hand-recorded units to their shape: E2E needs track e2e, program-final never publishes", () => {
  const { wt } = isolated();
  const u = unitStore();
  const head = commit(wt, { "src/f.js": "1\n" }, "work");
  git(wt, "checkout", "-q", "-b", "cstack/9-fake");
  assert.equal(u.orch("unit", "add", "E2E", "--track", "issue").code, 0);
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/9-fake").code, 0);
  approve(u.store, "E2E", head);
  let res = gate("publish.mjs", [...u.args(wt, "E2E"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit"]);
  assert.equal(res.json.findings[0].detail, "unit E2E has track issue, not e2e");
  // A suite amendment is held to the same shape, and publishes on track e2e.
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/other").code, 0);
  assert.equal(u.orch("unit", "add", "E2E-UI", "--track", "issue").code, 0);
  assert.equal(u.orch("unit", "set", "E2E-UI", "--branch", "cstack/9-fake").code, 0);
  approve(u.store, "E2E-UI", head);
  res = gate("publish.mjs", [...u.args(wt, "E2E-UI"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit"]);
  assert.equal(res.json.findings[0].detail, "unit E2E-UI has track issue, not e2e");
  assert.equal(u.orch("unit", "set", "E2E-UI", "--track", "e2e").code, 0);
  res = gate("publish.mjs", [...u.args(wt, "E2E-UI"), "--json"]);
  assert.equal(res.code, 0, res.out + res.err);
  git(wt, "push", "-q", "origin", "--delete", "cstack/9-fake");
  assert.equal(u.orch("unit", "set", "E2E-UI", "--branch", "cstack/ui").code, 0);
  assert.equal(u.orch("unit", "add", "program-final", "--track", "e2e").code, 0);
  assert.equal(u.orch("unit", "set", "E2E", "--branch", "cstack/other").code, 0);
  assert.equal(u.orch("unit", "set", "program-final", "--branch", "cstack/9-fake").code, 0);
  assert.equal(u.orch("ledger", "record", "program-final", head, "approved", "--evidence", "final.json").code, 0);
  res = gate("publish.mjs", [...u.args(wt, "program-final"), "--json"]);
  assert.deepEqual(failChecks(res), ["unit"]);
  assert.match(res.json.findings[0].detail, /program-final judges a merged base and is never published/);
  assert.equal(git(wt, "ls-remote", "origin", "refs/heads/cstack/9-fake"), "", "nothing was pushed");
});

test("publish errors: detached HEAD, unreachable remote, missing store, usage", () => {
  const { wt } = isolated();
  const u = unitStore();
  git(wt, "checkout", "-q", "--detach");
  assert.match(gate("publish.mjs", u.args(wt)).err, /detached HEAD/);
  git(wt, "checkout", "-q", "cstack/1-x");
  approve(u.store, "U1", git(wt, "rev-parse", "HEAD"));
  git(wt, "remote", "set-url", "origin", "/nonexistent.git");
  assert.match(gate("publish.mjs", u.args(wt)).err, /ls-remote failed/);
  assert.equal(gate("publish.mjs", [wt, "--store", path.join(u.store, "missing"), "--unit", "U1"]).code, 2);
  assert.equal(gate("publish.mjs", []).code, 2);
  assert.equal(gate("publish.mjs", [wt, "--unit", "U1"]).code, 2);
  assert.equal(gate("publish.mjs", [wt, "--store", u.store]).code, 2);
});

test("check-verdict usage names --store and --unit and says nothing is recorded without them", () => {
  const res = gate("check-verdict.mjs", []);
  assert.equal(res.code, 2);
  assert.match(res.err, /\[--store <dir> --unit <id>\]/);
  assert.match(res.err, /without them nothing is recorded, so publish\.mjs refuses this head/);
});

// ci-log

test("ci-log returns tails for failed checks only", () => {
  const r = makeRepo();
  const sha = "a".repeat(40);
  const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const env = scenario(r.base, [
    { match: "^pr view 5", responses: [{ json: { headRefOid: sha } }] },
    {
      match: "^api repos/o/r/commits/",
      responses: [
        {
          json: [
            { name: "test", conclusion: "failure", started_at: "2026-10-27T10:00:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/42", output: {} },
            { name: "test", conclusion: "success", started_at: "2026-10-27T09:00:00Z", details_url: "", output: {} },
            { name: "lint", conclusion: "success", started_at: "2026-10-27T10:00:00Z", details_url: "", output: {} },
            { name: "ext", conclusion: "timed_out", started_at: "2026-10-27T10:00:00Z", details_url: "https://ci.example/1", output: { summary: "took too long", text: null } },
            { name: "bare", conclusion: "cancelled", started_at: "2026-10-27T10:00:00Z", details_url: null, output: { summary: null, text: null } },
            { name: "gone", conclusion: "failure", started_at: "2026-10-27T10:00:00Z", details_url: "https://github.com/o/r/actions/runs/1/job/43", output: {} },
          ],
        },
      ],
    },
    { match: "^api --allow-escape-sequences repos/o/r/actions/jobs/42/logs", responses: [{ stdout: log.replace("line 99", "\u001b[31mline 99\u001b[0m") + "\n" }] },
    { match: "^api --allow-escape-sequences repos/o/r/actions/jobs/43/logs", responses: [{ code: 1, stderr: "HTTP 410" }] },
  ]);
  const res = gate("ci-log.mjs", ["5", "--repo-dir", r.root, "--lines", "3", "--json"], { env });
  assert.equal(res.code, 1, res.out + res.err);
  const byName = Object.fromEntries(res.json.failures.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ["bare", "ext", "gone", "test"]);
  assert.equal(byName.test.tail, "line 97\nline 98\nline 99");
  assert.equal(byName.ext.tail, "took too long");
  assert.equal(byName.bare.tail, "(no output)");
  assert.match(byName.gone.tail, /job log unavailable: HTTP 410/);
});

test("ci-log with nothing failed passes; errors exit 2", () => {
  const r = makeRepo();
  const env = scenario(r.base, [
    { match: "^pr view 5", responses: [{ json: { headRefOid: "b".repeat(40) } }] },
    { match: "^api repos/o/r/commits/", responses: [{ json: [] }] },
    { match: "^pr view 6", responses: [{ code: 1, stderr: "nope" }] },
  ]);
  const ok = gate("ci-log.mjs", ["5"], { env, cwd: r.root });
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.match(ok.out, /no failed checks/);
  assert.match(gate("ci-log.mjs", ["6", "--repo-dir", r.root], { env }).err, /gh pr view 6 failed/);
  assert.equal(gate("ci-log.mjs", ["5", "--lines", "0", "--repo-dir", r.root]).code, 2);
});
