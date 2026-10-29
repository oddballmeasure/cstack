// Host supervisor: detached sessions that outlive the session that starts them, on any OS (ADR-011).
// Backends, picked by CSTACK_SUPERVISOR, else config host.supervisor, else by platform:
//   systemd        Linux with a user manager. gates/worker.mjs keeps its own systemd-run launch for these.
//   launchd        macOS. A plist next to the spec, loaded with `launchctl bootstrap gui/<uid>`.
//   taskscheduler  Windows. A one-shot task `cstack\<name>` that runs a .cmd wrapper.
//   detached       any OS: a detached child process. Ends with the machine; no daemon.
// Every backend but systemd runs gates/runner.mjs with a spec file. The runner starts the command, writes
// its output to the spec's files, records itself in the session registry (sessions/<name>.json) and runs the
// spec's onExit command when the command ends. Liveness reads the registry: the runner's pid, then its exit
// record. A name with no registry entry falls back to `systemctl --user is-active`, which is how systemd
// sessions are seen.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run, UsageError } from "./common.mjs";

export const BACKENDS = ["systemd", "launchd", "taskscheduler", "detached"];
export const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../runner.mjs");
const SYSTEMD_ALIVE = new Set(["active", "activating", "reloading", "deactivating"]);
// A session whose runner has not written its pid yet counts as starting for this long.
const START_GRACE_MS = 60_000;

export function sessionsDir() {
  return process.env.CSTACK_SESSIONS_DIR || path.join(os.homedir(), ".local", "state", "cstack", "sessions");
}

const entryFile = (name) => path.join(sessionsDir(), `${name}.json`);

export function readEntry(name) {
  try {
    return JSON.parse(readFileSync(entryFile(name), "utf8"));
  } catch {
    return null;
  }
}

export function writeEntry(name, entry) {
  mkdirSync(sessionsDir(), { recursive: true });
  writeFileSync(entryFile(name), `${JSON.stringify(entry, null, 2)}\n`);
}

// A systemd session has no registry entry, so an entry left by an earlier session of the same name under another
// backend would shadow it (cstack#30). Every systemd start clears it first.
export function clearEntry(name) {
  rmSync(entryFile(name), { force: true });
}

export function pickBackend(config = {}, platform = process.platform) {
  const chosen = process.env.CSTACK_SUPERVISOR || config.host?.supervisor || "auto";
  if (chosen !== "auto") {
    if (!BACKENDS.includes(chosen)) throw new UsageError(`unknown supervisor '${chosen}' (use ${BACKENDS.join(", ")} or auto)`);
    return chosen;
  }
  if (platform === "darwin") return "launchd";
  if (platform === "win32") return "taskscheduler";
  if (platform === "linux" && run("systemctl", ["--user", "show-environment"]).code === 0) return "systemd";
  return "detached";
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// { state, alive } in systemd's words, for every backend.
export function sessionState(name, now = Date.now()) {
  const e = readEntry(name);
  if (!e || e.backend === "systemd") {
    const r = run("systemctl", ["--user", "is-active", name]);
    const state = r.stdout.trim() || "unknown";
    return { state, alive: SYSTEMD_ALIVE.has(state) };
  }
  if (e.exited) return { state: e.code === 0 ? "inactive" : "failed", alive: false };
  if (e.pid) return pidAlive(e.pid) ? { state: "active", alive: true } : { state: "failed", alive: false };
  return now - Date.parse(e.requested) < START_GRACE_MS ? { state: "activating", alive: true } : { state: "failed", alive: false };
}

export const launchdLabel = (name) => `dev.cstack.${name}`;
export const taskName = (name) => `cstack\\${name}`;
// launchd runs on macOS only, where process.getuid exists.
/* node:coverage disable */
const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
/* node:coverage enable */

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function plist({ label, argv, cwd, keepAlive = false, stdout = null, stderr = null }) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argv.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    `  <key>WorkingDirectory</key><string>${xml(cwd)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    `  <key>KeepAlive</key>${keepAlive ? "<true/>" : "<false/>"}`,
    ...(stdout ? [`  <key>StandardOutPath</key><string>${xml(stdout)}</string>`] : []),
    ...(stderr ? [`  <key>StandardErrorPath</key><string>${xml(stderr)}</string>`] : []),
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

// cmd.exe quoting for one argument of a .cmd line: double quotes, inner quotes doubled, % escaped.
export const cmdQuote = (s) => `"${String(s).replace(/"/g, '""').replace(/%/g, "%%")}"`;

// Starts gates/runner.mjs with specFile under a non-systemd backend and returns once it is handed off.
// A start that fails is recorded as exited, so it does not read as starting.
export function startRunner(backend, name, specFile, { cwd }) {
  const entry = { name, backend, requested: new Date().toISOString(), spec: specFile };
  writeEntry(name, entry);
  const r = handOff(backend, name, specFile, cwd);
  if (r.code !== 0) writeEntry(name, { ...entry, exited: new Date().toISOString(), code: r.code, startFailed: true });
  return r;
}

function handOff(backend, name, specFile, cwd) {
  const runnerArgv = [process.execPath, RUNNER, specFile];
  if (backend === "detached") {
    const child = spawn(runnerArgv[0], runnerArgv.slice(1), { cwd, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return { code: 0, stderr: "" };
  }
  if (backend === "launchd") {
    const file = specFile.replace(/\.json$/, "") + ".plist";
    writeFileSync(file, plist({ label: launchdLabel(name), argv: runnerArgv, cwd }));
    run("launchctl", ["bootout", `gui/${uid()}/${launchdLabel(name)}`]);
    return run("launchctl", ["bootstrap", `gui/${uid()}`, file]);
  }
  if (backend === "taskscheduler") {
    const file = specFile.replace(/\.json$/, "") + ".cmd";
    writeFileSync(file, `@echo off\r\ncd /d ${cmdQuote(cwd)}\r\n${runnerArgv.map(cmdQuote).join(" ")}\r\n`);
    const created = run("schtasks", ["/Create", "/TN", taskName(name), "/TR", cmdQuote(file), "/SC", "ONCE", "/ST", "23:59", "/F"]);
    if (created.code !== 0) return created;
    return run("schtasks", ["/Run", "/TN", taskName(name)]);
  }
  throw new Error(`startRunner does not handle backend '${backend}'`);
}

// Stops a session: the runner forwards the signal to its command, then runs onExit.
export function stopSession(name, platform = process.platform) {
  const e = readEntry(name);
  if (!e || e.backend === "systemd") return run("systemctl", ["--user", "stop", name]);
  if (e.backend === "launchd") run("launchctl", ["bootout", `gui/${uid()}/${launchdLabel(name)}`]);
  if (e.backend === "taskscheduler") run("schtasks", ["/End", "/TN", taskName(name)]);
  if (e.pid && pidAlive(e.pid)) {
    if (platform === "win32") return run("taskkill", ["/PID", String(e.pid), "/T"]);
    process.kill(e.pid, "SIGTERM");
  }
  return { code: 0, stdout: "", stderr: "" };
}

// Names in the registry that start with prefix, for `stop cstack-<repo>-<slug>-*` style cleanup.
export function listSessions(prefix = "") {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f.startsWith(prefix))
    .map((f) => f.slice(0, -5))
    .sort();
}
