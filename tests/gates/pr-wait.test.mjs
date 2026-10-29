// Tests for gates/pr-wait.mjs. Run with `node --test`. Uses the scenario-driven fake gh.
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
const ROOT = mkdtempSync(path.join(tmpdir(), "cstack-pr-wait-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const REPO = "acme/widgets";
const HEAD = "abcdef1" + "0".repeat(33);
const SHORT = HEAD.slice(0, 7);
const BASE1 = "1111111" + "0".repeat(33);
const BASE2 = "2222222" + "0".repeat(33);
const URL = `https://github.com/${REPO}/pull/7`;
const NOT_FOUND = { stderr: "gh: Not Found (HTTP 404)\n", code: 1 };

let seq = 0;
function tmp() {
  const d = path.join(ROOT, `t${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const user = (login, id, body, extra = {}) => ({ id, url: `${URL}#${id}`, body, author: { login, __typename: "User" }, ...extra });
const bot = (login, id, body, extra = {}) => ({ id, url: `${URL}#${id}`, body, author: { login, __typename: "Bot" }, ...extra });

function pr(o = {}) {
  return {
    json: {
      data: {
        viewer: { login: "me" },
        repository: {
          pullRequest: {
            url: URL,
            state: o.state ?? "OPEN",
            headRefOid: o.head ?? HEAD,
            baseRefName: "main",
            mergeStateStatus: o.merge ?? "CLEAN",
            author: { login: "me" },
            baseRef: o.base === null ? null : { target: { oid: o.base ?? BASE1 } },
            comments: { nodes: o.comments ?? [] },
            reviews: { nodes: o.reviews ?? [] },
            reviewThreads: { nodes: o.threads ?? [] },
          },
        },
      },
    },
  };
}

const check = (name, bucket, extra = {}) => ({ name, bucket, link: `https://ci/${name}`, description: "", ...extra });
const checks = (...rows) => ({ json: rows, code: rows.some((r) => r.bucket === "pending") ? 8 : rows.some((r) => r.bucket === "fail") ? 1 : 0 });
const greptileDone = bot("greptile-apps", "G1", `Reviewed ${SHORT}. Confidence score: 4/5`);

// Builds a scenario. Rules match in order; graphql and checks walk their response lists.
function scenario({ graphql, checks: checkResponses = [checks(check("build", "pass"))], rules = [NOT_FOUND], protection = [NOT_FOUND], view = [{ json: { number: 7 } }], extra = [] }) {
  return {
    rules: [
      { match: "^api graphql", responses: graphql },
      { match: "^pr view", responses: view },
      { match: "rules/branches/", responses: rules },
      { match: "protection/required_status_checks", responses: protection },
      { match: "^pr checks", responses: checkResponses },
      { match: "behind_by", responses: [{ stdout: "1\n" }] },
      ...extra,
    ],
  };
}

function watch(dir, scen, args, { cwd = dir, env = {}, name = "scenario", onStderr } = {}) {
  const file = path.join(dir, `${name}.json`);
  const log = path.join(dir, `${name}.log`);
  writeFileSync(file, JSON.stringify(scen));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--interval", "1", "--state-dir", path.join(dir, "state"), ...args], {
      cwd,
      env: { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_SCENARIO: file, FAKE_GH_LOG: log, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      onStderr?.(stderr, child);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
      resolve({ code, lines: stdout.split("\n").filter(Boolean), stdout, stderr, calls });
    });
  });
}

describe("pr-wait", { concurrency: true }, () => {
  test("ready reached: green checks, gating bot on head, no threads", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ graphql: [pr({ comments: [greptileDone] })] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.lines.length, 1, r.stdout);
    assert.equal(r.lines[0], `#7 ready on ${SHORT}: 1 pass; greptile done; 0 unresolved threads; merge state CLEAN; 1 commit behind main`);
    assert.match(r.stderr, /required checks: none set/);
    assert.ok(!existsSync(path.join(d, "state", "acme__widgets__7.lock")), "lock removed on exit");
  });

  test("green from a PR URL with an advisory bot check", async () => {
    const d = tmp();
    const scen = scenario({
      graphql: [pr()],
      checks: [checks(check("build", "pass"), check("CodeRabbit", "pass", { description: "Review completed" }))],
    });
    const r = await watch(d, scen, [URL, "--until", "green"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.lines[0], /^#7 green on abcdef1: 1 pass; coderabbit Review completed \(advisory\); 0 unresolved threads/);
  });

  test("failing check exits 1 with one event line; duplicate names collapse to the worst", async () => {
    const d = tmp();
    const scen = scenario({ graphql: [pr()], checks: [checks(check("build", "pass"), check("build", "fail"), check("lint", "pass"))] });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 check failed: build https://ci/build"]);
  });

  test("DIRTY exits 1, even with no checks reported", async () => {
    const d = tmp();
    const scen = scenario({ graphql: [pr({ merge: "DIRTY" })], checks: [{ stderr: "no checks reported on the 'x' branch\n", code: 1 }] });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 merge state is DIRTY: the branch conflicts with main, rebase it"]);
  });

  test("BEHIND blocks ready", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ graphql: [pr({ merge: "BEHIND", comments: [greptileDone] })] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 merge state is BEHIND: update the branch from main before merging"]);
  });

  test("unresolved thread blocks ready", async () => {
    const d = tmp();
    const thread = { isResolved: false, path: "src/a.js", line: 3, comments: { nodes: [user("dave", "T1", "nit")] } };
    const r = await watch(d, scenario({ graphql: [pr({ comments: [greptileDone], threads: [thread] })] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, [`#7 blocked by 1 unresolved thread on ${SHORT}: ${URL}#T1`]);
  });

  test("merged PR exits 0", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ graphql: [pr({ state: "MERGED" })] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
  });

  test("--store registers a watcher mark while it runs and removes it on exit", async () => {
    const d = tmp();
    const store = path.join(d, "store");
    mkdirSync(store, { recursive: true });
    let during = null;
    const r = await watch(d, scenario({ graphql: [pr(), pr({ state: "MERGED" })], checks: [checks(check("build", "pending"))] }), ["7", "--repo", REPO, "--store", store], {
      onStderr: () => {
        if (during === null && existsSync(path.join(store, "watchers"))) during = readdirSync(path.join(store, "watchers"));
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(during?.length, 1, "a mark exists while watching");
    assert.match(readdirSync(path.join(store, "watchers")).join(""), /^$/, "the mark is gone after exit");
  });

  test("without --store, CSTACK_RUN under a configured repo names the store; otherwise nothing registers", async () => {
    const d = tmp();
    const repo = path.join(d, "repo");
    const store = path.join(repo, ".cstack", "runs", "r1");
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(repo, ".cstack", "config.json"), JSON.stringify({ repo: REPO, required_checks: [] }));
    let seen = false;
    const r1 = await watch(d, scenario({ graphql: [pr(), pr({ state: "MERGED" })], checks: [checks(check("build", "pending"))] }), ["7", "--repo", REPO], {
      cwd: repo,
      env: { CSTACK_RUN: "r1" },
      name: "env",
      onStderr: () => {
        if (existsSync(path.join(store, "watchers")) && readdirSync(path.join(store, "watchers")).length) seen = true;
      },
    });
    assert.equal(r1.code, 0, r1.stderr);
    assert.ok(seen, "registered under the CSTACK_RUN store");
    const r2 = await watch(d, scenario({ graphql: [pr({ state: "MERGED" })] }), ["7", "--repo", REPO], { cwd: repo, env: { CSTACK_RUN: "missing" }, name: "missing" });
    assert.equal(r2.code, 0, r2.stderr);
    assert.ok(!existsSync(path.join(repo, ".cstack", "runs", "missing")), "no store is created");
    const r3 = await watch(d, scenario({ graphql: [pr({ state: "MERGED" })] }), ["7", "--repo", REPO], { cwd: d, env: { CSTACK_RUN: "r1" }, name: "noconfig" });
    assert.equal(r3.code, 0, r3.stderr);
  });

  test("closed PR exits 1", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ graphql: [pr({ state: "CLOSED" })] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, [`#7 closed without merging: ${URL}`]);
  });

  test("duplicate watcher exits 2; a stale lock is replaced", async () => {
    const d = tmp();
    mkdirSync(path.join(d, "state"));
    const lock = path.join(d, "state", "acme__widgets__7.lock");
    writeFileSync(lock, String(process.pid));
    const dup = await watch(d, scenario({ graphql: [pr({ state: "MERGED" })] }), ["7", "--repo", REPO], { name: "dup" });
    assert.equal(dup.code, 2);
    assert.match(dup.stdout, new RegExp(`pid ${process.pid} already watches`));
    assert.equal(readFileSync(lock, "utf8"), String(process.pid), "live lock left alone");

    writeFileSync(lock, "999999999");
    const stale = await watch(d, scenario({ graphql: [pr({ state: "MERGED" })] }), ["7", "--repo", REPO], { name: "stale" });
    assert.equal(stale.code, 0, stale.stderr);
    assert.match(stale.stderr, /replacing stale lock/);
    assert.ok(!existsSync(lock));
  });

  test("a watcher that loses its lock exits 2; SIGTERM exits and frees the lock", async () => {
    const d = tmp();
    const lock = path.join(d, "state", "acme__widgets__7.lock");
    const pending = scenario({ graphql: [pr()], checks: [checks(check("build", "pending"))] });
    let done = false;
    const taken = await watch(d, pending, ["7", "--repo", REPO], {
      name: "taken",
      onStderr: (text) => {
        if (!done && /baseline recorded/.test(text)) {
          done = true;
          rmSync(lock);
        }
      },
    });
    assert.equal(taken.code, 2);
    assert.match(taken.stdout, /pid unknown took over the lock/);

    let sent = false;
    const term = await watch(d, pending, ["7", "--repo", REPO], {
      name: "term",
      onStderr: (text, child) => {
        if (!sent && /watching acme\/widgets#7/.test(text)) {
          sent = true;
          child.kill("SIGTERM");
        }
      },
    });
    assert.equal(term.code, 143);
    assert.ok(!existsSync(lock));
  });

  test("green line without a behind count when the compare fails", async () => {
    const d = tmp();
    const scen = scenario({ graphql: [pr()] });
    scen.rules.find((r) => r.match === "behind_by").responses = [{ stderr: "HTTP 404\n", code: 1 }];
    const r = await watch(d, scen, ["7", "--repo", REPO, "--until", "green"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.lines[0], `#7 green on ${SHORT}: 1 pass; no greptile or macroscope review yet; 0 unresolved threads; merge state CLEAN`);
  });

  test("baseline is silent; a restart reports what arrived while stopped", async () => {
    const d = tmp();
    const a = user("alice", "A", "first look");
    const b = user("bob", "B", "second <b>look</b> &amp; more");
    const c = user("carol", "C", "third");
    const pending = checks(check("build", "pending"));
    const first = await watch(d, scenario({ graphql: [pr({ comments: [a] }), pr({ comments: [a, b] })], checks: [pending] }), ["7", "--repo", REPO, "--until", "any-change"], { name: "one" });
    assert.equal(first.code, 0, first.stderr);
    assert.deepEqual(first.lines, [`#7 comment from bob: second look & more ${URL}#B`]);
    assert.match(first.stderr, /baseline recorded/);

    const second = await watch(d, scenario({ graphql: [pr({ comments: [a, b, c] })], checks: [pending] }), ["7", "--repo", REPO, "--until", "any-change"], { name: "two" });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(second.lines, [`#7 comment from carol: third ${URL}#C`]);
    assert.doesNotMatch(second.stderr, /baseline recorded/);
  });

  test("state older than 6 hours is discarded and a fresh baseline taken", async () => {
    const d = tmp();
    mkdirSync(path.join(d, "state"));
    const file = path.join(d, "state", "acme__widgets__7.json");
    writeFileSync(file, JSON.stringify({ reported: [], summaries: {}, base_oid: null, merge_state: null }));
    const old = Date.now() / 1000 - 7 * 3600;
    utimesSync(file, old, old);
    const a = user("alice", "A", "old news");
    const r = await watch(d, scenario({ graphql: [pr({ comments: [a] }), pr({ state: "MERGED" })], checks: [checks(check("build", "pending"))] }), ["7", "--repo", REPO, "--until", "any-change"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
    assert.match(r.stderr, /baseline recorded/);
  });

  test("required checks from .cstack/config.json stay pending until they appear", async () => {
    const d = tmp();
    const repoDir = path.join(d, "checkout");
    mkdirSync(path.join(repoDir, ".cstack"), { recursive: true });
    mkdirSync(path.join(repoDir, "sub"));
    writeFileSync(path.join(repoDir, ".cstack", "config.json"), JSON.stringify({ repo: "Acme/Widgets", required_checks: ["e2e", ""] }));
    const build = check("build", "pass");
    const scen = scenario({
      graphql: [pr()],
      checks: [checks(build), checks(build), checks(build), checks(build, check("e2e", "pass"))],
      rules: [{ stdout: "build\n" }],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO, "--until", "green"], { cwd: path.join(repoDir, "sub") });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /required checks: build, e2e \(1 from \.cstack\/config\.json\)/);
    assert.equal(r.calls.filter((c) => c.startsWith("pr checks")).length >= 4, true);
    assert.match(r.lines[0], /^#7 green on abcdef1: 2 pass; required 2\/2 green/);
  });

  test("config for another repo is ignored; a broken config is reported and ignored", async () => {
    const d = tmp();
    const other = path.join(d, "other");
    mkdirSync(path.join(other, ".cstack"), { recursive: true });
    writeFileSync(path.join(other, ".cstack", "config.json"), JSON.stringify({ repo: "someone/else", required_checks: ["e2e"] }));
    const r1 = await watch(d, scenario({ graphql: [pr()] }), ["7", "--repo", REPO, "--until", "green"], { cwd: other, name: "other" });
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stderr, /required checks: none set/);

    const broken = path.join(d, "broken");
    mkdirSync(path.join(broken, ".cstack"), { recursive: true });
    writeFileSync(path.join(broken, ".cstack", "config.json"), "{nope");
    const r2 = await watch(d, scenario({ graphql: [pr()] }), ["7", "--repo", REPO, "--until", "green"], { cwd: broken, name: "broken" });
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stderr, /does not parse/);
  });

  test("403 on branch protection counts as none; other errors are logged", async () => {
    const d = tmp();
    const scen = scenario({
      graphql: [pr()],
      rules: [{ stderr: "gh: Bad credentials (HTTP 401)\n", code: 1 }],
      protection: [{ stderr: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)\n", code: 1 }],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO, "--until", "green"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /could not read required checks from repos\/acme\/widgets\/rules\/branches\/main: gh: Bad credentials/);
    assert.doesNotMatch(r.stderr, /protection\/required_status_checks:/);
    assert.match(r.stderr, /required checks: none set/);
  });

  test("GitHub unreachable for 10 polls exits 1", async () => {
    const d = tmp();
    // The first poll exhausts gh's five retries; later polls fail fast on a proxy error page.
    const bad = { stderr: "HTTP 502 Bad Gateway\n", code: 1 };
    const r = await watch(d, scenario({ graphql: [bad, bad, bad, bad, bad, { stdout: "<html>502</html>" }] }), ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 pr-wait stopped: GitHub unreachable for 10 polls: unreadable graphql response"]);
    assert.match(r.stderr, /poll failed \(1\/10\): HTTP 502 Bad Gateway/);
    assert.equal(r.calls.filter((c) => c.startsWith("api graphql")).length, 14);
  });

  test("transient errors are retried with backoff; garbage output fails one poll", async () => {
    const d = tmp();
    const scen = scenario({
      graphql: [{ stderr: "HTTP 502\n", code: 1 }, { stdout: "<html>oops" }, pr({ state: "MERGED" })],
      view: [{ stderr: "error connecting: connection reset by peer\n", code: 1 }, { json: { number: 7 } }],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
    assert.match(r.stderr, /gh api graphql: HTTP 502; retry in 0.1s/);
    assert.match(r.stderr, /poll failed \(1\/10\): unreadable graphql response/);
  });

  test("a non-transient gh error mid-watch stops with exit 1", async () => {
    const d = tmp();
    const scen = scenario({ graphql: [pr()], checks: [{ stderr: "gh: something odd\n", code: 1 }] });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 1);
    assert.deepEqual(r.lines, ["#7 pr-wait stopped: gh: something odd"]);
    const missing = await watch(d, scenario({ graphql: [{ json: { data: { viewer: { login: "me" }, repository: null } } }] }), ["7", "--repo", REPO], { name: "missing" });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /not found in the GraphQL response/);
  });

  test("events: comments, reviews, threads, bots, base moves, BEHIND; edits and status bots skipped", async () => {
    const d = tmp();
    const alice = user("alice", "A", "hello");
    const s1 = bot("greptile-apps", "S1", `Reviewed ${SHORT}.\n**Confidence score: 3/5**`);
    const poll1 = pr({ comments: [alice, s1] });
    const thread = {
      isResolved: false,
      path: "src/a.js",
      line: 9,
      comments: { nodes: [user("dave", "T1", "why?"), user("me", "T2", "because"), user("erin", "T3", "x".repeat(150))] },
    };
    const poll2 = pr({
      base: BASE2,
      merge: "BEHIND",
      comments: [
        user("alice", "A", "hello, edited"),
        bot("github-actions", "GA", "deploy preview ready"),
        bot("coderabbitai", "CR", "summary"),
        user("me", "M", "self note"),
        user("bob", "B", "looks fine"),
        bot("greptile-apps", "S1", `Reviewed ${SHORT}.\n**Confidence score: 5/5**`),
      ],
      reviews: [
        user("carol", "R1", "", { state: "APPROVED" }),
        user("carol", "R2", "", { state: "COMMENTED" }),
        user("me", "R3", "mine", { state: "COMMENTED" }),
        bot("macroscope-app", "R4", "ok", { state: "COMMENTED", commit: { oid: HEAD } }),
      ],
      threads: [thread, { isResolved: true, path: "README.md", line: null, comments: { nodes: [user("frank", "T4", "typo")] } }],
    });
    const pendingSlow = checks(check("build", "pass"), check("slow", "pending"), check("Greptile Review", "fail"), check("CodeRabbit", "pass"));
    const files = "a.js\nb.js\nc.js\nd.js\ne.js\nf.js\ng.js\nunrelated.js\n";
    const scen = scenario({
      graphql: [poll1, poll2, pr({ state: "MERGED" })],
      checks: [checks(check("build", "pass"), check("slow", "pending"), check("Greptile Review", "fail")), pendingSlow],
      extra: [
        { match: "^pr diff", responses: [{ stdout: "a.js\nb.js\nc.js\nd.js\ne.js\nf.js\ng.js\nmine.js\n" }] },
        { match: "compare/1111111", responses: [{ stdout: files }] },
      ],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [
      `#7 comment from bob: looks fine ${URL}#B`,
      `#7 review from carol (approved):  ${URL}#R1`,
      `#7 new thread from dave on src/a.js:9: why? ${URL}#T1`,
      `#7 thread reply from erin on src/a.js:9: ${"x".repeat(97)}... ${URL}#T3`,
      `#7 new thread from frank on README.md: typo ${URL}#T4`,
      `#7 greptile summary changed on ${SHORT}: Confidence score: 5/5 ${URL}#S1`,
      `#7 macroscope finished on ${SHORT}`,
      `#7 coderabbit finished on ${SHORT} (advisory, not waited on)`,
      `#7 main moved to 2222222 and touches files in this PR: a.js, b.js, c.js, d.js, e.js and 2 more`,
      "#7 merge state is BEHIND: update the branch from main before merging",
      `#7 merged: ${URL}`,
    ]);
  });

  test("gating bot summary change after it finished is an event; checks finished is reported once", async () => {
    const d = tmp();
    const s = (score) => bot("greptile-apps", "S1", `Reviewed ${SHORT}.\nConfidence score: ${score}/5`);
    const scen = scenario({
      graphql: [pr({ comments: [s(3)] }), pr({ comments: [s(5)] }), pr({ comments: [s(5)] }), pr({ comments: [s(5)] })],
      checks: [
        checks(check("build", "pass"), check("Greptile Review", "pending")),
        checks(check("build", "pass"), check("Greptile Review", "fail")),
        checks(check("build", "pass"), check("Greptile Review", "fail")),
      ],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO, "--until", "any-change"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 greptile finished on ${SHORT}: Confidence score: 5/5; failed: Greptile Review`]);

    const d2 = tmp();
    const scen2 = scenario({
      graphql: [pr({ comments: [s(3)] }), pr({ comments: [s(4)] })],
      checks: [checks(check("build", "pass"))],
    });
    // First run: baseline marks greptile done; second poll sees the summary change.
    const r2 = await watch(d2, scen2, ["7", "--repo", REPO, "--until", "any-change"]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.deepEqual(r2.lines, [`#7 greptile summary changed on ${SHORT}: Confidence score: 4/5 ${URL}#S1`]);

    const d3 = tmp();
    const scen3 = scenario({
      graphql: [pr({ base: null, merge: "UNKNOWN" })],
      checks: [checks(check("build", "pending")), checks(check("build", "pass"))],
    });
    const r3 = await watch(d3, scen3, ["7", "--repo", REPO, "--until", "any-change"]);
    assert.equal(r3.code, 0, r3.stderr);
    assert.deepEqual(r3.lines, [`#7 checks finished on ${SHORT}: 1 pass; no greptile or macroscope review yet; 0 unresolved threads; merge state UNKNOWN`]);
  });

  test("base move with no shared files or a failed compare is not an event", async () => {
    const d = tmp();
    const scen = scenario({
      graphql: [pr(), pr({ base: BASE2 }), pr({ base: "3333333" + "0".repeat(33) }), pr({ state: "MERGED" })],
      checks: [checks(check("build", "pending"))],
      extra: [
        { match: "^pr diff", responses: [{ stdout: "mine.js\n" }] },
        { match: "compare/1111111", responses: [{ stdout: "other.js\n" }] },
        { match: "compare/2222222", responses: [{ stderr: "HTTP 404\n", code: 1 }] },
      ],
    });
    const r = await watch(d, scen, ["7", "--repo", REPO]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);
    assert.match(r.stderr, /could not compare base commits/);
  });

  test("--timeout exits 3 with a timeout line while checks stay pending", async () => {
    const d = tmp();
    const r = await watch(d, scenario({ graphql: [pr()], checks: [checks(check("build", "pending"))] }), ["7", "--repo", REPO, "--until", "green", "--timeout", "1"]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.lines.at(-1), "#7 timeout: 1s");
    assert.ok(!existsSync(path.join(d, "state", "acme__widgets__7.lock")), "lock removed on exit");
  });

  test("bad input exits 2", async () => {
    const d = tmp();
    const scen = scenario({ graphql: [pr()], view: [{ stderr: "GraphQL: Could not resolve to a PullRequest\n", code: 1 }] });
    const cases = [
      [[], /missing PR number/],
      [["abc"], /'abc' is not a PR number or PR URL/],
      [["0", "--repo", REPO], /not a valid PR number/],
      [["7", "8", "--repo", REPO], /expected one PR/],
      [["7", "--repo", "nope"], /'nope' is not owner\/name/],
      [["7", "--until", "soon"], /--until must be/],
      [["7", "--interval", "x"], /--interval must be/],
      [["7", "--timeout", "0"], /--timeout must be a positive number/],
      [["7", "--bogus"], /unknown option --bogus/],
      [["7", "--repo", REPO], /cannot read acme\/widgets#7/],
    ];
    const results = await Promise.all(cases.map(([args], i) => watch(d, scen, args, { name: `bad${i}` })));
    results.forEach((r, i) => {
      assert.equal(r.code, 2, `case ${i}: ${r.stdout}`);
      assert.match(r.stdout, cases[i][1]);
    });
  });

  test("repo comes from the checkout when --repo is absent", async () => {
    const d = tmp();
    const ok = scenario({ graphql: [pr({ state: "MERGED" })], extra: [{ match: "^repo view", responses: [{ stdout: `${REPO}\n` }] }] });
    // extra rules come after pr view, so put repo view in front.
    ok.rules.unshift(ok.rules.pop());
    const r = await watch(d, ok, ["#7"], { name: "ok" });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.lines, [`#7 merged: ${URL}`]);

    const none = scenario({ graphql: [pr()] });
    none.rules.unshift({ match: "^repo view", responses: [{ stderr: "no git remotes found\n", code: 1 }] });
    const r2 = await watch(d, none, ["7"], { name: "none" });
    assert.equal(r2.code, 2);
    assert.match(r2.stdout, /no --repo given/);
  });
});
