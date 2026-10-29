import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { makeRepo, gate, path, FAKE_BIN } from "./helpers.mjs";
import { parseReset, notBefore, workerName, workerState, launchCount, readText } from "../../gates/lib/workers.mjs";

function program(cfg = {}) {
  const r = makeRepo(cfg);
  const store = path.join(r.root, ".cstack/runs/prog");
  const orch = (...a) => {
    const res = gate("orch.mjs", ["--store", store, ...a]);
    assert.equal(res.code, 0, res.out + res.err);
    return res.out.trim();
  };
  orch("init");
  const states = path.join(r.base, "states.json");
  writeFileSync(states, "{}");
  const env = { FAKE_SYSTEMCTL_STATES: states, FAKE_SYSTEMD_RUN_LOG: path.join(r.base, "systemd-run.log"), CSTACK_SESSIONS_DIR: path.join(r.base, "sessions"), CSTACK_SUPERVISOR: "systemd" };
  const setStates = (o) => writeFileSync(states, JSON.stringify(o));
  const worker = (args, extra = {}) => gate("worker.mjs", [...args], { env: { ...env, ...extra } });
  const unit = (id) => orch("unit", "get", id).split("\t");
  const files = (u) => path.join(store, "workers", u);
  return { ...r, store, orch, env, setStates, worker, unit, files };
}

test("worker usage errors exit 2", () => {
  const p = program();
  assert.equal(p.worker([]).code, 2);
  assert.equal(p.worker(["bogus", "--store", p.store]).code, 2);
  assert.equal(p.worker(["launch"]).code, 2);
  assert.equal(p.worker(["launch", "next", "--store", p.store]).code, 2);
  assert.match(p.worker(["exit", "--store", p.store]).err, /exit needs --unit/);
  assert.match(p.worker(["launch", "--store", p.store, "--unit", "U9"]).err, /unit U9 not found/);
});

test("launch --dry-run builds the systemd-run command with PATH, prompt and exit hook", () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--issue", "7", "--state", "ready");
  p.orch("unit", "add", "U2", "--track", "core", "--state", "ready");
  const res = p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], { CSTACK_WORKER_PATH: "/fake/bin:/usr/bin" });
  assert.equal(res.code, 0, res.err);
  const argv = JSON.parse(res.out);
  assert.equal(argv[0], "systemd-run");
  assert.ok(argv.includes("--unit=cstack-r-prog-U1"));
  assert.ok(argv.includes("--setenv=PATH=/fake/bin:/usr/bin"));
  assert.ok(argv.includes(`--working-directory=${p.root}`));
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(!argv.some((a) => /dangerously|bypass/i.test(a)), "no permission bypass");
  assert.deepEqual(argv.slice(argv.indexOf("--permission-mode"), argv.indexOf("--permission-mode") + 4), ["--permission-mode", "dontAsk", "--settings", p.files("U1.settings.json")]);
  const settings = JSON.parse(readFileSync(p.files("U1.settings.json"), "utf8")).permissions;
  assert.equal(settings.defaultMode, "dontAsk");
  assert.ok(settings.deny.includes("Bash(systemd-run *)"), "the worker role");
  assert.deepEqual(argv.slice(argv.indexOf("/usr/bin/env"), argv.indexOf("/usr/bin/env") + 7), ["/usr/bin/env", "-u", "ANTHROPIC_API_KEY", "-u", "ANTHROPIC_AUTH_TOKEN", "-u", "CSTACK_COORDINATOR"]);
  assert.equal(argv.at(-1), "/cstack:unit 7 --run prog --unit U1");
  assert.match(argv.find((a) => a.startsWith("--property=ExecStopPost=")), /worker\.mjs" "exit" "--store" ".*prog" "--unit" "U1"$/);
  assert.equal(p.unit("U1")[2], "ready", "a dry run changes nothing");
  assert.equal(existsSync(p.files("U1.launches")), false);
  const two = JSON.parse(p.worker(["launch", "--store", p.store, "--unit", "U2", "--dry-run", "--plugin-dir", "/opt/cstack"], { CSTACK_WORKER_PATH: "" }).out);
  assert.ok(JSON.parse(readFileSync(p.files("U2.settings.json"), "utf8")).permissions.allow.includes("Read(//opt/cstack/**)"), "settings follow --plugin-dir");
  assert.equal(two.at(-1), "/cstack:unit --run prog --unit U2");
  assert.ok(two.includes("/opt/cstack"));
  assert.ok(two.some((a) => a.startsWith("--setenv=PATH=") && a.includes("/.local/bin:/usr/local/bin:/usr/bin:/bin")));
});

test("launch marks the unit in-progress, records the launch, and leaves a live worker alone", () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  mkdirSync(path.join(p.store, "workers"), { recursive: true });
  writeFileSync(p.files("U1.not-before"), "2026-01-01T00:00:00Z\n");
  const res = p.worker(["launch", "--store", p.store, "--unit", "U1"]);
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /launched cstack-r-prog-U1 \(launch 1\)/);
  assert.equal(p.unit("U1")[2], "in-progress");
  assert.equal(existsSync(p.files("U1.not-before")), false, "a launch clears the usage-limit hold");
  assert.equal(readFileSync(p.env.FAKE_SYSTEMD_RUN_LOG, "utf8").trim().split("\n").length, 1);
  p.setStates({ "cstack-r-prog-U1": "active" });
  assert.match(p.worker(["launch", "--store", p.store, "--unit", "U1"]).out, /running cstack-r-prog-U1/);
  p.setStates({ "cstack-r-prog-U1": "failed" });
  const again = p.worker(["launch", "--store", p.store, "--unit", "U1", "--wait"], { FAKE_SYSTEMD_RUN_CODE: "1" });
  assert.match(again.out, /finished cstack-r-prog-U1 \(launch 2\)/, "with --wait the session status is not a launch failure");
  assert.ok(JSON.parse(readFileSync(p.env.FAKE_SYSTEMD_RUN_LOG, "utf8").trim().split("\n")[1]).includes("--wait"));
  const bad = p.worker(["launch", "--store", p.store, "--unit", "U1"], { FAKE_SYSTEMD_RUN_CODE: "1", FAKE_SYSTEMD_RUN_STDERR: "Failed to start transient service" });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /systemd-run failed \(1\): Failed to start/);
});

function seedExit(p, unit, { jsonl, stderr } = {}) {
  mkdirSync(path.join(p.store, "workers"), { recursive: true });
  if (jsonl !== undefined) writeFileSync(p.files(`${unit}.jsonl`), jsonl);
  if (stderr !== undefined) writeFileSync(p.files(`${unit}.stderr.log`), stderr);
}
const inbox = (p) => p.orch("inbox", "drain").split("\n").map((l) => l.split("\t"));

test("exit classifies billing, settled units, usage limits and crashes, and pushes one inbox entry", () => {
  const p = program();
  for (const id of ["U1", "U2", "U3", "U4", "U5", "U6"]) p.orch("unit", "add", id, "--track", "core", "--state", "ready");
  for (const id of ["U1", "U2", "U3", "U4", "U5", "U6"]) p.orch("unit", "set", id, "--state", "in-progress");

  seedExit(p, "U1", { jsonl: JSON.stringify({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" }) + "\n" });
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U1"]).out, /U1\tsetup\tbilled through ANTHROPIC_API_KEY/);

  p.orch("unit", "set", "U2", "--state", "merged");
  writeFileSync(path.join(p.store, "report-U2.md"), "report\n");
  seedExit(p, "U2", { jsonl: ["not json", "null", JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" }), JSON.stringify({ type: "result", result: "done" })].join("\n") });
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U2"]).out, /U2\tmerged\tunit merged/);

  p.orch("unit", "set", "U3", "--state", "pr-open");
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U3"]).out, /U3\tpr-open/);

  seedExit(p, "U4", { stderr: "Claude usage limit reached. Your limit resets 3pm\n" });
  const u4 = p.worker(["exit", "--store", p.store, "--unit", "U4"]);
  assert.match(u4.out, /U4\tusage_limit\tresets_at=/);
  assert.equal(p.unit("U4")[2], "ready", "a usage-limited unit is re-queued");
  assert.equal(new Date(readFileSync(p.files("U4.not-before"), "utf8").trim()).getHours(), 15);

  seedExit(p, "U5", { jsonl: JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1761580800" }) + "\n" });
  p.worker(["exit", "--store", p.store, "--unit", "U5"]);
  assert.equal(readFileSync(p.files("U5.not-before"), "utf8").trim(), new Date(1761580800 * 1000).toISOString());

  const crash = p.worker(["exit", "--store", p.store, "--unit", "U6"], { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "KILL" });
  assert.match(crash.out, /U6\tcrash\tservice signal, killed KILL, unit state in-progress/);
  const crash2 = p.worker(["exit", "--store", p.store, "--unit", "U6"], { SERVICE_RESULT: "", EXIT_CODE: "", EXIT_STATUS: "" });
  assert.match(crash2.out, /service unknown, unknown \?/);

  const entries = inbox(p);
  assert.deepEqual(entries.map((e) => [e[1], e[2], e[3]]), [
    ["worker", "U1", "setup"],
    ["worker", "U2", "merged"],
    ["worker", "U3", "pr-open"],
    ["worker", "U4", "usage_limit"],
    ["worker", "U5", "usage_limit"],
    ["worker", "U6", "crash"],
    ["worker", "U6", "crash"],
  ]);
  assert.equal(entries[1][4], path.join(p.store, "report-U2.md"));
  assert.equal(entries[2][4], p.files("U3.exit.txt"), "no report file: the exit file is the pointer");
  assert.match(readFileSync(p.files("U6.exit.txt"), "utf8"), /^crash /);
});

test("exit reports refused tool calls: denied when the unit stopped short, a note when it settled", () => {
  const p = program();
  for (const id of ["U1", "U2"]) p.orch("unit", "add", id, "--track", "core", "--state", "in-progress");
  const denials = [
    { tool_name: "Bash", tool_input: { command: "curl -s https://example.com" } },
    { tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } },
  ];
  seedExit(p, "U1", { jsonl: JSON.stringify({ type: "result", result: "stopped", permission_denials: denials }) + "\n" });
  const u1 = p.worker(["exit", "--store", p.store, "--unit", "U1"]);
  assert.match(u1.out, /U1\tdenied\t2 tool call\(s\) refused by the role's allowlist, first: Bash: curl -s https:\/\/example\.com; see .*U1\.denied\.txt/);
  assert.equal(readFileSync(p.files("U1.denied.txt"), "utf8"), "Bash: curl -s https://example.com\nEdit: /etc/hosts\n");
  assert.equal(p.unit("U1")[2], "in-progress", "the coordinator settles it; the wrapper only reports");

  p.orch("unit", "set", "U2", "--state", "merged");
  seedExit(p, "U2", { jsonl: JSON.stringify({ type: "result", result: "done", permission_denials: denials.slice(0, 1) }) + "\n" });
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U2"]).out, /U2\tmerged\tunit merged; 1 tool call\(s\) refused, see .*U2\.denied\.txt/);
  assert.deepEqual(inbox(p).map((e) => e[3]), ["denied", "merged"]);
});

test("next fills free slots in id order, defers usage-limited units, and frees merge-ready slots", () => {
  const p = program({ parallel: 2 });
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "add", "U2", "--track", "core", "--state", "ready");
  p.orch("unit", "add", "U3", "--track", "core", "--state", "ready");
  p.orch("unit", "add", "U4", "--track", "core", "--state", "ready", "--depends-on", "U1");
  p.orch("unit", "add", "U5", "--track", "core", "--state", "ready");
  p.orch("unit", "set", "U1", "--state", "in-progress");
  p.orch("unit", "set", "U5", "--state", "pr-open");
  mkdirSync(path.join(p.store, "workers"), { recursive: true });
  writeFileSync(p.files("U2.not-before"), new Date(Date.now() + 3600e3).toISOString());
  writeFileSync(p.files("U3.not-before"), new Date(Date.now() - 1000).toISOString());
  const text = p.worker(["next", "--store", p.store]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^launch U3\ndefer U2 until .*\nslots 1\/2\n$/);
  p.setStates({ "cstack-r-prog-U5": "active" });
  const json = JSON.parse(p.worker(["next", "--store", p.store, "--json"]).out);
  assert.deepEqual(json.launch, [], "a pr-open unit with a live worker holds a slot");
  assert.equal(json.busy, 2);
  assert.equal(json.wake, json.defer[0].until);
});

test("next defaults parallel to 1 and reports a dependency override", () => {
  const p = program({ parallel: 0 });
  p.orch("unit", "add", "U1", "--track", "core", "--depends-on", "U2");
  p.orch("unit", "add", "U2", "--track", "core", "--depends-on", "U1");
  assert.equal(p.worker(["next", "--store", p.store]).out, "launch U1 (dependency override)\nslots 1/1\n");
  const json = JSON.parse(p.worker(["next", "--store", p.store, "--json"]).out);
  assert.equal(json.wake, null);
  assert.equal(json.parallel, 1);
});

test("workers lib: names, liveness, reset times, holds", () => {
  assert.equal(workerName("o/my repo", "/x/runs/p 1", "U1"), "cstack-my-repo-p-1-U1");
  assert.equal(workerName("solo", "/x/runs/p", "U2"), "cstack-solo-p-U2");
  const saved = process.env.PATH;
  const states = path.join(makeRepo().base, "s.json");
  writeFileSync(states, JSON.stringify({ a: "active", b: "" }));
  process.env.PATH = `${FAKE_BIN}${path.delimiter}${saved}`;
  process.env.FAKE_SYSTEMCTL_STATES = states;
  try {
    assert.deepEqual(workerState("a"), { state: "active", alive: true });
    assert.deepEqual(workerState("b"), { state: "unknown", alive: false });
    assert.deepEqual(workerState("c"), { state: "inactive", alive: false });
  } finally {
    process.env.PATH = saved;
    delete process.env.FAKE_SYSTEMCTL_STATES;
  }
  const now = new Date(2026, 9, 27, 14, 0, 0);
  const at = (text) => parseReset(text, now);
  assert.equal(at("resets 3pm").getTime(), new Date(2026, 9, 27, 15, 0).getTime());
  assert.equal(at("Resets at 4:30 PM").getTime(), new Date(2026, 9, 27, 16, 30).getTime());
  assert.equal(at("resets 12am").getTime(), new Date(2026, 9, 28, 0, 0).getTime());
  assert.equal(at("resets 9am").getTime(), new Date(2026, 9, 28, 9, 0).getTime(), "a past time rolls to tomorrow");
  assert.equal(at("reset 18:15").getTime(), new Date(2026, 9, 27, 18, 15).getTime());
  assert.equal(at("limit reached|1761580800").getTime(), 1761580800000);
  assert.equal(at("no time here").getTime(), now.getTime() + 3600e3);
  const utc = new Date(Date.UTC(2026, 9, 27, 14, 0));
  assert.equal(parseReset("resets 3pm (America/New_York)", utc).toISOString(), "2026-10-27T19:00:00.000Z", "3pm in New York (UTC-4)");
  assert.equal(parseReset("resets 9am (Europe/Berlin)", utc).toISOString(), "2026-10-28T08:00:00.000Z", "a past zone time rolls to tomorrow");
  assert.equal(parseReset("resets 4pm (Mars/Base)", now).getTime(), new Date(2026, 9, 27, 16, 0).getTime(), "an unknown zone falls back to the host");
  assert.ok(Math.abs(parseReset("x").getTime() - Date.now() - 3600e3) < 5000);
  const dir = makeRepo().base;
  mkdirSync(path.join(dir, "workers"));
  assert.equal(notBefore(dir, "U1"), null);
  writeFileSync(path.join(dir, "workers/U1.not-before"), "garbage");
  assert.equal(notBefore(dir, "U1"), null);
  writeFileSync(path.join(dir, "workers/U1.not-before"), "2026-10-27T10:00:00Z\n");
  assert.equal(notBefore(dir, "U1").toISOString(), "2026-10-27T10:00:00.000Z");
  assert.equal(launchCount(dir, "U1"), 0);
  assert.equal(readText(path.join(dir, "missing")), "");
});

test("launch --coordinator starts the run's coordinator with CSTACK_COORDINATOR=1", () => {
  const p = program();
  assert.match(p.worker(["next", "--store", p.store, "--coordinator"]).err, /--coordinator goes with launch only/);
  const dry = JSON.parse(p.worker(["launch", "--store", p.store, "--coordinator", "--dry-run"]).out);
  assert.ok(JSON.parse(readFileSync(p.files("coordinator.settings.json"), "utf8")).permissions.allow.includes("Bash(systemctl --user stop cstack-*)"), "the coordinator role");
  assert.ok(dry.includes("--unit=cstack-r-prog-coordinator"));
  assert.ok(dry.includes("--setenv=CSTACK_COORDINATOR=1"));
  assert.ok(!dry.includes("CSTACK_COORDINATOR"), "the coordinator keeps its marker");
  assert.ok(!dry.some((a) => a.startsWith("--property=ExecStopPost")));
  assert.equal(dry.at(-1), "/cstack:orchestrate --run prog");
  const resume = JSON.parse(p.worker(["launch", "--store", p.store, "--coordinator", "--resume", "--dry-run"]).out);
  assert.equal(resume.at(-1), "/cstack:resume-run prog");
  const res = p.worker(["launch", "--store", p.store, "--coordinator"]);
  assert.match(res.out, /launched cstack-r-prog-coordinator \(launch 1\)/);
  assert.equal(launchCount(p.store, "coordinator"), 1);
});

test("CSTACK_PROGRAM_AUTONOMY reaches a worker only when this process has it as send", () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--issue", "7", "--state", "ready");
  const dry = (env) => JSON.parse(p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], env).out);
  assert.ok(dry({ CSTACK_PROGRAM_AUTONOMY: "send" }).includes("--setenv=CSTACK_PROGRAM_AUTONOMY=send"));
  assert.ok(dry({ CSTACK_PROGRAM_AUTONOMY: "stop" }).includes("--setenv=CSTACK_PROGRAM_AUTONOMY="), "anything else is passed empty");
  assert.ok(dry({}).includes("--setenv=CSTACK_PROGRAM_AUTONOMY="), "unset is passed empty, masking the systemd manager's value");
});

test("a program store relaunches its coordinator as /cstack:program --resume; run.json sets parallel", () => {
  const p = program({ parallel: 1 });
  writeFileSync(path.join(p.store, "run.json"), JSON.stringify({ entry: "program", slug: "prog", autonomy: "send", parallel: 2 }));
  for (const extra of [[], ["--resume"]]) {
    const dry = JSON.parse(p.worker(["launch", "--store", p.store, "--coordinator", ...extra, "--dry-run"]).out);
    assert.equal(dry.at(-1), "/cstack:program --resume prog");
  }
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  p.orch("unit", "add", "U2", "--track", "core", "--state", "ready");
  assert.equal(p.worker(["next", "--store", p.store]).out, "launch U1\nlaunch U2\nslots 2/2\n");
});

test("launch under the other backends: the runner starts claude and runs exit when it ends", { skip: process.platform === "win32" && "fake claude is a shebang script" }, () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  // The session PATH is the worker's own; put the fakes first so the runner can never start a real claude.
  const runner = { ...p.env, CSTACK_SUPERVISOR: "detached", FAKE_CLAUDE_LOG: path.join(p.base, "claude.log"), CSTACK_WORKER_PATH: `${FAKE_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const dry = p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], { ...runner, CSTACK_SUPERVISOR: "launchd" });
  const spec = JSON.parse(dry.out);
  assert.equal(spec.backend, "launchd");
  assert.equal(spec.name, "cstack-r-prog-U1");
  assert.deepEqual(spec.argv.slice(0, 2), ["claude", "-p"]);
  assert.deepEqual(spec.unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CSTACK_COORDINATOR"]);
  assert.equal(spec.env.CSTACK_UNIT, "U1");
  assert.deepEqual(spec.onExit.slice(-5), ["exit", "--store", p.store, "--unit", "U1"]);
  const coord = JSON.parse(p.worker(["launch", "--store", p.store, "--coordinator", "--dry-run"], { ...runner, CSTACK_SUPERVISOR: "launchd" }).out);
  assert.equal(coord.onExit, null, "the coordinator has no exit hook");
  assert.equal(coord.env.CSTACK_COORDINATOR, "1");

  const waited = p.worker(["launch", "--store", p.store, "--unit", "U1", "--wait"], runner);
  assert.equal(waited.code, 0, waited.err);
  assert.match(waited.out, /^finished cstack-r-prog-U1 via detached \(launch 1\)$/m);
  assert.ok(existsSync(path.join(p.base, "claude.log")), "the runner ran claude");
  assert.match(readFileSync(p.files("U1.exit.txt"), "utf8"), /^crash service success, exited 0, unit state in-progress/);
  assert.deepEqual(inbox(p).map((e) => e.slice(1, 4)), [["worker", "U1", "crash"]]);

  const failed = p.worker(["launch", "--store", p.store, "--unit", "U1"], { ...runner, CSTACK_SUPERVISOR: "taskscheduler", FAKE_SCHTASKS_CODE: "1" });
  assert.equal(failed.code, 2);
  assert.match(failed.err, /taskscheduler launch failed \(1\)/);
  const ok = p.worker(["launch", "--store", p.store, "--unit", "U1"], { ...runner, CSTACK_SUPERVISOR: "taskscheduler" });
  assert.match(ok.out, /^launched cstack-r-prog-U1 via taskscheduler \(launch 3\)$/m);
  assert.ok(existsSync(p.files("U1.spec.json")));
});

test("codex harness: launch checks the ChatGPT login, runs codex exec, and exit reads Codex events", () => {
  const p = program();
  p.orch("unit", "add", "U1", "--track", "core", "--state", "ready", "--issue", "7");
  const codex = { ...p.env, CSTACK_HARNESS: "codex" };
  const dry = JSON.parse(p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], codex).out);
  const envAt = dry.indexOf("/usr/bin/env");
  assert.deepEqual(dry.slice(envAt + 1, envAt + 7), ["-u", "OPENAI_API_KEY", "-u", "CODEX_API_KEY", "-u", "CSTACK_COORDINATOR"]);
  assert.deepEqual(dry.slice(envAt + 7, envAt + 10), ["codex", "exec", "--json"]);
  assert.ok(dry.includes("--setenv=CSTACK_HARNESS=codex"));
  assert.ok(!dry.some((x) => x.startsWith("--setenv=CSTACK_GUARD_HIDE")));
  const hidden = JSON.parse(p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], { ...codex, CSTACK_GUARD_HIDE: "/opt/g" }).out);
  assert.ok(hidden.includes("--setenv=CSTACK_GUARD_HIDE=/opt/g"), "the hidden paths reach the worker");
  assert.deepEqual(dry.slice(-3), ["-m", "gpt-6.1-sol", "$cstack:unit 7 --run prog --unit U1"]);
  assert.ok(dry.includes("sandbox_workspace_write.network_access=true"));

  const apiKey = p.worker(["launch", "--store", p.store, "--unit", "U1"], { ...codex, FAKE_CODEX_LOGIN: "Logged in using an API key - sk-***" });
  assert.equal(apiKey.code, 2);
  assert.match(apiKey.err, /codex is not logged in with ChatGPT/);
  const out = p.worker(["launch", "--store", p.store, "--unit", "U1"], { ...codex, FAKE_CODEX_LOGIN: "Not logged in", FAKE_CODEX_LOGIN_CODE: "1" });
  assert.match(out.err, /codex login status failed: Not logged in/);
  assert.equal(p.unit("U1")[2], "ready", "a refused launch changes nothing");
  assert.match(p.worker(["launch", "--store", p.store, "--unit", "U1"], { ...codex, FAKE_CODEX_LOGIN: "", FAKE_CODEX_LOGIN_CODE: "3" }).err, /codex login status failed: exit 3/);

  // A real launch through the runner, with the fakes first on the session PATH.
  const events = path.join(p.base, "events.jsonl");
  writeFileSync(events, JSON.stringify({ type: "thread.started" }) + "\n" + JSON.stringify({ type: "turn.completed", usage: {} }) + "\n");
  const ran = p.worker(["launch", "--store", p.store, "--unit", "U1", "--wait"], {
    ...codex, CSTACK_SUPERVISOR: "detached", FAKE_CODEX_EVENTS: events, FAKE_CODEX_LOG: path.join(p.base, "codex.log"),
    CSTACK_WORKER_PATH: `${FAKE_BIN}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  });
  assert.equal(ran.code, 0, ran.err);
  assert.match(readFileSync(p.files("U1.jsonl"), "utf8"), /turn\.completed/);
  assert.match(readFileSync(p.files("U1.exit.txt"), "utf8"), /^crash service success/);
  assert.deepEqual(readFileSync(path.join(p.base, "codex.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)[0]), ["login", "exec"]);
  inbox(p);
  p.orch("unit", "set", "U1", "--state", "ready");

  const mine = program({ codex_sandbox: "danger-full-access", models_codex: { code: "inherit" } });
  mine.orch("unit", "add", "U1", "--track", "core", "--state", "ready");
  const full = JSON.parse(mine.worker(["launch", "--store", mine.store, "--unit", "U1", "--dry-run"], codex).out);
  assert.ok(full.includes("danger-full-access") && !full.includes("-m") && !full.includes("sandbox_workspace_write.network_access=true"));
  const envBox = JSON.parse(p.worker(["launch", "--store", p.store, "--unit", "U1", "--dry-run"], { ...codex, CSTACK_CODEX_SANDBOX: "read-only" }).out);
  assert.ok(envBox.includes("read-only"), "CSTACK_CODEX_SANDBOX wins over config");

  p.orch("unit", "set", "U1", "--state", "in-progress");
  const limit = [
    { type: "thread.started" },
    { type: "item.completed", item: { type: "agent_message", text: "working" } },
    { type: "error", message: "You've hit your usage limit. Try again at 3:00 PM." },
    { type: "turn.failed", error: { message: "usage_limit_reached" } },
  ];
  seedExit(p, "U1", { jsonl: limit.map((e) => JSON.stringify(e)).join("\n") + "\n" });
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U1"]).out, /U1\tusage_limit\tresets_at=/);
  p.orch("unit", "set", "U1", "--state", "in-progress");
  seedExit(p, "U1", { jsonl: [{ type: "turn.failed" }, { type: "item.completed", item: { type: "error" } }].map((e) => JSON.stringify(e)).join("\n") + "\n" });
  assert.match(p.worker(["exit", "--store", p.store, "--unit", "U1"]).out, /U1\tcrash/);
});

test("harness lib: pick, models, prompts and Codex text", async () => {
  const h = await import("../../gates/lib/harness.mjs");
  assert.equal(h.pickHarness({}, {}), "claude");
  assert.equal(h.pickHarness({}, { CODEX_THREAD_ID: "t" }), "codex");
  assert.equal(h.pickHarness({ harness: "codex" }, {}), "codex");
  assert.equal(h.pickHarness({ harness: "codex" }, { CSTACK_HARNESS: "claude" }), "claude");
  assert.throws(() => h.pickHarness({ harness: "gemini" }, {}), /unknown harness 'gemini'/);
  assert.equal(h.codexModel({}, "judge"), "gpt-6-astra");
  assert.equal(h.codexModel({ models_codex: { judge: "gpt-6.1-sol" } }, "judge"), "gpt-6.1-sol");
  assert.equal(h.skillPrompt("claude", "/cstack:unit 3"), "/cstack:unit 3");
  assert.equal(h.skillPrompt("codex", "/cstack:unit 3"), "$cstack:unit 3");
  assert.equal(h.codexText([{ type: "error" }, null, { type: "item.completed", item: { type: "agent_message" } }]), "");
});
