// Tests for the host supervisor: gates/lib/supervisor.mjs, gates/runner.mjs and gates/supervise.mjs.
// launchctl, schtasks, taskkill, systemctl, systemd-run and claude are fakes from tests/fixtures/bin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_BIN, GATES, gate, makeRepo } from "./helpers.mjs";

const RUNNER = path.join(GATES, "runner.mjs");
// A pid that exists but belongs to another user: init on POSIX, the System process on Windows.
const OTHER_PID = process.platform === "win32" ? 4 : 1;
const posix = { skip: process.platform === "win32" && "uses sh and POSIX signals" };

// A fresh registry and log files per test; the supervisor module reads its env on every call.
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-sup-"));
  const env = {
    CSTACK_SESSIONS_DIR: path.join(dir, "sessions"),
    FAKE_LAUNCHCTL_LOG: path.join(dir, "launchctl.log"),
    FAKE_SCHTASKS_LOG: path.join(dir, "schtasks.log"),
    FAKE_TASKKILL_LOG: path.join(dir, "taskkill.log"),
    FAKE_SYSTEMCTL_LOG: path.join(dir, "systemctl.log"),
    FAKE_SYSTEMD_RUN_LOG: path.join(dir, "systemd-run.log"),
    FAKE_CLAUDE_LOG: path.join(dir, "claude.log"),
  };
  const calls = (k) => (existsSync(env[k]) ? readFileSync(env[k], "utf8").trim().split("\n").filter(Boolean) : []);
  const sup = (args, extra = {}) => gate("supervise.mjs", args, { env: { ...env, ...extra } });
  const entry = (name) => JSON.parse(readFileSync(path.join(env.CSTACK_SESSIONS_DIR, `${name}.json`), "utf8"));
  const setEntry = (name, e) => {
    mkdirSync(env.CSTACK_SESSIONS_DIR, { recursive: true });
    writeFileSync(path.join(env.CSTACK_SESSIONS_DIR, `${name}.json`), JSON.stringify(e));
  };
  return { dir, env, calls, sup, entry, setEntry };
}

// Runs a snippet against the supervisor module in a child, so its env and PATH apply.
function lib(s, code, extra = {}) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import * as sup from ${JSON.stringify(pathToFileURL(path.join(GATES, "lib/supervisor.mjs")).href)};\n${code}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, CSTACK_SUPERVISOR: "", ...s.env, ...extra },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test("pickBackend: env, then config, then platform", () => {
  const s = sandbox();
  const pick = (cfg, platform, extra) => lib(s, `console.log(sup.pickBackend(${JSON.stringify(cfg)}, ${JSON.stringify(platform)}))`, extra);
  assert.equal(pick({}, "darwin"), "launchd");
  assert.equal(pick({}, "win32"), "taskscheduler");
  assert.equal(pick({}, "linux"), "systemd");
  assert.equal(pick({}, "linux", { FAKE_SYSTEMCTL_NO_USER: "1" }), "detached");
  assert.equal(pick({}, "freebsd"), "detached");
  assert.equal(pick({ host: { supervisor: "detached" } }, "darwin"), "detached");
  assert.equal(pick({ host: { supervisor: "auto" } }, "win32"), "taskscheduler");
  assert.equal(pick({ host: { supervisor: "detached" } }, "darwin", { CSTACK_SUPERVISOR: "launchd" }), "launchd");
  assert.equal(lib(s, `try { sup.pickBackend({ host: { supervisor: "cron" } }) } catch (e) { console.log(e.message) }`), "unknown supervisor 'cron' (use systemd, launchd, taskscheduler, detached or auto)");
});

test("sessionState reads the registry, and falls back to systemctl", () => {
  const s = sandbox();
  const state = (name) => lib(s, `console.log(JSON.stringify(sup.sessionState(${JSON.stringify(name)})))`);
  const now = new Date().toISOString();
  s.setEntry("ok", { backend: "detached", pid: 1, exited: now, code: 0 });
  s.setEntry("bad", { backend: "detached", pid: 1, exited: now, code: 4 });
  s.setEntry("live", { backend: "launchd", pid: process.pid });
  s.setEntry("dead", { backend: "detached", pid: 999999999 });
  s.setEntry("new", { backend: "taskscheduler", requested: now });
  s.setEntry("stale", { backend: "detached", requested: "2020-01-01T00:00:00Z" });
  s.setEntry("sd", { backend: "systemd" });
  assert.deepEqual(JSON.parse(state("ok")), { state: "inactive", alive: false });
  assert.deepEqual(JSON.parse(state("bad")), { state: "failed", alive: false });
  assert.deepEqual(JSON.parse(state("live")), { state: "active", alive: true });
  assert.deepEqual(JSON.parse(state("dead")), { state: "failed", alive: false });
  assert.deepEqual(JSON.parse(state("new")), { state: "activating", alive: true });
  assert.deepEqual(JSON.parse(state("stale")), { state: "failed", alive: false });
  assert.deepEqual(JSON.parse(state("sd")), { state: "inactive", alive: false });
  assert.deepEqual(JSON.parse(state("none")), { state: "inactive", alive: false }, "no entry: systemctl says");
  assert.deepEqual(JSON.parse(lib(s, `console.log(JSON.stringify(sup.sessionState("x")))`, { PATH: "/nonexistent" })), { state: "unknown", alive: false });
  assert.equal(lib(s, `console.log(sup.pidAlive(0), sup.pidAlive(1.5), sup.pidAlive(${OTHER_PID}))`), "false false true");
  assert.equal(lib(s, `console.log(sup.readEntry("missing"), sup.sessionsDir() === process.env.CSTACK_SESSIONS_DIR)`), "null true");
  assert.match(lib(s, `console.log(sup.sessionsDir())`, { CSTACK_SESSIONS_DIR: "" }), /\.local[\\/]state[\\/]cstack[\\/]sessions$/);
});

test("runner: output, registry, onExit with systemd's exit variables", posix, () => {
  const s = sandbox();
  const out = path.join(s.dir, "out.log");
  const err = path.join(s.dir, "err.log");
  const exitFile = path.join(s.dir, "exit.txt");
  const spec = path.join(s.dir, "spec.json");
  const onExit = ["sh", "-c", `echo "$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS $KEEP $DROP" > ${exitFile}`];
  writeFileSync(spec, JSON.stringify({ name: "r1", backend: "detached", argv: ["sh", "-c", "echo out; echo err >&2; exit 3"], cwd: s.dir, env: { KEEP: "k" }, unset: ["DROP"], stdout: out, stderr: err, onExit }));
  const r = spawnSync(process.execPath, [RUNNER, spec], { env: { ...process.env, ...s.env, DROP: "d" }, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(readFileSync(out, "utf8"), "out\n");
  assert.equal(readFileSync(err, "utf8"), "err\n");
  assert.equal(readFileSync(exitFile, "utf8").trimEnd(), "exit-code exited 3 k", "KEEP set, DROP unset");
  const e = s.entry("r1");
  assert.equal(e.code, 3);
  assert.ok(e.exited && e.pid && e.child);

  writeFileSync(spec, JSON.stringify({ name: "r2", backend: "detached", argv: ["true"], cwd: s.dir, onExit }));
  assert.equal(spawnSync(process.execPath, [RUNNER, spec], { env: { ...process.env, ...s.env } }).status, 0);
  assert.equal(readFileSync(exitFile, "utf8").trimEnd(), "success exited 0");

  writeFileSync(spec, JSON.stringify({ name: "r3", backend: "detached", argv: ["/no/such/cmd"], cwd: s.dir, stderr: err }));
  assert.equal(spawnSync(process.execPath, [RUNNER, spec], { env: { ...process.env, ...s.env } }).status, 127);
  assert.match(readFileSync(err, "utf8"), /runner: cannot start \/no\/such\/cmd/);

  writeFileSync(spec, "{}");
  const bad = spawnSync(process.execPath, [RUNNER, spec], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad spec .*spec needs name and argv/);
  assert.equal(spawnSync(process.execPath, [RUNNER]).status, 2);
});

test("runner forwards SIGTERM and still runs onExit", posix, async () => {
  const s = sandbox();
  const exitFile = path.join(s.dir, "exit.txt");
  const spec = path.join(s.dir, "spec.json");
  writeFileSync(spec, JSON.stringify({ name: "sig", backend: "detached", argv: ["sleep", "30"], cwd: s.dir, onExit: ["sh", "-c", `echo "$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS" > ${exitFile}`] }));
  const child = spawn(process.execPath, [RUNNER, spec], { env: { ...process.env, ...s.env } });
  while (!existsSync(path.join(s.env.CSTACK_SESSIONS_DIR, "sig.json"))) await new Promise((r) => setTimeout(r, 20));
  child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 1);
  assert.equal(readFileSync(exitFile, "utf8"), "signal killed SIGTERM\n");
  assert.equal(s.entry("sig").signal, "SIGTERM");
});

test("resolveCommand finds Windows .cmd shims and quotes for cmd.exe", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-win-"));
  writeFileSync(path.join(dir, "claude.cmd"), "");
  writeFileSync(path.join(dir, "tool.exe"), "");
  const code = `import { resolveCommand, exitVars } from ${JSON.stringify(pathToFileURL(RUNNER).href)};
const env = { PATH: ${JSON.stringify(dir)}, PATHEXT: ".EXE;.CMD" };
console.log(JSON.stringify([
  resolveCommand(["claude", "-p", "say \\"hi\\" 100%"], env, "win32"),
  resolveCommand(["tool", "a b"], env, "win32"),
  resolveCommand(["C:/x/run.bat"], { ComSpec: "C:/Windows/cmd.exe" }, "win32"),
  resolveCommand(["missing"], {}, "win32"),
  resolveCommand(["claude", "x"], env, "linux"),
  exitVars(0, null), exitVars(2, null), exitVars(null, "SIGKILL"),
]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [cmd, exe, bat, missing, linux, ok, failed, killed] = JSON.parse(r.stdout);
  assert.equal(cmd.file, "cmd.exe");
  assert.equal(cmd.verbatim, true);
  assert.deepEqual(cmd.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(cmd.args[3], `""${path.join(dir, "claude.cmd")}" "-p" "say ""hi"" 100%%""`);
  assert.deepEqual(exe, { file: path.join(dir, "tool.exe"), args: ["a b"], verbatim: false });
  assert.equal(bat.file, "C:/Windows/cmd.exe");
  assert.deepEqual(missing, { file: "missing", args: [], verbatim: false });
  assert.deepEqual(linux, { file: "claude", args: ["x"], verbatim: false });
  assert.deepEqual([ok, failed, killed], [
    { SERVICE_RESULT: "success", EXIT_CODE: "exited", EXIT_STATUS: "0" },
    { SERVICE_RESULT: "exit-code", EXIT_CODE: "exited", EXIT_STATUS: "2" },
    { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "SIGKILL" },
  ]);
});

test("startRunner: launchd bootstraps a plist, Task Scheduler creates and runs a task", () => {
  const s = sandbox();
  const spec = path.join(s.dir, "w.spec.json");
  writeFileSync(spec, "{}");
  const start = (backend, extra) => lib(s, `console.log(JSON.stringify(sup.startRunner(${JSON.stringify(backend)}, "cstack-r-s-U1", ${JSON.stringify(spec)}, { cwd: ${JSON.stringify(s.dir)} })))`, extra);
  assert.equal(JSON.parse(start("launchd")).code, 0);
  const plist = readFileSync(path.join(s.dir, "w.spec.plist"), "utf8");
  assert.match(plist, /<key>Label<\/key><string>dev\.cstack\.cstack-r-s-U1<\/string>/);
  assert.match(plist, /<string>[^<]*runner\.mjs<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  const lc = s.calls("FAKE_LAUNCHCTL_LOG").map((l) => JSON.parse(l));
  assert.match(lc[0].join(" "), /^bootout gui\/\d+\/dev\.cstack\.cstack-r-s-U1$/);
  assert.equal(lc[1][0], "bootstrap");
  assert.equal(lc[1][2], path.join(s.dir, "w.spec.plist"));
  assert.equal(s.entry("cstack-r-s-U1").backend, "launchd");

  assert.equal(JSON.parse(start("taskscheduler")).code, 0);
  const cmd = readFileSync(path.join(s.dir, "w.spec.cmd"), "utf8");
  assert.match(cmd, /^@echo off\r\ncd \/d ".*"\r\n".*node.*" ".*runner\.mjs" ".*w\.spec\.json"\r\n$/);
  const st = s.calls("FAKE_SCHTASKS_LOG").map((l) => JSON.parse(l));
  assert.deepEqual(st[0].slice(0, 3), ["/Create", "/TN", "cstack\\cstack-r-s-U1"]);
  assert.ok(st[0].includes("ONCE") && st[0].includes("/F"));
  assert.deepEqual(st[1], ["/Run", "/TN", "cstack\\cstack-r-s-U1"]);
  assert.equal(JSON.parse(start("taskscheduler", { FAKE_SCHTASKS_CODE: "1" })).code, 1, "a failed /Create stops there");
  assert.equal(s.calls("FAKE_SCHTASKS_LOG").length, 3);
  assert.equal(s.entry("cstack-r-s-U1").startFailed, true);
  assert.equal(lib(s, `console.log(sup.sessionState("cstack-r-s-U1").state)`), "failed", "a failed start does not read as starting");
  assert.match(lib(s, `try { sup.startRunner("systemd", "n", "f.json", {}) } catch (e) { console.log(e.message) }`), /does not handle backend 'systemd'/);
});

test("stopSession: per backend; listSessions by prefix", () => {
  const s = sandbox();
  s.setEntry("cstack-a-1", { backend: "launchd", pid: 999999999 });
  s.setEntry("cstack-a-2", { backend: "taskscheduler", pid: process.pid });
  s.setEntry("other", { backend: "detached" });
  assert.equal(lib(s, `console.log(JSON.stringify(sup.listSessions("cstack-a-")))`), '["cstack-a-1","cstack-a-2"]');
  assert.equal(lib(s, `console.log(sup.listSessions().length)`), "3");
  lib(s, `sup.stopSession("cstack-a-1"); sup.stopSession("cstack-a-2", "win32"); sup.stopSession("other"); sup.stopSession("nope")`);
  assert.match(s.calls("FAKE_LAUNCHCTL_LOG")[0], /"bootout","gui\/\d+\/dev\.cstack\.cstack-a-1"/);
  assert.equal(s.calls("FAKE_SCHTASKS_LOG")[0], '["/End","/TN","cstack\\\\cstack-a-2"]');
  assert.equal(s.calls("FAKE_TASKKILL_LOG")[0], `["/PID","${process.pid}","/T"]`);
  assert.equal(s.calls("FAKE_SYSTEMCTL_LOG")[0], "--user stop nope");
  const empty = sandbox();
  assert.equal(lib(empty, `console.log(sup.listSessions().length)`), "0");
});

test("supervise start, status, wait and stop with the detached backend", posix, async () => {
  const s = sandbox();
  const env = { CSTACK_SUPERVISOR: "detached" };
  const logs = path.join(s.dir, "logs");
  const started = s.sup(["start", "--name", "d1", "--cwd", s.dir, "--log-dir", logs, "--", "sh", "-c", "echo hi; sleep 0.3"], env);
  assert.equal(started.code, 0, started.err);
  assert.equal(started.out.trim(), "started d1 via detached");
  assert.match(s.sup(["status", "d1"]).out, /^(activating|active)\n$/);
  const waited = s.sup(["wait", "d1", "--interval-ms", "50"]);
  assert.equal(waited.out.trim(), "ended inactive");
  assert.equal(readFileSync(path.join(logs, "d1.out.log"), "utf8"), "hi\n");

  s.sup(["start", "--name", "d2", "--cwd", s.dir, "--log-dir", logs, "--", "sleep", "30"], env);
  const timeout = s.sup(["wait", "d2", "--timeout", "0.3", "--interval-ms", "50"]);
  assert.equal(timeout.code, 3);
  assert.equal(timeout.out.trim(), "timeout: 0.3s");
  assert.equal(s.sup(["stop", "d*"]).out.trim(), "stopped 2 registered session(s) matching d*");
  assert.equal(s.sup(["wait", "d2", "--interval-ms", "50"]).out.trim(), "ended failed");
  assert.equal(s.sup(["stop", "d1"]).out.trim(), "stopped d1");
});

test("supervise start under systemd, launchd and Task Scheduler", () => {
  const s = sandbox();
  const logs = path.join(s.dir, "logs");
  const go = (backend, extra = {}) => s.sup(["start", "--name", "cstack-e2e-x", "--cwd", s.dir, "--log-dir", logs, "--", "node", "a.mjs"], { CSTACK_SUPERVISOR: backend, ...extra });
  s.setEntry("cstack-e2e-x", { backend: "detached", pid: 1, exited: new Date().toISOString(), code: 0 });
  assert.equal(go("systemd").code, 0);
  assert.equal(existsSync(path.join(s.env.CSTACK_SESSIONS_DIR, "cstack-e2e-x.json")), false, "a stale entry from another backend is cleared (cstack#30)");
  const sd = JSON.parse(s.calls("FAKE_SYSTEMD_RUN_LOG")[0]);
  assert.ok(sd.includes("--unit=cstack-e2e-x") && sd.includes(`--property=StandardOutput=append:${path.join(logs, "cstack-e2e-x.out.log")}`));
  assert.deepEqual(sd.slice(-2), ["node", "a.mjs"]);
  assert.equal(go("launchd").out.trim(), "started cstack-e2e-x via launchd");
  assert.deepEqual(JSON.parse(readFileSync(path.join(logs, "cstack-e2e-x.spec.json"), "utf8")).argv, ["node", "a.mjs"]);
  assert.equal(go("taskscheduler").code, 0);
  const failed = go("taskscheduler", { FAKE_SCHTASKS_CODE: "1" });
  assert.equal(failed.code, 2);
  assert.match(failed.err, /taskscheduler start failed \(1\): fake schtasks failed/);
});

test("supervise usage errors and backend", () => {
  const s = sandbox();
  for (const args of [[], ["bogus"], ["status"], ["start", "--name", "x"], ["wait"], ["wait", "x", "--timeout", "0"], ["stop"], ["status", "a", "b"], ["daemon-file"], ["daemon-run"]]) {
    assert.equal(s.sup(args).code, 2, args.join(" "));
  }
  assert.equal(s.sup(["backend"], { CSTACK_SUPERVISOR: "launchd" }).out.trim(), "launchd");
  const r = makeRepo({ host: { supervisor: "detached" } });
  assert.equal(s.sup(["backend", "--repo-dir", r.root]).out.trim(), "detached");
  const auto = { darwin: "launchd", win32: "taskscheduler" }[process.platform] ?? "systemd";
  assert.equal(s.sup(["backend", "--repo-dir", path.join(s.dir, "no-repo")]).out.trim(), auto, "no config: auto");
});

test("daemon-file per backend, and daemon-run writes the allowlist then runs claude", () => {
  const s = sandbox();
  const r = makeRepo();
  const file = (backend) => s.sup(["daemon-file", "--repo-dir", r.root], { CSTACK_SUPERVISOR: backend });
  assert.match(file("systemd").out, /cstack-daemon@\.service/);
  const mac = file("launchd");
  assert.match(mac.out, /launchctl bootstrap gui\/\$\(id -u\)/);
  const plist = readFileSync(path.join(r.root, ".cstack/daemon/dev.cstack.cstack-daemon-repo.plist"), "utf8");
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>600<\/integer>/);
  assert.match(plist, /<string>daemon-run<\/string>/);
  const win = file("taskscheduler");
  assert.match(win.out, /schtasks \/Create \/TN "cstack\\cstack-daemon-repo" .* \/SC MINUTE \/MO 10 \/F/);
  assert.match(readFileSync(path.join(r.root, ".cstack/daemon/cstack-daemon-repo.cmd"), "utf8"), /daemon-run.*>> ".*daemon\.log" 2>&1/);
  assert.match(file("detached").out, /cannot survive a logout or reboot/);

  const run = s.sup(["daemon-run", "--repo-dir", r.root], { ANTHROPIC_API_KEY: "sk-test", CSTACK_PROGRAM_AUTONOMY: "send" });
  assert.equal(run.code, 0, run.err);
  assert.ok(existsSync(path.join(r.root, ".cstack/permissions/coordinator.json")));
  const argv = JSON.parse(s.calls("FAKE_CLAUDE_LOG")[0]);
  assert.deepEqual(argv.slice(0, 2), ["-p", "--output-format"]);
  assert.equal(argv.at(-1), "/loop 10m /cstack:daemon");
  assert.equal(s.sup(["daemon-run", "--repo-dir", path.join(s.dir, "nowhere")]).code, 2, "run-settings fails without a configured repo");
  assert.equal(s.sup(["daemon-run", "--repo-dir", r.root], { FAKE_CLAUDE_CODE: "5" }).code, 1, "a failed session exits 1");
});
