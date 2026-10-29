import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { makeRepo, gate, write, path } from "./helpers.mjs";

const DAY = 86400e3;

function daemon(cfg = {}) {
  const r = makeRepo(cfg);
  const runs = path.join(r.root, ".cstack/runs");
  const states = path.join(r.base, "systemctl.json");
  writeFileSync(states, "{}");
  let n = 0;
  const store = (issue) => path.join(runs, `issue-${issue}`);
  const orch = (issue, ...a) => assert.equal(gate("orch.mjs", ["--store", store(issue), ...a]).code, 0, a.join(" "));
  const unit = (issue, state, { pr, launched = false, worker, id = "U1" } = {}) => {
    orch(issue, "init");
    orch(issue, "unit", "add", id, "--track", "issue", "--issue", String(issue), "--state", "ready");
    if (state !== "ready" || pr) orch(issue, "unit", "set", id, "--state", state, ...(pr ? ["--pr", String(pr)] : []));
    if (launched) write(store(issue), "workers/U1.launches", "2026-10-28T00:00:00Z\tx\n");
    if (worker) setWorker(issue, worker);
  };
  const setWorker = (issue, state) => {
    const map = JSON.parse(readFileSync(states, "utf8"));
    map[`cstack-r-issue-${issue}-U1`] = state;
    writeFileSync(states, JSON.stringify(map));
  };
  const tick = (args, { rules = [], cwd } = {}) => {
    const scenario = path.join(r.base, `gh-${n++}.json`);
    writeFileSync(scenario, JSON.stringify({ rules }));
    const log = path.join(r.base, "gh.log");
    const res = gate("daemon-tick.mjs", [...args, ...(cwd ? [] : ["--repo-dir", r.root]), "--json"], {
      env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log, FAKE_SYSTEMCTL_STATES: states },
      cwd,
    });
    return res;
  };
  return { ...r, runs, store, orch, unit, setWorker, tick };
}

const pass = (res, check) => res.json.passes.find((p) => p.check === check)?.detail;

test("daemon-tick usage errors exit 2", () => {
  const d = daemon();
  assert.equal(d.tick([]).code, 2);
  assert.equal(d.tick(["nope"]).code, 2);
  assert.equal(d.tick(["scan", "x"]).code, 2);
  assert.equal(d.tick(["prepare"]).code, 2);
  assert.equal(d.tick(["prepare", "0"]).code, 2);
});

test("scan: orphans are launched here, in flight and dead; merged units with a PR need judging", () => {
  const empty = daemon();
  const none = empty.tick(["scan"], { cwd: empty.root });
  assert.equal(none.code, 0, none.out + none.err);
  assert.deepEqual(none.json.stores, []);
  const d = daemon();
  d.unit(3, "in-progress", { launched: true, worker: "failed" });
  d.unit(4, "verifying", { launched: true, worker: "active" });
  d.unit(5, "merged", { pr: 9 });
  d.unit(6, "done");
  d.unit(7, "in-progress");
  d.unit(8, "pr-open", { launched: true, pr: 2 });
  d.unit(10, "ready", { id: "U2" });
  mkdirSync(path.join(d.runs, "issue-11"), { recursive: true });
  mkdirSync(path.join(d.runs, "prog"), { recursive: true });
  d.orch(3, "inbox", "push", "worker", "U1", "crash");
  const res = d.tick(["scan"]);
  assert.equal(res.code, 0, res.out + res.err);
  const by = Object.fromEntries(res.json.stores.map((s) => [s.issue, s]));
  assert.deepEqual(Object.keys(by).map(Number), [3, 4, 5, 6, 7, 8]);
  assert.equal(by[3].orphan, true);
  assert.equal(by[3].inbox, 1);
  assert.equal(by[4].orphan, false);
  assert.equal(by[5].judge, true);
  assert.equal(by[6].judge, false);
  assert.equal(by[7].orphan, false, "a run started by hand has no launches file and is not the daemon's");
  assert.equal(by[8].orphan, false, "pr-open under stop waits on the human");
  assert.equal(pass(res, "issue-3"), "U1 in-progress, worker failed, orphan, inbox 1");
  assert.equal(pass(res, "issue-6"), "U1 done, worker inactive");
  const send = daemon({ autonomy: "send" });
  send.unit(8, "pr-open", { launched: true, pr: 2 });
  assert.equal(send.tick(["scan"]).json.stores[0].orphan, true, "pr-open under send still merges, so a dead worker is an orphan");
});

test("select: oldest ready issues first, skipping live workers and usage-limit deferrals, within parallel", () => {
  const d = daemon({ parallel: 2 });
  d.unit(4, "in-progress", { launched: true, worker: "active" });
  d.unit(13, "ready");
  write(d.store(13), "workers/U1.not-before", `${new Date(Date.now() + DAY).toISOString()}\n`);
  d.unit(14, "error");
  write(d.store(14), "workers/U1.not-before", `${new Date(Date.now() - DAY).toISOString()}\n`);
  const at = (days) => new Date(Date.now() - days * DAY).toISOString();
  const ready = [
    { number: 12, title: "newer", createdAt: at(1) },
    { number: 4, title: "running", createdAt: at(9) },
    { number: 13, title: "deferred", createdAt: at(8) },
    { number: 15, title: "tie b", createdAt: at(5) },
    { number: 3, title: "tie a", createdAt: at(5) },
    { number: 14, title: "old deferral", createdAt: at(2) },
  ];
  const rules = [{ match: "^issue list --repo o/r --state open --label cstack:ready", responses: [{ json: ready }] }];
  const res = d.tick(["select"], { rules });
  assert.equal(res.code, 0, res.out + res.err);
  assert.deepEqual(res.json.launch.map((l) => l.number), [3]);
  assert.deepEqual(
    res.json.skipped.map((s) => [s.number, s.why.split(" ")[0]]),
    [[4, "worker"], [13, "deferred"], [15, "no"], [14, "no"], [12, "no"]],
  );
  assert.equal(pass(res, "slots"), "1/2 free before launch");
  const one = daemon({ parallel: 0 });
  const r1 = one.tick(["select"], { rules });
  assert.deepEqual(r1.json.launch.map((l) => l.number), [4], "an invalid parallel counts as 1");
  const full = daemon({ parallel: 1 });
  full.unit(4, "in-progress", { worker: "active" });
  full.unit(5, "in-progress", { worker: "activating" });
  const r2 = full.tick(["select"], { rules });
  assert.equal(pass(r2, "slots"), "0/1 free before launch");
  assert.deepEqual(r2.json.launch, []);
});

test("prepare: creates issue-<N> with U1 ready, resets a stopped unit, refuses a live worker", () => {
  const d = daemon();
  const created = d.tick(["prepare", "7"]);
  assert.equal(created.code, 0, created.out + created.err);
  assert.match(pass(created, "prepare"), /issue-7: created U1 ready/);
  assert.equal(created.json.store, d.store(7));
  assert.match(pass(d.tick(["prepare", "7"]), "prepare"), /U1 already ready/);
  d.orch(7, "unit", "set", "U1", "--state", "error");
  assert.match(pass(d.tick(["prepare", "7"]), "prepare"), /U1 error -> ready/);
  d.setWorker(7, "active");
  const live = d.tick(["prepare", "7"]);
  assert.equal(live.code, 1);
  assert.match(live.json.findings[0].detail, /worker active already runs issue-7/);
});

test("retry: disabled unless retry_after_hours is set", () => {
  for (const value of [undefined, null]) {
    const d = daemon({ retry_after_hours: value });
    const res = d.tick(["retry"]);
    assert.equal(res.code, 0, res.out + res.err);
    assert.match(pass(res, "retry"), /disabled/);
  }
});

test("retry: requeues retryable failures older than the window, once", () => {
  const d = daemon({ retry_after_hours: 24 });
  const fail = (issue, line, daysAgo) => {
    d.unit(issue, "error");
    const f = path.join(d.store(issue), "failure-U1.txt");
    writeFileSync(f, `${line}\n`);
    const t = (Date.now() - daysAgo * DAY) / 1000;
    utimesSync(f, t, t);
  };
  fail(21, "cstack stopped at 6 Verify (crash): worker died", 3);
  fail(22, "cstack stopped at 5 Implement (tests_failed): red", 0.5);
  fail(23, "cstack stopped at 10 Babysit (ci_failed): lint", 2);
  fail(24, "cstack stopped at 7 Sync (base_conflict): src/a.js", 2);
  fail(25, "something else", 2);
  const errored = [25, 24, 23, 22, 21, 20].map((number) => ({ number }));
  const rules = [
    { match: "^issue list --repo o/r --state open --label cstack:error", responses: [{ json: errored }] },
    { match: "^issue view (23|24) ", responses: [{ json: { labels: [{ name: "cstack:error" }], comments: [] } }] },
    { match: "^issue edit 23 ", responses: [{ stdout: "" }] },
    { match: "^issue edit 24 ", responses: [{ code: 1, stderr: "HTTP 500" }] },
  ];
  const dry = d.tick(["retry"], { rules });
  assert.equal(dry.code, 0, dry.out + dry.err);
  assert.deepEqual(dry.json.eligible, [{ number: 23, kind: "ci_failed" }, { number: 24, kind: "base_conflict" }]);
  assert.match(pass(dry, "#20"), /no failure-U1.txt/);
  assert.match(pass(dry, "#21"), /crash is not retryable/);
  assert.match(pass(dry, "#22"), /tests_failed, due at/);
  assert.match(pass(dry, "#25"), /unknown is not retryable/);
  assert.match(pass(dry, "#23"), /dry run/);
  const applied = d.tick(["retry", "--apply"], { rules });
  assert.equal(applied.code, 1, "one relabel failed");
  assert.equal(pass(applied, "#23"), "ci_failed, requeued ready");
  assert.match(applied.json.findings[0].detail, /settle failed/);
  const u1 = gate("orch.mjs", ["--store", d.store(23), "unit", "get", "U1"]).out;
  assert.match(u1, /\tready\t/);
  const files = readdirSync(d.store(23)).filter((f) => f.startsWith("failure-U1"));
  assert.equal(files.length, 1);
  assert.notEqual(files[0], "failure-U1.txt", "the old failure is moved aside so it is not retried twice");
  assert.match(gate("orch.mjs", ["--store", d.store(24), "unit", "get", "U1"]).out, /\terror\t/);
});

test("the systemd user unit runs the loop prompt as a coordinator, on the subscription, with an explicit PATH", () => {
  const unit = readFileSync(path.resolve("skills/daemon/references/cstack-daemon@.service"), "utf8");
  const exec = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  assert.match(exec, /-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CSTACK_PROGRAM_AUTONOMY claude -p /);
  assert.match(exec, /--strict-mcp-config/);
  assert.doesNotMatch(unit, /dangerously|bypassPermissions/);
  assert.match(exec, /--permission-mode dontAsk --settings \/%I\/\.cstack\/permissions\/coordinator\.json /);
  assert.match(unit, /^ExecStartPre=\/usr\/bin\/env node \$\{CSTACK_PLUGIN\}\/gates\/run-settings\.mjs --permissions coordinator --repo-dir \/%I .*--out \/%I\/\.cstack\/permissions\/coordinator\.json$/m);
  assert.match(exec, /"\/loop 10m \/cstack:daemon"$/);
  assert.match(unit, /^Environment=CSTACK_COORDINATOR=1$/m);
  assert.match(unit, /^Environment=PATH=/m);
  assert.match(unit, /^UnsetEnvironment=ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CSTACK_PROGRAM_AUTONOMY$/m);
  assert.match(unit, /^WorkingDirectory=\/%I$/m);
});
