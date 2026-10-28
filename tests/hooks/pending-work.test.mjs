import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../hooks/scripts/pending-work.mjs");
const HEADER = "id\ttrack\tstate\tbranch\tpr\tsha\tissue\tdepends_on\tlanes\tbrief";

function repo({ states = [], autonomy = "stop", config = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cstack-stop-"));
  const store = path.join(root, ".cstack/runs/prog");
  mkdirSync(store, { recursive: true });
  mkdirSync(path.join(root, "src"));
  if (config === true) writeFileSync(path.join(root, ".cstack/config.json"), JSON.stringify({ autonomy }));
  else if (config) writeFileSync(path.join(root, ".cstack/config.json"), config);
  const rows = states.map((s, i) => `U${i + 1}\tcore\t${s}\t\t\t\t\t\t\t`);
  writeFileSync(path.join(store, "units.tsv"), [HEADER, ...rows, ""].join("\n"));
  return { root, store };
}

function stop(input, env = {}, cwd = undefined) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, CSTACK_COORDINATOR: "1", CSTACK_RUN: "prog", ...env },
    encoding: "utf8",
    cwd,
  });
  return { code: r.status, err: r.stderr };
}

test("inert outside a coordinator session or without a run", () => {
  const { root } = repo({ states: ["in-progress"] });
  assert.equal(stop({ cwd: root }, { CSTACK_COORDINATOR: "" }).code, 0);
  assert.equal(stop({ cwd: root }, { CSTACK_RUN: "" }).code, 0);
  assert.equal(stop({ cwd: root }, { CSTACK_RUN: "other" }).code, 0, "no store for that run");
  assert.equal(stop("not json").code, 0);
  assert.equal(stop({ cwd: root, stop_hook_active: true }).code, 0, "the second stop in a row is allowed");
});

test("blocks while units are in progress and no watcher is armed", () => {
  const { root, store } = repo({ states: ["merged", "in-progress", "verifying", "pr-open"] });
  const out = stop({ cwd: path.join(root, "src") });
  assert.equal(out.code, 2);
  assert.match(out.err, /cstack pending-work: units in flight \(U2 in-progress, U3 verifying\)/);
  assert.ok(out.err.includes(`gates/inbox-wait.mjs --store ${store}`), out.err);
  assert.ok(out.err.includes("inbox drain"));
});

test("uses the session cwd when the input has none", () => {
  const { root } = repo({ states: ["in-progress"] });
  assert.equal(stop({}, {}, root).code, 2);
});

test("a live watcher lets the coordinator end its turn; dead or junk marks do not", () => {
  const { root, store } = repo({ states: ["in-progress"] });
  mkdirSync(path.join(store, "watchers"));
  writeFileSync(path.join(store, "watchers", "notapid"), "");
  writeFileSync(path.join(store, "watchers", "999999999"), "");
  assert.equal(stop({ cwd: root }).code, 2);
  writeFileSync(path.join(store, "watchers", String(process.pid)), "");
  assert.equal(stop({ cwd: root }).code, 0);
});

test("a watcher owned by another user still counts as alive", () => {
  const { root, store } = repo({ states: ["in-progress"] });
  mkdirSync(path.join(store, "watchers"));
  writeFileSync(path.join(store, "watchers", "1"), "");
  assert.equal(stop({ cwd: root }).code, 0, "pid 1 exists (EPERM for a normal user, ok for root)");
});

test("pr-open counts as in flight only under autonomy send", () => {
  assert.equal(stop({ cwd: repo({ states: ["pr-open", "done"] }).root }).code, 0, "merge-ready under stop waits on the human");
  assert.equal(stop({ cwd: repo({ states: ["pr-open"], autonomy: "send" }).root }).code, 2);
  assert.equal(stop({ cwd: repo({ states: ["pr-open"], config: "{broken" }).root }).code, 0, "an unreadable config reads as stop");
  assert.equal(stop({ cwd: repo({ states: [], config: false }).root }).code, 0);
});

test("run.json can lower autonomy for the hook; raising needs CSTACK_PROGRAM_AUTONOMY=send", () => {
  const lowered = repo({ states: ["pr-open"], autonomy: "send" });
  writeFileSync(path.join(lowered.store, "run.json"), JSON.stringify({ autonomy: "stop" }));
  assert.equal(stop({ cwd: lowered.root }).code, 0, "run.json stop lowers config send");
  const raised = repo({ states: ["pr-open"] });
  writeFileSync(path.join(raised.store, "run.json"), JSON.stringify({ autonomy: "send" }));
  assert.equal(stop({ cwd: raised.root }, { CSTACK_PROGRAM_AUTONOMY: "" }).code, 0, "run.json alone cannot raise");
  assert.equal(stop({ cwd: raised.root }, { CSTACK_PROGRAM_AUTONOMY: "send" }).code, 2, "a human-launched send run still merges pr-open units");
});
