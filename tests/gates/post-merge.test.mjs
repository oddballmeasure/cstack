import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { makeRepo, gate, path } from "./helpers.mjs";

const SHA = "c".repeat(40);
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const merged = (min = 1) => ({ json: { state: "MERGED", mergeCommit: { oid: SHA }, mergedAt: ago(min) } });
const check = (o) => ({ status: "completed", conclusion: "success", details_url: "https://ci.example/x", ...o });
const job = (run, id) => `https://github.com/o/r/actions/runs/${run}/job/${id}`;

function program(units = [{ id: "U1", pr: 5, issue: 3 }]) {
  const r = makeRepo();
  const store = path.join(r.root, ".cstack/runs/prog");
  const orch = (...a) => assert.equal(gate("orch.mjs", ["--store", store, ...a]).code, 0);
  orch("init");
  for (const u of units) {
    orch("unit", "add", u.id, "--track", "core", "--state", "ready", ...(u.issue ? ["--issue", String(u.issue)] : []));
    orch("unit", "set", u.id, "--state", u.state ?? "merged", ...(u.pr ? ["--pr", String(u.pr)] : []), "--sha", "h".repeat(40));
  }
  let n = 0;
  const judge = (rules, args = [], env = {}) => {
    const scenario = path.join(r.base, `gh-${n++}.json`);
    writeFileSync(scenario, JSON.stringify({ rules }));
    const log = path.join(r.base, "gh.log");
    const res = gate("post-merge.mjs", ["--store", store, "--json", ...args], { env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log, ...env } });
    return { ...res, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  const rows = () => readFileSync(path.join(store, "post-merge.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
  return { ...r, store, orch, judge, rows };
}

const byPr = (res) => Object.fromEntries(res.json.merges.map((m) => [m.pr, m]));

test("post-merge usage errors exit 2", () => {
  const p = program();
  assert.equal(gate("post-merge.mjs", []).code, 2);
  assert.equal(gate("post-merge.mjs", ["--store", p.store, "x"]).code, 2);
  assert.equal(gate("post-merge.mjs", ["--store", p.store, "--lines", "0"]).code, 2);
});

test("green checks pass once and are not asked again; unmerged and PR-less units are skipped", () => {
  const p = program([
    { id: "U1", pr: 5, issue: 3 },
    { id: "U2", pr: 6, state: "done" },
    { id: "U3", pr: 7, state: "pr-open" },
    { id: "U4" },
  ]);
  const rules = [
    { match: "^pr view 5 ", responses: [merged()] },
    { match: "^pr view 6 ", responses: [{ json: { state: "CLOSED", mergeCommit: null, mergedAt: null } }] },
    {
      match: "^api repos/o/r/commits/c+/check-runs",
      responses: [{ json: [check({ name: "ci", id: 1 }), check({ name: "ci", id: 2, conclusion: "skipped" }), check({ name: "lint", id: 3, conclusion: "neutral" })] }],
    },
  ];
  const res = p.judge(rules);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(byPr(res)[5].state, "passed");
  assert.equal(byPr(res)[5].merge_sha, SHA, "GitHub's merge commit, not the units.tsv sha");
  assert.equal(byPr(res)[6].state, "not-merged");
  assert.equal(res.json.pending, 0);
  assert.equal(res.json.merges.length, 2);
  const again = p.judge(rules.slice(1));
  assert.equal(byPr(again)[5].state, "passed");
  assert.doesNotMatch(again.log.split("\n").slice(3).join("\n"), /pr view 5/, "a judged merge is not fetched again");
  const text = gate("post-merge.mjs", ["--store", p.store, "--repo-dir", p.root], { env: { FAKE_GH_SCENARIO: path.join(p.base, "gh-1.json") } });
  assert.match(text.out, /PASS #5: passed \(2 checks passed\), recorded earlier/);
  assert.match(text.out, /gate post-merge: approved/);
});

test("no checks: wait 10 minutes, then no_checks; past 6h: expired", () => {
  const p = program([
    { id: "U1", pr: 5 },
    { id: "U2", pr: 6 },
    { id: "U3", pr: 8 },
  ]);
  const res = p.judge([
    { match: "^pr view 5 ", responses: [merged(2)] },
    { match: "^pr view 6 ", responses: [merged(11)] },
    { match: "^pr view 8 ", responses: [merged(7 * 60)] },
    { match: "^api repos/o/r/commits/", responses: [{ json: [] }] },
  ]);
  assert.equal(res.code, 1);
  const m = byPr(res);
  assert.equal(m[5].state, "waiting");
  assert.equal(m[6].state, "no_checks");
  assert.equal(m[8].state, "expired");
  assert.equal(res.json.pending, 1);
});

test("a running check waits; --wait polls until it finishes", () => {
  const p = program();
  const rules = [
    { match: "^pr view 5 ", responses: [merged()] },
    {
      match: "^api repos/o/r/commits/",
      responses: [
        { json: [check({ name: "ci", id: 1, status: "in_progress", conclusion: null })] },
        { json: [check({ name: "ci", id: 1, status: "in_progress", conclusion: null })] },
        { json: [check({ name: "ci", id: 1 })] },
      ],
    },
  ];
  const once = p.judge(rules);
  assert.equal(byPr(once)[5].state, "waiting");
  assert.match(byPr(once)[5].detail, /running: ci/);
  const waited = p.judge(rules, ["--wait"], { CSTACK_POST_MERGE_POLL_MS: "10" });
  assert.equal(waited.code, 0, waited.out + waited.err);
  assert.equal(byPr(waited)[5].state, "passed");
});

test("a red merge is re-run once, then filed exactly once with log tails", () => {
  const p = program();
  const failedCi = (id) => check({ name: "ci", id, conclusion: "failure", details_url: job(77, 40 + id) });
  const ext = check({ name: "ext", id: 9, conclusion: "timed_out", output: { summary: "took too long", text: "```boom```" } });
  const rules = [
    { match: "^pr view 5 ", responses: [merged()] },
    { match: "^api repos/o/r/commits/", responses: [{ json: [failedCi(1), ext] }, { json: [failedCi(1), ext] }, { json: [failedCi(2), ext] }] },
    { match: "^run rerun 77 --failed --repo o/r$", responses: [{}] },
    { match: "^api --allow-escape-sequences repos/o/r/actions/jobs/42/logs", responses: [{ stdout: "step 1\nnot ok 1 - broken\n" }] },
    { match: "^issue view 3 ", responses: [{ json: { title: "Add subtract" } }] },
    { match: "^issue create ", responses: [{ stdout: "https://github.com/o/r/issues/9\n" }] },
  ];
  const r1 = p.judge(rules);
  assert.equal(byPr(r1)[5].state, "rerun");
  assert.equal(byPr(r1)[5].detail, "ids=1;not_rerun=");
  assert.equal(r1.code, 0, "a re-run is not red yet");
  const r2 = p.judge(rules.slice(0, 1).concat([{ match: "^api repos/o/r/commits/", responses: [{ json: [failedCi(1), ext] }] }]));
  assert.equal(byPr(r2)[5].state, "waiting", "the re-run has not replaced the failed check yet");
  const r3 = p.judge([rules[0], { match: "^api repos/o/r/commits/", responses: [{ json: [failedCi(2), ext] }] }, ...rules.slice(3)]);
  assert.equal(r3.code, 1);
  assert.equal(byPr(r3)[5].state, "filed");
  assert.equal(byPr(r3)[5].detail, "#9");
  const create = r3.log.split("\n").find((l) => l.startsWith("issue create"));
  assert.ok(create.includes("--title CI failed on main after #5: ci, ext"), create);
  assert.ok(create.endsWith("--label cstack:ready"), create);
  const body = readFileSync(path.join(p.store, `post-merge-${SHA.slice(0, 12)}.md`), "utf8");
  assert.match(body, /cstack merged #5 \(for #3\) as `c+`\. Afterwards these checks failed on `main` at that commit, and again when re-run: `ci`\. These checks failed and were not re-run: `ext`\./);
  assert.match(body, /not ok 1 - broken/);
  assert.match(body, /'''boom'''/);
  assert.match(body, /Made with \[cstack\]/);
  assert.deepEqual(p.rows().map((r) => r[4]), ["rerun", "filing", "filed"], "filing is recorded before the issue exists");
  const r4 = p.judge([]);
  assert.equal(r4.code, 1);
  assert.equal(r4.log.split("\n").filter((l) => l.startsWith("issue create")).length, 1, "never filed twice");
  assert.match(gate("post-merge.mjs", ["--store", p.store], { env: { FAKE_GH_SCENARIO: path.join(p.base, "gh-0.json") } }).out, /FAIL #5: filed \(#9\), recorded earlier/);
});

test("a failed re-run request files at once; a failed create is retried without re-running CI", () => {
  const p = program([{ id: "U1", pr: 5 }]);
  const failing = { match: "^api repos/o/r/commits/", responses: [{ json: [check({ name: "ci", id: 1, conclusion: "failure", details_url: job(77, 42) })] }] };
  const res = p.judge([
    { match: "^pr view 5 ", responses: [merged()] },
    failing,
    { match: "^run rerun", responses: [{ code: 1, stderr: "HTTP 403" }] },
    { match: "^api --allow-escape-sequences", responses: [{ code: 1, stderr: "HTTP 410" }] },
    { match: "^issue create ", responses: [{ code: 1, stderr: "HTTP 502" }, { stdout: "https://github.com/o/r/issues/12\n" }] },
  ]);
  assert.equal(byPr(res)[5].state, "file-error");
  assert.match(res.out, /HTTP 502/);
  assert.doesNotMatch(res.log, /issue view/, "a unit with no issue is never a follow-up");
  const body = readFileSync(path.join(p.store, `post-merge-${SHA.slice(0, 12)}.md`), "utf8");
  assert.match(body, /^cstack merged #5 as `c+`\. Afterwards these checks failed on `main` at that commit: `ci`\./);
  assert.match(body, /job log unavailable: HTTP 410/);
  const retry = p.judge([
    { match: "^pr view 5 ", responses: [merged()] },
    failing,
    { match: "^run rerun", responses: [{}] },
    { match: "^api --allow-escape-sequences", responses: [{ stdout: "log" }] },
    { match: "^issue create ", responses: [{ stdout: "https://github.com/o/r/issues/12\n" }] },
  ]);
  assert.equal(byPr(retry)[5].state, "rerun", "no earlier re-run row: the retry may re-run CI first");
  const p2 = program([{ id: "U1", pr: 5 }]);
  const red = (id) => [
    { match: "^pr view 5 ", responses: [merged()] },
    { match: "^api repos/o/r/commits/", responses: [{ json: [check({ name: "ci", id, conclusion: "failure", details_url: job(77, 40 + id) })] }] },
    { match: "^run rerun", responses: [{}] },
    { match: "^api --allow-escape-sequences", responses: [{ stdout: "log" }] },
  ];
  assert.equal(byPr(p2.judge(red(1)))[5].state, "rerun");
  const failedOnce = p2.judge([...red(2), { match: "^issue create ", responses: [{ code: 1, stderr: "HTTP 502" }] }]);
  assert.equal(byPr(failedOnce)[5].state, "file-error");
  const filed = p2.judge([...red(2), { match: "^issue create ", responses: [{ stdout: "https://github.com/o/r/issues/13\n" }] }]);
  assert.equal(byPr(filed)[5].state, "filed");
  assert.match(readFileSync(path.join(p2.store, `post-merge-${SHA.slice(0, 12)}.md`), "utf8"), /Afterwards these checks failed on `main` at that commit, and again when re-run: `ci`\.\n/);
  assert.equal(filed.log.split("\n").filter((l) => l.startsWith("run rerun")).length, 1, "CI was re-run once in all");
});

test("a follow-up whose own merge fails goes to a human", () => {
  const p = program([
    { id: "U1", pr: 5, issue: 9 },
    { id: "U2", pr: 6, issue: 4 },
  ]);
  writeFileSync(path.join(p.store, "post-merge.tsv"), `ts\tunit\tpr\tmerge_sha\tstate\tdetail\n${ago(60)}\tU0\t2\t${"d".repeat(40)}\tfiled\t#9\n`);
  const red = { json: [check({ name: "ci", id: 1, conclusion: "failure", details_url: "https://ci.example/1" })] };
  const res = p.judge([
    { match: "^pr view [56] ", responses: [merged()] },
    { match: "^api repos/o/r/commits/", responses: [red] },
    { match: "^issue view 4 ", responses: [{ json: { title: "CI failed on main after #2: ci" } }] },
    { match: "^issue create ", responses: [{ stdout: "https://github.com/o/r/issues/20\n" }, { stdout: "https://github.com/o/r/issues/21\n" }] },
  ]);
  assert.equal(res.code, 1);
  const creates = res.log.split("\n").filter((l) => l.startsWith("issue create"));
  assert.equal(creates.length, 2);
  assert.ok(creates.every((l) => l.endsWith("--label cstack:needs-human")), creates.join("\n"));
  assert.match(readFileSync(path.join(p.store, `post-merge-${SHA.slice(0, 12)}.md`), "utf8"), /#4 was itself filed for a post-merge CI failure/);
  assert.match(res.json.findings.map((f) => f.detail).join("\n"), /labelled cstack:needs-human/);
});

test("an unreadable issue is not a follow-up; checks without ids pick the newest start", () => {
  const p = program([{ id: "U1", pr: 5, issue: 4 }]);
  const res = p.judge([
    { match: "^pr view 5 ", responses: [merged()] },
    {
      match: "^api repos/o/r/commits/",
      responses: [
        {
          json: [
            check({ name: "lint", id: 5, started_at: "2026-10-27T08:00:00Z" }),
            { name: "lint", status: "completed", conclusion: "failure", started_at: null },
            check({ name: "lint", started_at: "2026-10-27T10:00:00Z" }),
            check({ name: "lint", id: 6, started_at: "2026-10-27T07:00:00Z" }),
            check({ name: "ci", started_at: "2026-10-27T09:00:00Z" }),
          ],
        },
      ],
    },
    { match: "^issue view 4 ", responses: [{ code: 1, stderr: "not found" }] },
    { match: "^issue create ", responses: [{ stdout: "https://github.com/o/r/issues/30\n" }] },
  ]);
  assert.equal(byPr(res)[5].state, "filed");
  assert.ok(res.log.includes("--title CI failed on main after #5: lint --body-file"), res.log);
  assert.ok(res.log.includes("--label cstack:ready"));
  assert.match(readFileSync(path.join(p.store, `post-merge-${SHA.slice(0, 12)}.md`), "utf8"), /\(no output\)/);
});

test("an interrupted filing is reported for a human and never filed again", () => {
  const p = program();
  writeFileSync(path.join(p.store, "post-merge.tsv"), `ts\tunit\tpr\tmerge_sha\tstate\tdetail\n${ago(5)}\tU1\t5\t${SHA}\tfiling\tCI failed on main after #5: ci\n`);
  const res = p.judge([]);
  assert.equal(res.code, 1);
  assert.equal(res.log, "", "no GitHub calls");
  assert.match(res.json.findings[0].detail, /interrupted while filing; look for that issue before filing by hand/);
});
