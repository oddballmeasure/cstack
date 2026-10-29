import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { makeRepo, gate, path } from "./helpers.mjs";

function run(cfg = {}, runJson) {
  const r = makeRepo(cfg);
  const store = path.join(r.root, ".cstack/runs/prog");
  mkdirSync(store, { recursive: true });
  if (runJson !== undefined) writeFileSync(path.join(store, "run.json"), typeof runJson === "string" ? runJson : JSON.stringify(runJson));
  const settings = (env = {}, ...extra) => gate("run-settings.mjs", ["--store", store, "--json", ...extra], { env });
  return { ...r, store, settings };
}

const level = (res) => [res.json.autonomy.level, res.json.autonomy.source];

test("without run.json, config decides autonomy and parallel", () => {
  const s = run({ autonomy: "send", parallel: 3 });
  const res = s.settings();
  assert.equal(res.code, 0, res.err);
  assert.deepEqual(level(res), ["send", "config"]);
  assert.deepEqual(res.json.parallel, { value: 3, source: "config" });
  const d = run({ parallel: 0 }, { slug: "prog" });
  assert.deepEqual(level(d.settings()), ["stop", "config"], "run.json without autonomy keeps config");
  assert.deepEqual(d.settings().json.parallel, { value: 1, source: "default" });
});

test("run.json lowers send to stop and sets parallel", () => {
  const s = run({ autonomy: "send" }, { autonomy: "stop", parallel: 2 });
  const res = s.settings({ CSTACK_PROGRAM_AUTONOMY: "send" });
  assert.deepEqual(level(res), ["stop", "run.json"], "lowering wins even with the env set");
  assert.deepEqual(res.json.parallel, { value: 2, source: "run.json" });
});

test("run.json raises stop to send only with CSTACK_PROGRAM_AUTONOMY=send", () => {
  const s = run({}, { autonomy: "send" });
  const refused = s.settings();
  assert.deepEqual(level(refused), ["stop", "config"]);
  assert.match(refused.json.autonomy.note, /may only lower autonomy/);
  assert.deepEqual(level(s.settings({ CSTACK_PROGRAM_AUTONOMY: "yes" })), ["stop", "config"], "only the exact value send counts");
  assert.deepEqual(level(s.settings({ CSTACK_PROGRAM_AUTONOMY: "send" })), ["send", "run.json + CSTACK_PROGRAM_AUTONOMY"]);
  assert.deepEqual(level(run({ autonomy: "send" }, { autonomy: "send" }).settings()), ["send", "config"]);
});

test("a bad run.json fails closed to stop", () => {
  for (const [body, why] of [
    ["{broken", /does not parse/],
    ["null", /not a JSON object/],
    ["5", /not a JSON object/],
    ["[]", /not a JSON object/],
    [{ autonomy: "yolo" }, /is not stop or send/],
  ]) {
    const res = run({ autonomy: "send" }, body).settings({ CSTACK_PROGRAM_AUTONOMY: "send" });
    assert.deepEqual(level(res), ["stop", "run.json"], String(body));
    assert.match(res.json.autonomy.note, why);
  }
});

test("text output names the source and any refused override; usage errors exit 2", () => {
  const s = run({}, { autonomy: "send" });
  const text = gate("run-settings.mjs", ["--store", s.store, "--repo-dir", s.root]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^autonomy stop \(config\)\nparallel 1 \(config\)\nnote: run\.json asks for send/);
  const plain = run({ autonomy: "send" }).settings();
  assert.equal(gate("run-settings.mjs", ["--store", run().store]).out, "autonomy stop (config)\nparallel 1 (config)\n");
  assert.equal(plain.code, 0);
  assert.equal(gate("run-settings.mjs", []).code, 2);
  assert.equal(gate("run-settings.mjs", ["--store", s.store, "extra"]).code, 2);
});

test("--codex-sandbox prints the e2e author's sandbox flags for its worktree", async () => {
  const { git } = await import("./helpers.mjs");
  const r = makeRepo({ codex_sandbox: "read-only" });
  const wt = path.join(r.base, "wt");
  git(r.root, "worktree", "add", "-q", wt, "-b", "e2e-probe");
  const store = path.join(r.root, ".cstack/runs/prog");
  const flags = (mode, env = {}, extra = []) => gate("run-settings.mjs", ["--codex-sandbox", mode, "--repo-dir", r.root, "--worktree", wt, ...extra], { env });
  assert.equal(flags("auto").out.trim(), "'-s' 'read-only'", "config codex_sandbox");
  const ww = flags("auto", { CSTACK_CODEX_SANDBOX: "workspace-write" }, ["--store", store]).out.trim();
  const roots = JSON.parse(ww.match(/writable_roots=(\[.*\])'$/)[1]);
  const real = (p) => realpathSync.native(p);
  assert.deepEqual(roots.slice(0, 2), [path.join(real(r.root), ".git"), path.join(real(r.root), ".git", "worktrees", "wt")], "the common git dir and the worktree's own");
  assert.equal(roots.at(-1), store);
  assert.equal(flags("danger-full-access").out.trim(), "'-s' 'danger-full-access'");
  const d = makeRepo();
  const dwt = path.join(d.base, "wt");
  git(d.root, "worktree", "add", "-q", dwt, "-b", "e2e-probe");
  assert.match(gate("run-settings.mjs", ["--codex-sandbox", "auto", "--worktree", dwt], { env: { CSTACK_CODEX_SANDBOX: "" } }).out, /^'-s' 'workspace-write'/, "the default, with the config read from the worktree");
  assert.equal(gate("run-settings.mjs", ["--codex-sandbox", "auto", "--repo-dir", r.root]).code, 2, "needs --worktree");
  const plain = await import("../../gates/lib/harness.mjs");
  const outside = plain.codexSandboxArgs("workspace-write", r.base);
  assert.equal(JSON.parse(outside.at(-1).split("=")[1])[0], path.join(r.base, ".git"), "no git repo: <dir>/.git");
});
