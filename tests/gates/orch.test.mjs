// Tests for gates/orch.mjs and gates/lib/store.mjs. Run with `node --test`.
// Store cases call the library in-process; CLI cases spawn gates/orch.mjs with a temp store.
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NotFoundError, UsageError, compareIds, holderIsDead, isPassing, openStore, parseState, parseVerdict, splitList } from "../../gates/lib/store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const ORCH = path.join(ROOT, "gates/orch.mjs");
const FAKE_BIN = path.join(ROOT, "tests/fixtures/bin");
const UNIT_HEADER = "id\ttrack\tstate\tbranch\tpr\tsha\tissue\tdepends_on\tlanes\tbrief";
const LEDGER_HEADER = "unit\tpr\tsha\tverdict\tevidence\tverifier\tts";

const BASE_ENV = { ...process.env };
for (const k of ["ORCH_STORE", "CSTACK_RUN", "ORCH_REPO", "ORCH_LOCK_WAIT_MS", "FAKE_GH_SCENARIO", "FAKE_GH_STATE"]) delete BASE_ENV[k];

const dirs = [];
const handles = [];
afterEach(() => {
  for (const s of handles.splice(0).reverse()) s.close();
  for (const d of dirs.splice(0)) {
    chmodSync(d, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), "cstack-orch-"));
  dirs.push(d);
  return d;
}
function use(dir, opts) {
  const s = openStore(dir, opts);
  handles.push(s);
  return s;
}
function fresh(opts) {
  const dir = tmp();
  const store = use(dir, opts);
  store.init();
  return { dir, store };
}
function cli(args, { env = {}, cwd = ROOT } = {}) {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd, env: { ...BASE_ENV, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function cliAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ORCH, ...args], { env: { ...BASE_ENV, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const lockPath = (dir) => path.join(dir, ".orch.lock");

// ---- fake gh + git stack for frontier ----
function git(repo, ...args) {
  const r = spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function makeStack(dir) {
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "main.txt"), "main\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "main");
  for (const [i, b] of ["stack/merged", "stack/closed", "stack/open", "stack/draft"].entries()) {
    git(repo, "checkout", "-qb", b);
    writeFileSync(path.join(repo, `s${i}.txt`), b);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", b);
  }
  git(repo, "checkout", "-q", "stack/open");
  const sha = (b) => git(repo, "rev-parse", b);
  return { repo, merged: sha("stack/merged"), closed: sha("stack/closed"), open: sha("stack/open"), draft: sha("stack/draft") };
}
const pr = (number, state, head, base) => ({ number, state, headRefName: head, baseRefName: base });
function defaultRules(over = {}) {
  const r = {
    "--head stack/open": { json: [pr(11, "OPEN", "stack/open", "stack/closed")] },
    "--head stack/closed": { json: [pr(13, "CLOSED", "stack/closed", "stack/merged")] },
    "--head stack/merged": { json: [pr(10, "MERGED", "stack/merged", "main")] },
    "--base stack/open": { json: [pr(14, "OPEN", "stack/draft", "stack/open"), pr(15, "CLOSED", "stack/abandoned", "stack/open")] },
    "--base stack/draft": { json: [] },
    ...over,
  };
  return Object.entries(r).map(([k, resp]) => ({ match: `^pr list ${k} --state all --json number,state,headRefName,baseRefName$`, responses: [resp] }));
}
function withGh(dir, rules, fn) {
  const scenario = path.join(dir, `gh-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scenario, JSON.stringify({ rules }));
  const saved = { PATH: process.env.PATH, FAKE_GH_SCENARIO: process.env.FAKE_GH_SCENARIO };
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${saved.PATH}`;
  process.env.FAKE_GH_SCENARIO = scenario;
  try {
    return fn({ PATH: process.env.PATH, FAKE_GH_SCENARIO: scenario });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_GH_SCENARIO === undefined) delete process.env.FAKE_GH_SCENARIO;
    else process.env.FAKE_GH_SCENARIO = saved.FAKE_GH_SCENARIO;
  }
}

describe("store", () => {
  test("initializes an idempotent plain-file store and releases its lock", () => {
    const dir = tmp();
    const store = use(dir);
    assert.deepEqual(store.init(), { store: dir });
    const units = readFileSync(path.join(dir, "units.tsv"), "utf8");
    assert.equal(units, `${UNIT_HEADER}\n`);
    assert.equal(readFileSync(path.join(dir, "ledger.tsv"), "utf8"), `${LEDGER_HEADER}\n`);
    store.init();
    assert.equal(readFileSync(path.join(dir, "units.tsv"), "utf8"), units);
    assert.deepEqual(readdirSync(dir).sort(), [".orch.lock", "frontier.json", "gates.md", "inbox", "ledger.tsv", "preferences.md", "units.tsv"]);
    assert.equal(readFileSync(lockPath(dir), "utf8"), `${process.pid}\n`);
    store.close();
    store.close();
    assert.ok(!existsSync(lockPath(dir)));
  });

  test("composes unit add, set, get, list, and counts", () => {
    const { store } = fresh();
    assert.deepEqual(store.units.add({ id: "u1", track: "build", brief: "briefs/u1.md", issue: "42", dependsOn: " u0 , u9", lanes: "E1.1,E1.2" }), {
      id: "u1",
      track: "build",
      state: "planned",
      branch: "",
      pr: "",
      sha: "",
      issue: "42",
      depends_on: "u0,u9",
      lanes: "E1.1,E1.2",
      brief: "briefs/u1.md",
    });
    const quoted = store.units.add({ id: "=SUM(A1)", track: "+build", state: "ready" });
    assert.equal(quoted.id, "'=SUM(A1)");
    assert.equal(quoted.track, "'+build");
    assert.equal(quoted.state, "ready");

    const updated = store.units.set({ id: "u1", state: "done", branch: "cstack/u1", pr: 184530, sha: "abc123", dependsOn: "", lanes: "E2.1", issue: 7, track: "land", brief: "b2.md" });
    assert.deepEqual(updated, {
      id: "u1",
      track: "land",
      state: "done",
      branch: "cstack/u1",
      pr: "184530",
      sha: "abc123",
      issue: "7",
      depends_on: "",
      lanes: "E2.1",
      brief: "b2.md",
    });
    assert.deepEqual(store.units.get("u1"), updated);
    assert.deepEqual(store.units.list({ state: "done", track: "land" }), [updated]);
    assert.equal(store.units.list().length, 2);
    assert.deepEqual(store.units.counts(), { done: 1, ready: 1 });

    assert.throws(() => store.units.add({ id: "u1", track: "build" }), /unit u1 already exists/);
    assert.throws(() => store.units.set({ id: "missing", state: "done" }), NotFoundError);
    assert.throws(() => store.units.get("missing"), NotFoundError);
    assert.throws(() => store.units.set({ id: "u1" }), /at least one field/);
    assert.throws(() => store.units.set({ id: "u1", dependsOn: "u1" }), /cannot depend on itself/);
    assert.throws(() => store.units.add({ id: "u3", track: "b", dependsOn: "u3" }), /cannot depend on itself/);
    assert.throws(() => store.units.add({ id: "a,b", track: "b" }), /must not contain a comma/);
    assert.throws(() => store.units.add({ id: " ", track: "b" }), /unit id must not be empty/);
    assert.throws(() => store.units.add({ id: "u3", track: "b", state: "pending" }), /state must be one of/);
    assert.throws(() => store.units.add({ id: "u3", track: "b", dependsOn: "u1,,u2" }), /comma-separated/);
    assert.throws(() => store.units.add({ id: "u3", track: "b", lanes: "a,a" }), /must not contain duplicates/);
    assert.throws(() => store.units.add({ id: "u3", track: "b", issue: "0" }), /issue must be a positive integer/);
    assert.throws(() => store.units.set({ id: "u1", pr: "12x" }), /PR must be a positive integer/);
    assert.throws(() => store.units.list({ state: "nope" }), UsageError);
  });

  test("ready lists dependency-free units in natural id order and breaks cycles", () => {
    const { store } = fresh();
    assert.deepEqual(store.units.ready(), []);
    store.units.add({ id: "u10", track: "t" });
    store.units.add({ id: "u2", track: "t", dependsOn: "u1" });
    store.units.add({ id: "u1", track: "t" });
    store.units.add({ id: "u3", track: "t", state: "ready" });
    store.units.add({ id: "u4", track: "t", dependsOn: "u1,u10" });
    assert.deepEqual(
      store.units.ready().map((u) => [u.id, u.override]),
      [
        ["u1", false],
        ["u3", false],
        ["u10", false],
      ],
    );
    store.units.set({ id: "u1", state: "merged" });
    store.units.set({ id: "u10", state: "done" });
    store.units.set({ id: "u3", state: "in-progress" });
    assert.deepEqual(
      store.units.ready().map((u) => u.id),
      ["u2", "u4"],
    );
    // Cycle: u5 <-> u6, nothing in flight.
    store.units.set({ id: "u2", state: "done" });
    store.units.set({ id: "u4", state: "done" });
    store.units.add({ id: "u6", track: "t", dependsOn: "u5" });
    store.units.add({ id: "u5", track: "t", dependsOn: "u6" });
    assert.deepEqual(store.units.ready(), []);
    for (const s of ["verifying", "pr-open"]) {
      store.units.set({ id: "u3", state: s });
      assert.deepEqual(store.units.ready(), [], s);
    }
    store.units.set({ id: "u3", state: "error" });
    const [override, ...rest] = store.units.ready();
    assert.equal(override.id, "u5");
    assert.equal(override.override, true);
    assert.equal(rest.length, 0);
    // A blocked "ready" unit is not an override candidate; only planned units are.
    store.units.set({ id: "u5", state: "ready" });
    assert.equal(store.units.ready()[0].id, "u6");
    store.units.set({ id: "u6", state: "needs-human" });
    assert.deepEqual(store.units.ready(), []);
  });

  test("appends ledger verdicts; latest row per unit and SHA wins", () => {
    const { store } = fresh();
    assert.equal(store.ledger.latest({ unit: "u1", sha: "abc" }), null);
    store.units.add({ id: "u1", track: "t" });
    store.units.set({ id: "u1", pr: 9 });
    const first = store.ledger.record({ unit: "u1", sha: "abc", verdict: "unit-test-verified", evidence: "r/v.md", verifier: "opus" });
    assert.equal(first.pr, "9");
    assert.equal(first.verifier, "opus");
    assert.deepEqual(store.ledger.latest({ unit: "u1", sha: "abc" }), first);
    const second = store.ledger.record({ unit: "u1", sha: "abc", verdict: "rejected", evidence: "r/judge.md", pr: 10 });
    assert.equal(second.pr, "10");
    assert.equal(store.ledger.record({ unit: "ghost", sha: "f00", verdict: "approved", evidence: "e" }).pr, "");
    assert.deepEqual(store.ledger.latest({ unit: "u1", sha: "abc" }), second);
    assert.equal(store.ledger.rows().length, 3);
    assert.deepEqual(store.ledger.summary(), { approved: 1, rejected: 1 });
    assert.throws(() => store.ledger.record({ unit: "u1", sha: "abc", verdict: "looks-good", evidence: "e" }), /verdict must be one of/);
    assert.throws(() => store.ledger.record({ unit: "u1", sha: "", verdict: "approved", evidence: "e" }), /SHA must not be empty/);
    assert.throws(() => parseVerdict("lgtm"), UsageError);
    assert.equal(parseState("merged"), "merged");
    assert.ok(isPassing("approved") && isPassing("live-ui-verified") && isPassing("unit-test-verified"));
    assert.ok(!isPassing("type-check-only") && !isPassing("rejected") && !isPassing("verifier-blocked"));
    assert.deepEqual(splitList(""), []);
    assert.deepEqual(splitList("a,b"), ["a", "b"]);
    assert.ok(compareIds("u2", "u10") < 0);
  });

  test("pushes, peeks, and drains inbox pointers oldest first", () => {
    const { dir, store } = fresh();
    const first = store.inbox.push({ agent: "worker-1", unit: "u1", status: "done", report: "reports/u1.md" });
    assert.match(first.file, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-[\w-]+\.tsv$/);
    assert.equal(readFileSync(path.join(dir, "inbox", first.file), "utf8"), "worker-1\tu1\tdone\treports/u1.md\n");
    // An older pointer written by hand sorts first.
    writeFileSync(path.join(dir, "inbox", "2000-01-01T00-00-00-000Z-1-a.tsv"), "worker-0\tu0\tfailed\t\n");
    store.inbox.push({ agent: "worker-2", unit: "u2", status: "failed" });
    assert.equal(store.inbox.count(), 3);
    const peeked = store.inbox.peek();
    assert.deepEqual(
      peeked.map((p) => p.agent),
      ["worker-0", "worker-1", "worker-2"],
    );
    assert.equal(peeked[0].ts, "2000-01-01T00:00:00.000Z");
    assert.equal(store.inbox.count(), 3);
    assert.equal(store.inbox.drain().length, 3);
    assert.equal(store.inbox.count(), 0);
    assert.deepEqual(readdirSync(path.join(dir, "inbox")), []);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith(".inbox-drain-")),
      [],
    );
    assert.throws(() => store.inbox.push({ agent: "a", unit: "", status: "s" }), /unit must not be empty/);
    rmSync(path.join(dir, "inbox"), { recursive: true });
    assert.throws(() => store.inbox.push({ agent: "a", unit: "u", status: "s" }), /not initialized/);
    assert.throws(() => store.inbox.count(), /not initialized/);
  });

  test("replaces a stale lock whose holder pid is dead", () => {
    const { dir, store } = fresh();
    store.close();
    const pid = deadPid();
    writeFileSync(lockPath(dir), `${pid}\n`);
    assert.ok(holderIsDead(String(pid)));
    const stale = [];
    const recovered = use(dir, { onStaleLock: (h) => stale.push(h) });
    assert.equal(recovered.units.add({ id: "u1", track: "b" }).id, "u1");
    assert.deepEqual(stale, [String(pid)]);
    recovered.close();
    assert.ok(!existsSync(lockPath(dir)));
  });

  test("blocks a writer on a live lock and steals it only with force", () => {
    const { dir, store } = fresh();
    store.close();
    writeFileSync(lockPath(dir), `${process.pid}\n`);
    const started = Date.now();
    assert.throws(() => use(dir, { waitMs: 60 }).units.add({ id: "u1", track: "b" }), new RegExp(`store lock held by pid ${process.pid}`));
    assert.ok(Date.now() - started >= 50, "waited before giving up");
    writeFileSync(lockPath(dir), "");
    assert.throws(() => use(dir, { waitMs: 0 }).units.add({ id: "u1", track: "b" }), /store lock held by pid unknown/);
    writeFileSync(lockPath(dir), `${process.pid}\n`);
    const stolen = [];
    const forced = use(dir, { waitMs: 0, force: true, onLockStolen: (h) => stolen.push(h) });
    forced.units.add({ id: "u1", track: "b" });
    forced.units.add({ id: "u2", track: "b" });
    assert.deepEqual(stolen, [String(process.pid)]);
    // A lock taken over by someone else survives our close.
    writeFileSync(lockPath(dir), "999999999\n");
    forced.close();
    assert.equal(readFileSync(lockPath(dir), "utf8"), "999999999\n");
    assert.ok(!holderIsDead("999999999x") && !holderIsDead("0") && !holderIsDead(String(process.pid)));
  });

  test("surfaces filesystem errors while taking the lock", () => {
    const { dir, store } = fresh();
    store.close();
    chmodSync(dir, 0o555);
    try {
      assert.throws(
        () => use(dir).units.add({ id: "u1", track: "b" }),
        (err) => err.code === "EACCES",
      );
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("parks gates, stores standing orders, and renders status", () => {
    const { dir, store } = fresh();
    store.units.add({ id: "u1", track: "build" });
    assert.deepEqual(store.gates.park({ id: "release", question: "Ship now?", options: "ship,wait", defaultAnswer: "wait" }), {
      kind: "open",
      id: "release",
      question: "Ship now?",
      options: "ship,wait",
      defaultAnswer: "wait",
    });
    store.gates.park({ id: "release", question: "Ship today?", options: "ship,wait", defaultAnswer: "wait" });
    assert.equal(store.gates.list()[0].question, "Ship today?");
    assert.deepEqual(store.standing.add({ line: "Never force push." }), { number: 1, line: "Never force push." });
    assert.deepEqual(store.standing.add({ line: "Opus codes.\nSonnet reviews." }), { number: 2, line: "Opus codes. Sonnet reviews." });

    const first = store.status.render();
    assert.equal(first.changed, "first render");
    assert.deepEqual(first.summary.openGateIds, ["release"]);
    const md = readFileSync(path.join(dir, "status.md"), "utf8");
    assert.match(md, /\| release \| open \| Ship today\? \|/);
    assert.match(md, /\| u1 \| build \| planned \|/);
    assert.equal(store.status.render().changed, "no derived changes");

    assert.deepEqual(store.gates.resolve({ id: "release", answer: "ship" }), {
      kind: "resolved",
      id: "release",
      question: "Ship today?",
      options: "ship,wait",
      defaultAnswer: "wait",
      answer: "ship",
    });
    store.units.set({ id: "u1", state: "merged" });
    store.ledger.record({ unit: "u1", sha: "a|b", verdict: "approved", evidence: "x\\y" });
    assert.equal(store.status.render().changed, "units merged 0->1; units planned 1->0; ledger approved 0->1; open gates 1->0");
    assert.match(readFileSync(path.join(dir, "status.md"), "utf8"), /\| u1 \|  \| a\\\|b \| approved \| x\\\\y \|/);
    assert.deepEqual(store.gates.list(), []);
    assert.throws(() => store.gates.resolve({ id: "nope", answer: "x" }), NotFoundError);
    assert.throws(() => store.gates.park({ id: "g", question: "", options: "o", defaultAnswer: "d" }), /question must not be empty/);
    assert.deepEqual(store.standing.show(), [
      { number: 1, line: "Never force push." },
      { number: 2, line: "Opus codes. Sonnet reviews." },
    ]);

    // A status.md without a readable summary counts as a first render.
    for (const junk of ["no marker", "<!-- orch-summary {bad -->", '<!-- orch-summary {"frontierGeneration":"x"} -->', '<!-- orch-summary {"frontierGeneration":0,"openGateIds":[],"unitStates":{"a":-1},"ledgerVerdicts":{}} -->', '<!-- orch-summary {"frontierGeneration":0,"openGateIds":[1],"unitStates":{},"ledgerVerdicts":{}} -->', '<!-- orch-summary {"frontierGeneration":0,"openGateIds":[],"unitStates":[],"ledgerVerdicts":{}} -->']) {
      writeFileSync(path.join(dir, "status.md"), junk);
      assert.equal(store.status.render().changed, "first render", junk);
    }
    writeFileSync(path.join(dir, "frontier.json"), JSON.stringify({ generation: 3, prs: [], lowestUnmerged: null }));
    assert.equal(store.status.render().changed, "frontier generation 0->3");
  });

  test("rejects malformed TSV, verdict, gates, standing, frontier, and inbox data", () => {
    const { dir, store } = fresh();
    const put = (f, s) => writeFileSync(path.join(dir, f), s);

    put("units.tsv", "wrong\n");
    assert.throws(() => store.units.list(), /units.tsv has an invalid header/);
    put("units.tsv", `${UNIT_HEADER}\nshort\trow\n`);
    assert.throws(() => store.units.list(), /units.tsv has a malformed row/);
    put("units.tsv", `${UNIT_HEADER}\r\nu1\tt\tpending\t\t\t\t\t\t\t\r\n`);
    assert.throws(() => store.units.list(), /units.tsv has invalid state pending/);

    put("ledger.tsv", `${LEDGER_HEADER}\nu1\t1\tsha\tinvalid\treport\tme\tnow\n`);
    assert.throws(() => store.ledger.summary(), /ledger.tsv has invalid verdict invalid/);

    for (const [raw, msg] of [
      ["{", /not valid JSON/],
      ["[]", /must contain an object/],
      ['{"generation":"1"}', /invalid shape/],
      ['{"generation":1,"prs":{},"lowestUnmerged":null}', /invalid shape/],
      ['{"generation":1,"prs":[],"lowestUnmerged":"x"}', /invalid shape/],
      ['{"generation":-1,"prs":[],"lowestUnmerged":null}', /invalid shape/],
      ['{"generation":1,"prs":[{"pr":1,"branches":"b","sha":"s","state":"DRAFT"}],"lowestUnmerged":null}', /invalid PR row/],
      ['{"generation":1,"prs":[1],"lowestUnmerged":null}', /invalid PR row/],
    ]) {
      put("frontier.json", raw);
      assert.throws(() => store.frontier.show(), msg, raw);
    }
    put("frontier.json", '{"generation":2,"prs":[{"pr":1,"branches":"b","sha":"s","state":"OPEN","extra":1}],"lowestUnmerged":1}');
    assert.deepEqual(store.frontier.show(), { generation: 2, prs: [{ pr: 1, branches: "b", sha: "s", state: "OPEN" }], lowestUnmerged: 1 });

    for (const [raw, msg] of [
      ["# Nope\n", /invalid heading/],
      ["# Gates\n\n## g1\n\nnot a field\n", /malformed gate g1/],
      ["# Gates\n\n## g1\n\n- Status: open\n- Question: q\n", /malformed gate g1/],
      ["# Gates\n\n## g1\n\n- Status: weird\n- Question: q\n- Options: o\n- Default: d\n", /invalid status weird/],
      ["# Gates\n\n## g1\n\n- Question: q\n- Options: o\n- Default: d\n", /invalid status $/],
      ["# Gates\n\n## g1\n\n- Status: resolved\n- Question: q\n- Options: o\n- Default: d\n", /invalid status resolved/],
      ["# Gates\n\n## g1\n\n- Status: open\n- Question: q\n- Options: o\n- Default: d\n\n## g1\n\n- Status: open\n- Question: q\n- Options: o\n- Default: d\n", /duplicate gate ids/],
    ]) {
      put("gates.md", raw);
      assert.throws(() => store.gates.list(), msg, raw);
    }

    put("preferences.md", "1. one\n3. three\n");
    assert.throws(() => store.standing.show(), /malformed numbering/);
    put("preferences.md", "one\n");
    assert.throws(() => store.standing.show(), /malformed numbering/);

    put("inbox/bad.tsv", "a\tb\tc\td\n");
    assert.throws(() => store.inbox.peek(), /inbox pointer bad.tsv is malformed/);
    rmSync(path.join(dir, "inbox/bad.tsv"));
    put("inbox/2000-01-01T00-00-00-000Z-1-a.tsv", "too\tshort\n");
    assert.throws(() => store.inbox.peek(), /malformed/);
    put("inbox/2000-01-01T00-00-00-000Z-1-a.tsv", "a\tb\tc\nd\n");
    assert.throws(() => store.inbox.peek(), /malformed/);
    rmSync(path.join(dir, "inbox/2000-01-01T00-00-00-000Z-1-a.tsv"));
    mkdirSync(path.join(dir, "inbox/sub.tsv"));
    put("inbox/.tmp", "ignored");
    assert.equal(store.inbox.count(), 0);
  });

  test("reports an uninitialized store and refuses work after close", () => {
    const dir = tmp();
    const missing = path.join(dir, "nope");
    const s = use(missing);
    assert.throws(() => s.units.add({ id: "u1", track: "b" }), /store is not initialized at .*nope; run orch init/);
    assert.throws(() => s.units.list(), /not initialized/);
    assert.throws(() => s.inbox.peek(), /not initialized/);
    mkdirSync(missing);
    writeFileSync(path.join(missing, "units.tsv"), `${UNIT_HEADER}\n`);
    mkdirSync(path.join(missing, "units.tsv.d"));
    assert.throws(() => s.gates.list(), /not initialized/);
    // A directory where a file belongs is an environment error, not "uninitialized".
    mkdirSync(path.join(missing, "gates.md"));
    assert.throws(() => s.gates.list(), (err) => err.code === "EISDIR");
    writeFileSync(path.join(missing, "inbox"), "file");
    assert.throws(() => s.inbox.peek(), (err) => err.code === "ENOTDIR");

    const { store } = fresh();
    store.close();
    assert.throws(() => store.units.list(), /store is closed/);
    assert.throws(() => store.status.render(), UsageError);
    assert.throws(() => store.init(), /store is closed/);
  });

  test("resolves the ordered frontier from the gh base chain and validates an optional pin", () => {
    const { dir, store } = fresh();
    const stack = makeStack(dir);
    withGh(dir, defaultRules(), () => {
      assert.deepEqual(store.frontier.set({ repo: stack.repo }), {
        generation: 1,
        prs: [
          { pr: 10, branches: "stack/merged", sha: stack.merged, state: "MERGED" },
          { pr: 13, branches: "stack/closed", sha: stack.closed, state: "CLOSED" },
          { pr: 11, branches: "stack/open", sha: stack.open, state: "OPEN" },
          { pr: 14, branches: "stack/draft", sha: stack.draft, state: "OPEN" },
        ],
        lowestUnmerged: 11,
      });
      assert.equal(store.frontier.set({ repo: stack.repo, prs: [10, 13, 11, 14] }).generation, 2);
      assert.equal(store.frontier.show().generation, 2);
      assert.throws(() => store.frontier.set({ repo: stack.repo, prs: [10, 11, 12] }), /frontier pin mismatch: missing from resolved chain: 12; extra in resolved chain: 13,14/);
      assert.throws(() => store.frontier.set({ repo: stack.repo, prs: [10, 13, 11] }), /frontier pin mismatch: extra in resolved chain: 14$/);
      assert.throws(() => store.frontier.set({ repo: stack.repo, prs: [13, 10, 11, 14] }), /order differs: expected 13,10,11,14; resolved 10,13,11,14/);
      assert.throws(() => store.frontier.set({ repo: stack.repo, prs: [10, 10] }), /--prs must not contain duplicates/);
    });
  });

  test("prefers a branch's open PR over closed or merged history", () => {
    for (const historical of ["CLOSED", "MERGED"]) {
      const { dir, store } = fresh();
      const stack = makeStack(dir);
      const rules = defaultRules({ "--head stack/open": { json: [pr(9, historical, "stack/open", "main"), pr(11, "OPEN", "stack/open", "stack/closed")] } });
      withGh(dir, rules, () => {
        const f = store.frontier.set({ repo: stack.repo });
        assert.deepEqual(
          f.prs.map((r) => r.pr),
          [10, 13, 11, 14],
        );
      });
    }
  });

  test("rejects broken base chains and bad gh output loudly", () => {
    const { dir, store } = fresh();
    const stack = makeStack(dir);
    const cases = [
      [{ "--head stack/open": { json: [pr(11, "OPEN", "stack/open", "stack/closed"), pr(12, "OPEN", "stack/open", "main")] } }, /branch stack\/open has multiple pull requests \(#11, #12\)/],
      [{ "--head stack/open": { json: [] } }, /branch stack\/open has no pull request; open one with gh pr create/],
      [{ "--head stack/open": { stdout: "not json\n" } }, /gh pr list --head stack\/open output is not valid JSON/],
      [{ "--head stack/open": { json: { number: 1 } } }, /output is not a JSON array/],
      [{ "--head stack/open": { json: [pr(11, "DRAFT", "stack/open", "main")] } }, /output has an invalid PR row/],
      [{ "--head stack/open": { json: [pr(0, "OPEN", "stack/open", "main")] } }, /invalid PR row/],
      [{ "--head stack/open": { json: [pr(11, "OPEN", "", "main")] } }, /invalid PR row/],
      [{ "--head stack/open": { json: [pr(11, "OPEN", "stack/open", "")] } }, /invalid PR row/],
      [{ "--head stack/open": { json: [null] } }, /invalid PR row/],
      [{ "--head stack/closed": { json: [pr(13, "CLOSED", "stack/closed", "stack/open")] } }, /base chain loops at branch stack\/open/],
      [{ "--base stack/draft": { json: [pr(16, "OPEN", "stack/open", "stack/draft")] } }, /base chain loops at branch stack\/open/],
      [{ "--base stack/open": { json: [pr(14, "OPEN", "stack/draft", "stack/open"), pr(17, "OPEN", "stack/other", "stack/open")] } }, /stack is not linear: branches stack\/draft, stack\/other all target stack\/open/],
      [{ "--base stack/draft": { json: [pr(10, "OPEN", "stack/x", "stack/draft")] }, "--base stack/x": { json: [] } }, /duplicate pull requests/],
      [{ "--head stack/open": { stderr: "HTTP 502\n", code: 1 } }, /gh pr list --head stack\/open .* failed: HTTP 502/],
      [{ "--head stack/open": { stdout: "boom on stdout\n", code: 1 } }, /failed: boom on stdout/],
      [{ "--base stack/draft": { json: [pr(18, "OPEN", "stack/ghost", "stack/draft")] }, "--base stack/ghost": { json: [] } }, /git rev-parse stack\/ghost failed/],
    ];
    for (const [over, msg] of cases) {
      withGh(dir, defaultRules(over), () => assert.throws(() => store.frontier.set({ repo: stack.repo }), msg, String(msg)));
    }
    assert.equal(store.frontier.show().generation, 0);
  });

  test("an empty frontier when the checkout sits on trunk (origin/HEAD or main)", () => {
    const { dir, store } = fresh();
    const stack = makeStack(dir);
    git(stack.repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/stack/open");
    withGh(dir, [], () => {
      assert.deepEqual(store.frontier.set({ repo: stack.repo }), { generation: 1, prs: [], lowestUnmerged: null });
      git(stack.repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
      git(stack.repo, "checkout", "-q", "main");
      assert.equal(store.frontier.set({ repo: stack.repo }).generation, 2);
      git(stack.repo, "checkout", "-q", "--detach");
      assert.throws(() => store.frontier.set({ repo: stack.repo }), /git symbolic-ref --short HEAD failed/);
    });
  });
});

describe("orch CLI", () => {
  test("prints help, and rejects bad invocations with exit 2", () => {
    const help = cli(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Commands:/);
    assert.match(help.stdout, /unit ready/);
    assert.match(help.stdout, /ledger check <unit> <sha>/);
    const dir = tmp();
    const cases = [
      [["--store", dir], /a command is required/],
      [["--store", dir, "bogus"], /unknown command: bogus/],
      [["--store", dir, "unit", "fly"], /unknown command: unit fly/],
      [["--store", dir, "unit", "add", "u1"], /unit add needs --track/],
      [["--store", dir, "unit", "add", "--track", "b"], /usage: unit add <id>/],
      [["--store", dir, "unit", "get", "u1", "extra"], /usage: unit get <id>/],
      [["--store", dir, "unit", "get", "u1", "--peek"], /unit get does not take --peek/],
      [["--store", dir, "unit", "list", "--wat"], /unknown option --wat/],
      [["--store", dir, "unit", "list", "--state"], /--state needs a value/],
      [["--store", "", "init"], /--store must not be empty/],
      [["init"], /no store: pass --store <dir> or --run <slug>, or set ORCH_STORE or CSTACK_RUN/],
      [["--run", "../escape", "init"], /run slug "..\/escape" must match/],
    ];
    for (const [args, msg] of cases) {
      const r = cli(args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stderr, msg, args.join(" "));
    }
  });

  test("resolves the store from --store, --run, ORCH_STORE, and CSTACK_RUN", () => {
    const cwd = tmp();
    const viaEnv = path.join(cwd, "env-store");
    assert.equal(cli(["init"], { cwd, env: { CSTACK_RUN: "r1" } }).code, 0);
    assert.ok(existsSync(path.join(cwd, ".cstack/runs/r1/units.tsv")));
    assert.equal(cli(["--run", "r2", "init"], { cwd, env: { ORCH_STORE: viaEnv, CSTACK_RUN: "r1" } }).code, 0);
    assert.ok(existsSync(path.join(cwd, ".cstack/runs/r2/units.tsv")));
    const r = cli(["init"], { cwd, env: { ORCH_STORE: viaEnv, CSTACK_RUN: "r1" } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `initialized ${viaEnv}\n`);
    const explicit = path.join(cwd, "explicit");
    assert.equal(cli(["init", "--store", explicit], { cwd, env: { ORCH_STORE: viaEnv } }).stdout, `initialized ${explicit}\n`);
    assert.ok(!existsSync(lockPath(viaEnv)));
  });

  test("accepts ORCH_STORE and emits complete JSON", () => {
    const dir = tmp();
    const env = { ORCH_STORE: dir };
    assert.equal(cli(["init"], { env }).code, 0);
    const added = cli(["unit", "add", "u1", "--track", "build", "--issue", "12", "--depends-on", "u0", "--lanes", "E1.1,E1.2", "--json"], { env });
    assert.equal(added.code, 0, added.stderr);
    assert.deepEqual(JSON.parse(added.stdout), {
      id: "u1",
      track: "build",
      state: "planned",
      branch: "",
      pr: "",
      sha: "",
      issue: "12",
      depends_on: "u0",
      lanes: "E1.1,E1.2",
      brief: "",
    });
    assert.deepEqual(JSON.parse(cli(["--json", "inbox", "count"], { env }).stdout), { count: 0 });
  });

  test("runs every command with compact output", () => {
    const dir = tmp();
    const o = (...args) => {
      const r = cli(["--store", dir, ...args]);
      assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    assert.equal(o("init"), `initialized ${dir}\n`);
    assert.equal(o("unit", "list"), "(no units)\n");
    assert.equal(o("unit", "counts"), "none\n");
    for (let i = 1; i <= 6; i++) o("unit", "add", `u${i}`, "--track", "t");
    assert.equal(o("unit", "set", "u1", "--state", "pr-open", "--branch", "cstack/u1", "--pr", "7", "--sha", "abc", "--brief", "b.md"), "u1\tt\tpr-open\tcstack/u1\t7\tabc\t\t\t\tb.md\n");
    assert.equal(o("unit", "get", "u1"), "u1\tt\tpr-open\tcstack/u1\t7\tabc\t\t\t\tb.md\n");
    const list = o("unit", "list").trimEnd().split("\n");
    assert.equal(list.length, 5);
    assert.equal(list[4], "... 2 more; use --json");
    assert.equal(JSON.parse(cli(["--store", dir, "--json", "unit", "list", "--state", "planned", "--track", "t"]).stdout).length, 5);
    assert.equal(o("unit", "counts"), "planned=5, pr-open=1\n");

    assert.equal(o("ledger", "summary"), "none\n");
    assert.equal(o("ledger", "record", "u1", "abc", "approved", "--evidence", "e.md", "--verifier", "sonnet"), "u1\tabc\tapproved\n");
    assert.equal(o("ledger", "summary"), "approved=1\n");

    assert.equal(o("inbox", "drain"), "(empty)\n");
    assert.match(o("inbox", "push", "w1", "u1", "done", "--report", "r.md"), /^u1\tdone\t.+\.tsv\n$/);
    assert.equal(o("inbox", "count"), "1\n");
    assert.match(o("inbox", "drain", "--peek"), /\tw1\tu1\tdone\tr\.md\n$/);
    assert.equal(o("inbox", "count"), "1\n");
    assert.match(o("inbox", "drain"), /\tw1\tu1\tdone\tr\.md\n$/);
    assert.equal(o("inbox", "count"), "0\n");

    assert.equal(o("gate", "list"), "(no open gates)\n");
    for (let i = 1; i <= 5; i++) o("gate", "park", `g${i}`, "--question", "Q?", "--options", "a,b", "--default", "a");
    assert.equal(o("gate", "park", "g0", "--question", "Ship?", "--options", "y,n", "--default", "n"), "g0\topen\n");
    const gates = o("gate", "list").trimEnd().split("\n");
    assert.equal(gates[0], "g1\tQ?\ta,b\ta");
    assert.equal(gates.at(-1), "... 2 more; use --json");
    assert.equal(o("gate", "resolve", "g0", "--answer", "y"), "g0\tresolved\ty\n");

    assert.equal(o("standing", "show"), "(no standing orders)\n");
    assert.equal(o("standing", "add", "Never force push."), "1. Never force push.\n");
    assert.equal(o("standing", "show"), "1. Never force push.\n");

    assert.equal(o("frontier", "show"), "generation=0 prs=none lowest-unmerged=none\n");
    writeFileSync(path.join(dir, "frontier.json"), JSON.stringify({ generation: 1, prs: [{ pr: 7, branches: "cstack/u1", sha: "abc", state: "OPEN" }], lowestUnmerged: 7 }));
    assert.equal(o("frontier", "show"), "generation=1 prs=cstack/u1#7@abc:OPEN lowest-unmerged=7\n");

    assert.equal(o("status"), "counts: units=6; states=planned=5, pr-open=1; ledger=approved=1\nchanged: first render\ngates open: 5; ids=g1,g2,g3,g4,+1 more\n");
    assert.ok(existsSync(path.join(dir, "status.md")));
    o("gate", "resolve", "g1", "--answer", "a");
    assert.match(o("status"), /changed: open gates 5->4\ngates open: 4; ids=g2,g3,g4,g5\n$/);
    for (const g of ["g2", "g3", "g4", "g5"]) o("gate", "resolve", g, "--answer", "a");
    assert.match(o("status"), /gates open: 0\n$/);
  });

  test("unit ready orders by id and marks a dependency override", () => {
    const dir = tmp();
    const o = (...args) => cli(["--store", dir, ...args]);
    o("init");
    assert.equal(o("unit", "ready").stdout, "(no ready units)\n");
    o("unit", "add", "u10", "--track", "t");
    o("unit", "add", "u2", "--track", "t", "--depends-on", "u1");
    o("unit", "add", "u1", "--track", "t", "--state", "ready");
    o("unit", "add", "u3", "--track", "t", "--depends-on", "u1,u10");
    const ids = (r) =>
      r.stdout
        .trimEnd()
        .split("\n")
        .map((l) => l.split("\t")[0]);
    assert.deepEqual(ids(o("unit", "ready")), ["u1", "u10"]);
    o("unit", "set", "u1", "--state", "merged");
    assert.deepEqual(ids(o("unit", "ready")), ["u2", "u10"]);
    o("unit", "set", "u10", "--state", "done");
    assert.deepEqual(ids(o("unit", "ready")), ["u2", "u3"]);

    // u2 and u3 now wait on an errored unit; nothing is in flight.
    o("unit", "set", "u2", "--depends-on", "u9");
    o("unit", "set", "u3", "--depends-on", "u2");
    o("unit", "add", "u9", "--track", "t");
    o("unit", "set", "u9", "--state", "in-progress");
    assert.equal(o("unit", "ready").stdout, "(no ready units)\n");
    o("unit", "set", "u9", "--state", "error");
    const r = o("unit", "ready");
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "u2\tt\tplanned\t\t\t\t\tu9\t\t\t(dependency override)\n");
    const json = JSON.parse(o("--json", "unit", "ready").stdout);
    assert.deepEqual(
      json.map((u) => [u.id, u.override]),
      [["u2", true]],
    );
  });

  test("ledger check exits 0 only on a passing latest verdict", () => {
    const dir = tmp();
    const o = (...args) => cli(["--store", dir, ...args]);
    o("init");
    o("unit", "add", "u1", "--track", "t");
    o("unit", "set", "u1", "--pr", "184530");

    const missing = o("--json", "ledger", "check", "u1", "abc123");
    assert.equal(missing.code, 1);
    assert.deepEqual(JSON.parse(missing.stdout), { unit: "u1", sha: "abc123", verdict: "NOT-VERIFIED", approved: false });
    assert.equal(missing.stderr, "");
    assert.equal(o("ledger", "check", "u1", "abc123").stdout, "NOT-VERIFIED\n");

    const expect = { approved: 0, "live-ui-verified": 0, "unit-test-verified": 0, "type-check-only": 1, rejected: 1, "verifier-blocked": 1, "verifier-failed": 1 };
    for (const [verdict, code] of Object.entries(expect)) {
      assert.equal(o("ledger", "record", "u1", "abc123", verdict, "--evidence", `${verdict}.md`).code, 0);
      const r = o("ledger", "check", "u1", "abc123");
      assert.equal(r.code, code, verdict);
      assert.match(r.stdout, new RegExp(`^u1\\t184530\\tabc123\\t${verdict}\\t${verdict}\\.md\\t\\t\\d{4}-`));
    }
    // A verdict on an older SHA does not carry over to a new head.
    o("ledger", "record", "u1", "abc123", "approved", "--evidence", "e.md");
    assert.equal(o("ledger", "check", "u1", "abc123").code, 0);
    assert.equal(o("ledger", "check", "u1", "def456").code, 1);
    const ok = JSON.parse(o("--json", "ledger", "check", "u1", "abc123").stdout);
    assert.equal(ok.approved, true);
    assert.equal(ok.verdict, "approved");
    assert.equal(o("ledger", "summary").stdout, "approved=1\n");
  });

  test("rejects invalid states, verdicts and values with exit 2", () => {
    const dir = tmp();
    const o = (...args) => cli(["--store", dir, ...args]);
    o("init");
    o("unit", "add", "u1", "--track", "t");
    for (const [args, msg] of [
      [["unit", "set", "u1", "--state", "pending"], /state must be one of: planned, ready, in-progress, verifying, pr-open, merged, done, error, needs-human/],
      [["unit", "add", "u2", "--track", "t", "--state", "shipped"], /state must be one of/],
      [["unit", "list", "--state", "open"], /state must be one of/],
      [["ledger", "record", "u1", "abc", "lgtm", "--evidence", "e"], /verdict must be one of: approved, rejected, live-ui-verified/],
      [["ledger", "record", "u1", "abc", "approved"], /ledger record needs --evidence/],
      [["ledger", "record", "u1", "abc", "approved", "--evidence", "e", "--pr", "-3"], /PR must be a positive integer/],
      [["unit", "set", "u1", "--issue", "x"], /issue must be a positive integer/],
      [["unit", "get", "missing"], /unit missing not found/],
      [["gate", "resolve", "nope", "--answer", "a"], /gate nope not found/],
      [["unit", "add", "", "--track", "t"], /unit id must not be empty/],
      [["frontier", "set", "--prs", "1,,2"], /--prs requires a comma-separated PR list/],
      [["frontier", "set", "--prs", "1,x"], /--prs entry must be a positive integer/],
    ]) {
      const r = o(...args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stderr, msg, args.join(" "));
    }
    assert.equal(o("unit", "get", "u1").stdout.split("\t")[2], "planned");
    assert.equal(o("ledger", "summary").stdout, "none\n");
  });

  test("replaces a stale lock, waits on or steals a live one", () => {
    const dir = tmp();
    const o = (args, env) => cli(["--store", dir, ...args], { env });
    o(["init"]);
    const pid = deadPid();
    writeFileSync(lockPath(dir), `${pid}\n`);
    const stale = o(["unit", "add", "u1", "--track", "t"]);
    assert.equal(stale.code, 0);
    assert.equal(stale.stderr, `replacing stale store lock (pid ${pid} is dead)\n`);
    assert.ok(!existsSync(lockPath(dir)));

    writeFileSync(lockPath(dir), `${process.pid}\n`);
    const blocked = o(["unit", "add", "u2", "--track", "t"], { ORCH_LOCK_WAIT_MS: "0" });
    assert.equal(blocked.code, 2);
    assert.match(blocked.stderr, new RegExp(`store lock held by pid ${process.pid}`));
    // Reads do not take the lock.
    assert.equal(o(["unit", "counts"]).stdout, "planned=1\n");
    const forced = o(["--force", "unit", "add", "u2", "--track", "t"], { ORCH_LOCK_WAIT_MS: "0" });
    assert.equal(forced.code, 0);
    assert.equal(forced.stderr, `stealing store lock held by pid ${process.pid}\n`);
    assert.ok(!existsSync(lockPath(dir)));
  });

  test("ten concurrent inbox pushes produce ten entries", async () => {
    const dir = tmp();
    cli(["--store", dir, "init"]);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => cliAsync(["--store", dir, "inbox", "push", `w${i}`, `u${i}`, "done"])));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.equal(readdirSync(path.join(dir, "inbox")).length, 10);
    assert.equal(cli(["--store", dir, "inbox", "count"]).stdout, "10\n");
    const drained = JSON.parse(cli(["--store", dir, "--json", "inbox", "drain"]).stdout);
    assert.deepEqual(drained.map((p) => p.agent).sort(), Array.from({ length: 10 }, (_, i) => `w${i}`).sort());
    const ts = drained.map((p) => p.ts);
    assert.deepEqual([...ts].sort(), ts);
    assert.ok(!existsSync(lockPath(dir)));
  });

  test("frontier set reads ORCH_REPO and the fake gh", () => {
    const dir = tmp();
    cli(["--store", dir, "init"]);
    const stack = makeStack(dir);
    withGh(dir, defaultRules(), (env) => {
      const r = cli(["--store", dir, "frontier", "set", "--prs", "10,13,11,14"], { env: { ...env, ORCH_REPO: stack.repo } });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, `generation=1 prs=stack/merged#10@${stack.merged}:MERGED,stack/closed#13@${stack.closed}:CLOSED,stack/open#11@${stack.open}:OPEN,stack/draft#14@${stack.draft}:OPEN lowest-unmerged=11\n`);
      const fromCwd = cli(["--store", dir, "frontier", "set"], { env, cwd: stack.repo });
      assert.equal(fromCwd.code, 0, fromCwd.stderr);
      assert.match(fromCwd.stdout, /^generation=2 /);
      const viaFlag = cli(["--store", dir, "--json", "frontier", "set", "--repo", stack.repo], { env });
      assert.equal(JSON.parse(viaFlag.stdout).generation, 3);
    });
  });
});
