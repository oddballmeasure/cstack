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
    env: { ...process.env, CSTACK_COORDINATOR: "1", CSTACK_RUN: "prog", CSTACK_UNIT: "", CSTACK_HEADLESS: "", ...env },
    encoding: "utf8",
    cwd,
  });
  return { code: r.status, err: r.stderr, out: r.stdout };
}

test("inert outside a coordinator session or without a run", () => {
  const { root } = repo({ states: ["in-progress"] });
  assert.equal(stop({ cwd: root }, { CSTACK_COORDINATOR: "" }).code, 0);
  assert.equal(stop({ cwd: root }, { CSTACK_RUN: "" }).code, 0);
  assert.equal(stop({ cwd: root }, { CSTACK_RUN: "other" }).code, 0, "no store for that run");
  assert.equal(stop("not json").code, 0);
  assert.equal(stop({ cwd: root, stop_hook_active: true }).code, 0, "the second stop in a row is allowed");
});

test("a no-op in a project with no cstack run store", () => {
  const plain = mkdtempSync(path.join(tmpdir(), "cstack-stop-plain-"));
  assert.equal(stop({ cwd: plain }, { CSTACK_COORDINATOR: "", CSTACK_RUN: "" }).code, 0, "ordinary session");
  assert.equal(stop({ cwd: plain }).code, 0, "markers set but no store under the cwd");
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
  // init on POSIX, the System process on Windows
  writeFileSync(path.join(store, "watchers", process.platform === "win32" ? "4" : "1"), "");
  assert.equal(stop({ cwd: root }).code, 0, "the pid exists (EPERM for a normal user, ok for root)");
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

test("under Codex the block is a decision on stdout with exit 0", () => {
  const { root, store } = repo({ states: ["in-progress"] });
  const out = stop({ cwd: root, turn_id: "t1", hook_event_name: "Stop" });
  assert.equal(out.code, 0);
  assert.equal(out.err, "");
  const j = JSON.parse(out.out);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /units in flight \(U1 in-progress\)/);
  assert.ok(j.reason.includes(`gates/inbox-wait.mjs --store ${store}`) && j.reason.includes("in the foreground"), j.reason);
  assert.equal(stop({ cwd: root, turn_id: "t1", stop_hook_active: true }).out, "", "the second stop is still allowed");
});

test("a headless unit worker may not end its turn before its unit opens a PR or settles", () => {
  const { root } = repo({ states: ["in-progress", "verifying", "pr-open", "needs-human"] });
  const worker = (unit, input = { cwd: root }) => stop(input, { CSTACK_COORDINATOR: "", CSTACK_UNIT: unit, CSTACK_HEADLESS: "1" });
  assert.equal(stop({ cwd: root }, { CSTACK_COORDINATOR: "", CSTACK_UNIT: "U1" }).code, 0, "an interactive session with a unit marker may stop");
  assert.equal(stop({ cwd: root }, { CSTACK_COORDINATOR: "", CSTACK_HEADLESS: "1" }).code, 0, "a headless session that is neither coordinator nor unit worker");
  const out = worker("U1");
  assert.equal(out.code, 2);
  assert.match(out.err, /cstack pending-work: unit U1 is still in-progress\. .*every subagent it started dies with it/);
  assert.match(out.err, /run_in_background: false/);
  assert.equal(worker("U2").code, 2, "verifying is still unsettled");
  assert.equal(worker("U3").code, 0, "pr-open: babysit waits under its own Monitor");
  assert.equal(worker("U4").code, 0, "settled");
  assert.equal(worker("U9").code, 0, "no row for the unit");
  assert.equal(worker("U1", { cwd: root, stop_hook_active: true }).code, 0, "the second stop in a row is allowed");
  assert.equal(stop({ cwd: root }, { CSTACK_COORDINATOR: "1", CSTACK_UNIT: "U3" }).code, 2, "a coordinator marker wins over a unit marker");
  const codex = worker("U1", { cwd: root, turn_id: "t1" });
  assert.equal(codex.code, 0);
  const j = JSON.parse(codex.out);
  assert.equal(j.decision, "block");
  assert.match(j.reason, /unit U1 is still in-progress.*wait_agent/);
});
