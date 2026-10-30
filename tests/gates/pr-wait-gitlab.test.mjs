// Tests for gates/pr-wait.mjs on GitLab (gates/lib/change-watch.mjs). Uses the scenario-driven fake glab, with the
// response shapes measured in ADR-013.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../gates/pr-wait.mjs");
const BIN = path.resolve(here, "../fixtures/bin");
const ROOT = mkdtempSync(path.join(tmpdir(), "cstack-pr-wait-gl-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const HEAD = "abcdef1" + "0".repeat(33);
const SHORT = HEAD.slice(0, 7);
const URL = "https://gitlab.com/grp/app/-/merge_requests/7";
const LOCK = "gitlab__grp__app__7.lock";
const STATE = "gitlab__grp__app__7.json";

let seq = 0;
function tmp() {
  const d = path.join(ROOT, `t${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const mr = (o = {}) => ({ json: { iid: 7, web_url: URL, state: "opened", draft: false, sha: HEAD, target_branch: "main", diff_refs: { base_sha: "b".repeat(40) }, detailed_merge_status: "mergeable", diverged_commits_count: 0, ...o } });
const job = (id, name, status, o = {}) => ({ id, name, status, web_url: `https://gitlab.com/grp/app/-/jobs/${id}`, allow_failure: false, ...o });
const jobs = (...rows) => ({ json: rows });
const note = (id, username, body, o = {}) => ({ id, body, author: { username, bot: false }, created_at: `2026-10-30T00:00:${String(id).padStart(2, "0")}Z`, system: false, resolvable: true, resolved: false, ...o });
const thread = (id, notes, position) => ({ id, notes: notes.map((n, i) => (i === 0 && position ? { ...n, position } : n)) });
const discussions = (...rows) => ({ json: rows });
const BUILD_OK = jobs(job(1, "build", "success"));

// A scenario for MR !7 of grp/app. Rules match in order; each walks its responses across calls. The probe before
// the first poll reads the MR once more, so mrs[0] answers it too unless `raw`.
function scenario({ raw = false, mrs = [mr()], jobs: jobResponses = [BUILD_OK], threads = [discussions()], pipelines = [{ json: [{ id: 1 }] }], base = [{ json: [] }], baseJobs = [jobs()], view = [mr()], user = [{ json: { username: "me" } }] } = {}) {
  return {
    rules: [
      { match: "merge_requests/7\\?include_diverged_commits_count=true$", responses: raw ? mrs : [mrs[0], ...mrs] },
      { match: "pipelines\\?sha=", responses: pipelines },
      { match: "pipelines/1/jobs", responses: jobResponses },
      { match: "pipelines\\?ref=main", responses: base },
      { match: "pipelines/2/jobs", responses: baseJobs },
      { match: "-X GET user$", responses: user },
      { match: "merge_requests/7/discussions", responses: threads },
      { match: "merge_requests/7/approvals", responses: [{ json: { approved_by: [] } }] },
      { match: "merge_requests/7$", responses: view },
    ],
  };
}

// Runs pr-wait in `dir`, which holds a .cstack/config.json for a GitLab repo unless config is null.
function watch(dir, scen, args, { config = {}, env = {}, name = "scenario", onStderr } = {}) {
  const file = path.join(dir, `${name}.json`);
  const log = path.join(dir, `${name}.log`);
  writeFileSync(file, JSON.stringify(scen));
  const cwd = path.join(dir, `${name}-cwd`);
  mkdirSync(path.join(cwd, ".cstack"), { recursive: true });
  if (config !== null) writeFileSync(path.join(cwd, ".cstack", "config.json"), JSON.stringify({ forge: "gitlab", repo: "grp/app", ...config }));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--interval", "1", "--state-dir", path.join(dir, "state"), ...args], {
      cwd,
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, CSTACK_FORGE: "", CSTACK_RUN: "", FAKE_GLAB_SCENARIO: file, FAKE_GLAB_LOG: log, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      onStderr?.(stderr, child);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      resolve({ code, lines: stdout.split("\n").filter(Boolean), stdout, stderr, calls });
    });
  });
}

describe("pr-wait on GitLab", { concurrency: true }, () => {
  test("ready: green on a stable head, no threads, commits behind as info", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ mrs: [mr({ diverged_commits_count: 2 })] }), ["7"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 ready on ${SHORT}: 1 pass; 0 unresolved threads; merge state mergeable; 2 commits behind main`]);
    assert.match(r.stderr, /watching grp\/app#7 on GitLab until ready; required checks: none set/);
    assert.ok(!existsSync(path.join(d, "state", LOCK)), "lock removed on exit");
    assert.ok(r.calls.every((c) => !c.includes("/approvals")), "reviews are read only with review_bots");
  });

  test("green from CSTACK_FORGE and a URL; required checks from the base pipeline", async () => {
    const d = tmp();
    const scen = scenario({
      mrs: [mr({ diverged_commits_count: 1 })],
      jobs: [jobs(job(1, "build", "success"), job(2, "docs", "failed"), job(3, "lint", "running"))],
      base: [{ json: [{ id: 2 }] }],
      baseJobs: [jobs(job(9, "build", "success"), job(10, "lint", "success", { allow_failure: true }))],
    });
    const r = await watch(d, scen, [URL, "--until", "green"], { config: null, env: { CSTACK_FORGE: "gitlab" } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 green on ${SHORT}: 1 fail, 1 pass, 1 pending (docs); required 1/1 green; 0 unresolved threads; merge state mergeable; 1 commit behind main`]);
    assert.match(r.stderr, /required checks: build$/m);
  });

  test("required checks from config stay pending until they appear", async () => {
    const d = tmp();
    const both = jobs(job(1, "build", "success"), job(2, "e2e", "success"));
    const scen = scenario({ jobs: [BUILD_OK, BUILD_OK, both] });
    const r = await watch(d, scen, ["!7", "--until", "green"], { config: { required_checks: ["e2e", "build", ""] } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /required checks: build, e2e \(from \.cstack\/config\.json\)/);
    assert.equal(r.lines[0], `#7 green on ${SHORT}: 2 pass; required 2/2 green; 0 unresolved threads; merge state mergeable`);
    assert.ok(r.calls.every((c) => !c.includes("pipelines?ref")), "config wins over the forge");
  });

  test("config for another repo is ignored", async () => {
    const d = tmp();
    const r = await watch(d, scenario(), ["#7", "--repo", "grp/app", "--until", "green"], { config: { repo: "other/x", required_checks: ["e2e"] } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /required checks: none set/);
  });

  test("a required check failed exits 1", async () => {
    const d = tmp();
    const scen = scenario({ jobs: [jobs(job(1, "build", "failed"), job(2, "docs", "failed"))] });
    const r = await watch(d, scen, ["7"], { config: { required_checks: ["build"] } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 required check failed: build https://gitlab.com/grp/app/-/jobs/1"]);
  });

  test("a failed check that is not required is an event, not an exit", async () => {
    const d = tmp();
    const scen = scenario({ jobs: [jobs(job(1, "build", "success"), job(2, "docs", "running")), jobs(job(1, "build", "success"), job(2, "docs", "failed"))] });
    const r = await watch(d, scen, ["7", "--until", "any-change"], { config: { required_checks: ["build"] } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, ["#7 check failed (not required): docs https://gitlab.com/grp/app/-/jobs/2"]);
  });

  test("checks finished is reported once, on a stable set", async () => {
    const d = tmp();
    const scen = scenario({ jobs: [jobs(job(1, "build", "running")), BUILD_OK] });
    const r = await watch(d, scen, ["7", "--until", "any-change"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 checks finished on ${SHORT}: 1 pass; 0 unresolved threads; merge state mergeable`]);
  });

  test("conflict exits 1, even with no pipeline; in any-change it is an event", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ mrs: [mr({ detailed_merge_status: "conflict" })], pipelines: [{ json: [] }] }), ["7"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 merge state is conflict: the branch conflicts with main, rebase it"]);

    const any = await watch(tmp(), scenario({ mrs: [mr(), mr({ detailed_merge_status: "conflict" })], jobs: [jobs(job(1, "build", "running"))] }), ["7", "--until", "any-change"]);
    assert.equal(any.code, 0, any.stderr);
    assert.deepEqual(any.lines, ["#7 merge state is conflict: the branch conflicts with main, rebase it"]);
  });

  test("a conflict that appears mid-watch is printed once", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ mrs: [mr(), mr({ detailed_merge_status: "conflict" })], jobs: [jobs(job(1, "build", "running"))] }), ["7"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 merge state is conflict: the branch conflicts with main, rebase it"]);
  });

  test("merged exits 0; closed exits 1", async () => {
    const d = tmp();
    const merged = await watch(d, scenario({ mrs: [mr({ state: "merged" })] }), ["7"], { name: "merged" });
    assert.equal(merged.code, 0, merged.stderr);
    assert.deepEqual(merged.lines, [`#7 merged: ${URL}`]);
    const closed = await watch(d, scenario({ mrs: [mr({ state: "closed" })] }), ["7"], { name: "closed" });
    assert.equal(closed.code, 1);
    assert.deepEqual(closed.lines, [`#7 closed without merging: ${URL}`]);
  });

  test("an unresolved thread blocks ready; a resolved one does not", async () => {
    const d = tmp();
    const threads = [discussions(thread("d1", [note(1, "dave", "nit")], { new_path: "src/a.js", new_line: 3 }), thread("d2", [note(2, "erin", "ok", { resolved: true })]))];
    const r = await watch(d, scenario({ threads }), ["7"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, [`#7 blocked by 1 unresolved thread on ${SHORT}: ${URL}#note_1`]);
  });

  test("a forge merge state of behind blocks ready", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ mrs: [mr({ detailed_merge_status: "need_rebase" })] }), ["7"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 merge state is behind: update the branch from main before merging"]);
  });

  test("events: threads and replies from others, behind; my notes and edits skipped", async () => {
    const d = tmp();
    const dave = note(1, "dave", "why?");
    const t1 = (...more) => thread("d1", [dave, ...more], { new_path: "src/a.js", new_line: 9 });
    const poll2 = discussions(
      t1(note(2, "me", "because"), note(3, "erin", "x".repeat(150))),
      thread("d2", [note(4, "frank", "general  point\nhere")]),
      thread("d3", [note(5, "gina", "typo", { resolved: true })], { new_path: "README.md", new_line: null }),
      thread("d4", [note(6, "me", "self")]),
    );
    const edited = discussions(thread("d1", [{ ...dave, body: "why, edited?" }], { new_path: "src/a.js", new_line: 9 }));
    const scen = scenario({
      mrs: [mr(), mr({ detailed_merge_status: "need_rebase", diverged_commits_count: 3 }), mr({ state: "merged" })],
      jobs: [jobs(job(1, "build", "running"))],
      threads: [discussions(t1()), poll2, edited],
    });
    const r = await watch(d, scen, ["7"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [
      `#7 thread reply from erin on src/a.js:9: ${"x".repeat(97)}... ${URL}#note_3`,
      `#7 new thread from frank: general point here ${URL}#note_4`,
      `#7 new thread from gina on README.md: typo ${URL}#note_5`,
      "#7 merge state is behind: update the branch from main before merging",
      `#7 merged: ${URL}`,
    ]);
  });

  test("threads without URLs fall back to their ids", async () => {
    const d = tmp();
    const view = [{ json: { iid: 7 } }];
    const scen = scenario({ view, jobs: [jobs(job(1, "build", "running"))], threads: [discussions(), discussions(thread("d9", [note(1, "dave", "hm")]))] });
    const r = await watch(d, scen, ["7", "--until", "any-change"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, ["#7 new thread from dave: hm"]);
    const blocked = await watch(tmp(), scenario({ view, threads: [discussions(thread("d9", [note(1, "dave", "hm")]))] }), ["7"]);
    assert.equal(blocked.code, 1);
    assert.deepEqual(blocked.lines, [`#7 blocked by 1 unresolved thread on ${SHORT}: d9`]);
  });

  test("review bots gate ready only when config lists them", async () => {
    const d = tmp();
    const greptile = (status) => job(5, "Greptile Review", status);
    const bot = { json: { iid: 7, web_url: URL } };
    const summary = (body) => discussions({ id: "s1", notes: [note(7, "macroscope-bot", body, { resolvable: false })] });
    const scen = scenario({
      jobs: [jobs(job(1, "build", "success"), greptile("running")), jobs(job(1, "build", "success"), greptile("success"))],
      // threads() and reviews() both read the discussions, so each poll takes two responses.
      threads: [summary("Looking at an older commit"), summary("Looking at an older commit"), summary(`Reviewed ${SHORT}`)],
      view: [bot],
    });
    const r = await watch(d, scen, ["7"], { config: { review_bots: ["Greptile", "macroscope", 3] } });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [
      `#7 greptile finished on ${SHORT}`,
      `#7 macroscope finished on ${SHORT}`,
      `#7 ready on ${SHORT}: 2 pass; greptile done, macroscope done; 0 unresolved threads; merge state mergeable`,
    ]);
    assert.ok(r.calls.some((c) => c.includes("/approvals")), "reviews read for the bots");
  });

  test("baseline is silent; a restart reports only what arrived while stopped", async () => {
    const d = tmp();
    const a = thread("a", [note(1, "alice", "first")]);
    const b = thread("b", [note(2, "bob", "second")]);
    const c = thread("c", [note(3, "carol", "third")]);
    const pending = [jobs(job(1, "build", "running"))];
    const first = await watch(d, scenario({ jobs: pending, threads: [discussions(a), discussions(a, b)] }), ["7", "--until", "any-change"], { name: "one" });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.lines, [`#7 new thread from bob: second ${URL}#note_2`]);
    assert.match(first.stderr, /baseline recorded for grp\/app#7/);
    assert.deepEqual(JSON.parse(readFileSync(path.join(d, "state", STATE), "utf8")).reported.filter((k) => k.startsWith("c:")), [`c:${URL}#note_1`, `c:${URL}#note_2`]);

    const second = await watch(d, scenario({ jobs: pending, threads: [discussions(a, b, c)] }), ["7", "--until", "any-change"], { name: "two" });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.lines, [`#7 new thread from carol: third ${URL}#note_3`]);
    assert.doesNotMatch(second.stderr, /baseline recorded/);
  });

  test("old or unreadable state is discarded and a fresh baseline taken", async () => {
    for (const [i, text] of ["{\"reported\":[]}", "{}"].entries()) {
      const d = tmp();
      mkdirSync(path.join(d, "state"));
      const file = path.join(d, "state", STATE);
      writeFileSync(file, text);
      const old = Date.now() / 1000 - 7 * 3600;
      if (i === 0) utimesSync(file, old, old);
      const scen = scenario({ mrs: [mr(), mr({ state: "merged" })], jobs: [jobs(job(1, "build", "running"))], threads: [discussions(thread("a", [note(1, "alice", "old news")]))] });
      const r = await watch(d, scen, ["7", "--until", "any-change"]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
      assert.match(r.stderr, /baseline recorded/);
    }
  });

  test("a duplicate watcher exits 2; a stale lock is replaced", async () => {
    const d = tmp();
    mkdirSync(path.join(d, "state"));
    const lock = path.join(d, "state", LOCK);
    writeFileSync(lock, String(process.pid));
    const dup = await watch(d, scenario({ mrs: [mr({ state: "merged" })] }), ["7"], { name: "dup" });
    assert.equal(dup.code, 2);
    assert.match(dup.stdout, new RegExp(`pid ${process.pid} already watches`));
    writeFileSync(lock, "999999999");
    const stale = await watch(d, scenario({ mrs: [mr({ state: "merged" })] }), ["7"], { name: "stale" });
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(stale.stderr, /replacing stale lock/);
    assert.ok(!existsSync(lock));
  });

  test("--store registers a watcher mark while it runs and removes it on exit", async () => {
    const d = tmp();
    const store = path.join(d, "store");
    mkdirSync(store, { recursive: true });
    let during = null;
    const scen = scenario({ mrs: [mr(), mr({ state: "merged" })], jobs: [jobs(job(1, "build", "running"))] });
    const r = await watch(d, scen, ["7", "--store", store], {
      onStderr: () => {
        if (during === null && existsSync(path.join(store, "watchers"))) during = readdirSync(path.join(store, "watchers"));
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(during?.length, 1, "a mark exists while watching");
    assert.deepEqual(readdirSync(path.join(store, "watchers")), [], "the mark is gone after exit");
  });

  test("--timeout exits 3 while checks stay pending", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ jobs: [jobs(job(1, "build", "running"))] }), ["7", "--until", "green", "--timeout", "1"]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.lines.at(-1), "#7 timeout: 1s");
    assert.ok(!existsSync(path.join(d, "state", LOCK)));
  });

  test("transient errors retry with backoff; an unreadable response fails one poll", async () => {
    const d = tmp();
    const scen = scenario({ raw: true, mrs: [{ stderr: "glab: 502 Bad Gateway (HTTP 502)\n", code: 1 }, mr(), { stdout: "<html>oops" }, mr({ state: "merged" })] });
    const r = await watch(d, scen, ["7"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
    assert.match(r.stderr, /GitLab: glab api GET projects\/grp%2Fapp\/merge_requests\/7\?include_diverged_commits_count=true failed: glab: 502 Bad Gateway \(HTTP 502\); retry in 0.1s/);
    assert.match(r.stderr, /poll failed \(1\/10\): unreadable response from GitLab/);
  });

  test("GitLab unreachable for 10 polls exits 1", async () => {
    const d = tmp();
    // The probe exhausts five retries and is left to the poll loop; every poll then reads garbage.
    const bad = { stderr: "connection reset by peer\n", code: 1 };
    const r = await watch(d, scenario({ raw: true, mrs: [bad, bad, bad, bad, bad, { stdout: "<html>502</html>" }] }), ["7"]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 pr-wait stopped: GitLab unreachable for 10 polls: unreadable response from GitLab"]);
    assert.equal(r.calls.filter((c) => c.includes("include_diverged")).length, 15);
  });

  test("a non-transient forge error mid-watch exits 1", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ pipelines: [{ stderr: "glab: 403 Forbidden\n", code: 1 }] }), ["7"]);
    assert.equal(r.code, 1);
    assert.match(r.lines.join("\n"), /^#7 pr-wait stopped: glab api GET projects\/grp%2Fapp\/pipelines\?sha=abcdef1\S* failed: glab: 403 Forbidden$/);
  });

  test("bad input exits 2", async () => {
    const d = tmp();
    const missing = scenario({ mrs: [{ stderr: "glab: 404 Not Found\n", code: 1 }] });
    const cases = [
      [[], {}, /missing change number/],
      [["abc"], {}, /'abc' is not a change number or merge request URL/],
      [["0"], {}, /'0' is not a valid change number/],
      [["7", "--repo", "nope"], {}, /'nope' is not group\/project/],
      [["7"], { config: null, env: { CSTACK_FORGE: "gitlab" } }, /no --repo given and no repo/],
      [["7"], { env: { CSTACK_FORGE: "local" } }, /forge 'local' is not implemented yet/],
      [["7"], { env: { CSTACK_FORGE: "bogus" } }, /unknown forge 'bogus'/],
      [["7"], {}, /cannot read grp\/app#7: glab api GET \S+ failed: glab: 404 Not Found/],
    ];
    const results = await Promise.all(cases.map(([args, opts], i) => watch(d, missing, args, { ...opts, name: `bad${i}` })));
    results.forEach((r, i) => {
      assert.equal(r.code, 2, `case ${i}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, cases[i][2]);
    });
  });
});
