import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { makeRepo, gate, path, GATES, FAKE_BIN } from "./helpers.mjs";

function program() {
  const r = makeRepo();
  const store = path.join(r.root, ".cstack/runs/prog");
  const orch = (...a) => {
    const res = gate("orch.mjs", ["--store", store, ...a]);
    assert.equal(res.code, 0, res.out + res.err);
  };
  orch("init");
  const states = path.join(r.base, "states.json");
  writeFileSync(states, "{}");
  const setStates = (o) => writeFileSync(states, JSON.stringify(o));
  return { ...r, store, orch, states, setStates };
}

// Runs the watcher in the background. `lines` fills as it prints; `waitFor(re)` resolves on a matching line.
function watch(p, args) {
  const child = spawn(process.execPath, [path.join(GATES, "inbox-wait.mjs"), ...args], {
    env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, FAKE_SYSTEMCTL_STATES: p.states },
  });
  const lines = [];
  let err = "";
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const l of parts) {
      lines.push(l);
      for (const w of waiters) if (w.re.test(l)) w.resolve(l);
    }
  });
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, lines, err })));
  const waitFor = (re) => {
    const hit = lines.find((l) => re.test(l));
    return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ re, resolve }));
  };
  return { child, lines, exited, waitFor };
}

const marks = (p) => (existsSync(path.join(p.store, "watchers")) ? readdirSync(path.join(p.store, "watchers")) : []);

async function until(cond) {
  while (!cond()) await new Promise((r) => setTimeout(r, 20));
}

test("inbox-wait usage and store errors exit 2", async () => {
  const p = program();
  for (const args of [[], ["--store", p.store, "extra"], ["--store", p.store, "--interval-ms", "0"], ["--store", p.store, "--until", "soon"]]) {
    assert.equal((await watch(p, args).exited).code, 2, args.join(" "));
  }
  const missing = await watch(p, ["--store", path.join(p.root, ".cstack/runs/none")]).exited;
  assert.equal(missing.code, 2);
  assert.match(missing.err, /not initialized/);
});

test("inbox-wait prints existing inbox entries and exits when every unit is terminal", async () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "set", "U1", "--state", "merged");
  p.orch("inbox", "push", "worker", "U1", "merged", "--report", "/r/U1.md");
  p.orch("inbox", "push", "unit", "U1", "merged");
  const res = await watch(p, ["--store", p.store]).exited;
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(res.lines, ["inbox worker U1 merged /r/U1.md", "inbox unit U1 merged", "done: all units terminal"]);
  assert.deepEqual(marks(p), [], "the watcher mark is removed on exit");
});

test("inbox-wait reports a dead worker and exits idle", async () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "add", "U2", "--track", "core", "--state", "ready");
  p.orch("unit", "set", "U1", "--state", "in-progress");
  p.setStates({ "cstack-r-prog-U1": "failed" });
  const res = await watch(p, ["--store", p.store]).exited;
  assert.deepEqual(res.lines, ["worker U1 failed", "idle: no live worker (2 units open)"]);
});

test("inbox-wait streams new entries and worker state changes while a worker lives", async () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "set", "U1", "--state", "in-progress");
  p.setStates({ "cstack-r-prog-U1": "active" });
  const w = watch(p, ["--store", p.store, "--interval-ms", "30"]);
  await until(() => marks(p).length === 1);
  assert.deepEqual(marks(p), [String(w.child.pid)], "the watcher holds a mark while it runs");
  p.orch("inbox", "push", "unit", "U1", "pr-open");
  await w.waitFor(/^inbox unit U1 pr-open$/);
  await new Promise((r) => setTimeout(r, 100));
  p.setStates({ "cstack-r-prog-U1": "deactivating" });
  await w.waitFor(/^worker U1 active -> deactivating$/);
  p.setStates({ "cstack-r-prog-U1": "inactive" });
  const res = await w.exited;
  assert.equal(res.code, 0);
  assert.deepEqual(res.lines, ["inbox unit U1 pr-open", "worker U1 active -> deactivating", "worker U1 deactivating -> inactive", "idle: no live worker (1 units open)"]);
});

test("inbox-wait with --until waits for the deadline instead of exiting idle", async () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  const deadline = new Date(Date.now() + 400).toISOString();
  const res = await watch(p, ["--store", p.store, "--interval-ms", "50", "--until", deadline]).exited;
  assert.deepEqual(res.lines, [`deadline: ${deadline}`]);
});

test("inbox-wait exits cleanly on SIGTERM and drops its mark", async () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "set", "U1", "--state", "in-progress");
  p.setStates({ "cstack-r-prog-U1": "active" });
  const w = watch(p, ["--store", p.store, "--interval-ms", "30"]);
  await until(() => marks(p).length === 1);
  w.child.kill("SIGTERM");
  const res = await w.exited;
  assert.equal(res.code, 0);
  assert.deepEqual(marks(p), []);
});
