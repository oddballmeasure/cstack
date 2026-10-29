#!/usr/bin/env node
// One cross-platform CLI over the host supervisor (gates/lib/supervisor.mjs, ADR-011). Skills use it
// instead of systemd-run, systemctl and journalctl.
// Usage:
//   supervise.mjs backend [--repo-dir <d>]                     the backend in use: systemd, launchd, taskscheduler, detached
//   supervise.mjs status <name>                                its state in systemd's words: active, activating, failed, inactive, ...
//   supervise.mjs start --name <n> --cwd <d> --log-dir <d> [--repo-dir <d>] -- <cmd> [args...]
//                                                              start a detached session; output goes to <log-dir>/<n>.out.log and .err.log
//   supervise.mjs wait <name> [--timeout <s>] [--interval-ms 5000]
//                                                              block until the session ends: `ended <state>`, exit 0;
//                                                              `timeout: <s>s`, exit 3, while it still runs
//   supervise.mjs stop <name>|<prefix>*                        stop one session, or every session whose name starts with prefix
//   supervise.mjs daemon-file --repo-dir <d> [--plugin-dir <d>] [--out <dir>]
//                                                              write the daemon's service file for this host and print how to install it
//   supervise.mjs daemon-run --repo-dir <d> [--plugin-dir <d>] the daemon's own command: coordinator allowlist, then `claude -p "/loop 10m /cstack:daemon"`;
//                                                              exit 0 when claude exits 0, else 1
// Exit 0 on success, 3 on a wait timeout, 2 on usage errors or a failed start.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";
import { resolveCommand } from "./runner.mjs";
import { clearEntry, cmdQuote, launchdLabel, listSessions, pickBackend, plist, sessionState, startRunner, stopSession } from "./lib/supervisor.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);

function configFrom(dir) {
  try {
    return loadConfig(path.resolve(dir || process.cwd())).config;
  } catch {
    return {};
  }
}

function start(args, argv) {
  const { name, cwd } = args;
  const logDir = args["log-dir"];
  if (!name || !cwd || !logDir || !argv.length) throw new UsageError("usage: supervise.mjs start --name <n> --cwd <d> --log-dir <d> -- <cmd> [args...]");
  const backend = pickBackend(configFrom(args["repo-dir"] || cwd));
  mkdirSync(logDir, { recursive: true });
  const out = path.join(path.resolve(logDir), `${name}.out.log`);
  const err = path.join(path.resolve(logDir), `${name}.err.log`);
  let r;
  if (backend === "systemd") {
    clearEntry(name);
    r = run("systemd-run", ["--user", "--collect", "--quiet", `--unit=${name}`, `--working-directory=${path.resolve(cwd)}`, `--property=StandardOutput=append:${out}`, `--property=StandardError=append:${err}`, ...argv]);
  } else {
    const specFile = path.join(path.resolve(logDir), `${name}.spec.json`);
    writeFileSync(specFile, `${JSON.stringify({ name, backend, argv, cwd: path.resolve(cwd), env: {}, unset: [], stdout: out, stderr: err, onExit: null }, null, 2)}\n`);
    r = startRunner(backend, name, specFile, { cwd: path.resolve(cwd) });
  }
  if (r.code !== 0) throw new UsageError(`${backend} start failed (${r.code}): ${r.stderr.trim()}`);
  say(`started ${name} via ${backend}`);
  return 0;
}

async function wait(name, args) {
  const timeout = args.timeout === undefined ? null : Number(args.timeout);
  const interval = Number(args["interval-ms"] ?? 5000);
  if (!name || (timeout !== null && !(timeout > 0)) || !(interval > 0)) throw new UsageError("usage: supervise.mjs wait <name> [--timeout <s>] [--interval-ms n]");
  const started = Date.now();
  for (;;) {
    const s = sessionState(name);
    if (!s.alive) return say(`ended ${s.state}`), 0;
    if (timeout !== null && Date.now() - started >= timeout * 1000) return say(`timeout: ${timeout}s`), 3;
    await sleep(interval);
  }
}

function stop(target) {
  if (!target) throw new UsageError("usage: supervise.mjs stop <name>|<prefix>*");
  const prefix = target.endsWith("*") ? target.slice(0, -1) : null;
  const names = prefix === null ? [target] : listSessions(prefix);
  // systemd sessions have no registry entry: stop them by pattern too.
  if (prefix !== null) run("systemctl", ["--user", "stop", `${prefix}*`]);
  for (const n of names) stopSession(n);
  say(`stopped ${prefix === null ? target : `${names.length} registered session(s) matching ${target}`}`);
  return 0;
}

// The daemon's argv after the coordinator allowlist is written, shared by daemon-run and the service files.
function daemonClaude(repo, plugin) {
  return ["claude", "-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--plugin-dir", plugin, "--permission-mode", "dontAsk", "--settings", path.join(repo, ".cstack", "permissions", "coordinator.json"), "/loop 10m /cstack:daemon"];
}

function daemonRun(args) {
  if (!args["repo-dir"]) throw new UsageError("usage: supervise.mjs daemon-run --repo-dir <d> [--plugin-dir <d>]");
  const repo = path.resolve(args["repo-dir"]);
  const plugin = path.resolve(args["plugin-dir"] || PLUGIN_ROOT);
  const settings = spawnSync(process.execPath, [path.join(plugin, "gates", "run-settings.mjs"), "--permissions", "coordinator", "--repo-dir", repo, "--plugin-dir", plugin, "--out", path.join(repo, ".cstack", "permissions", "coordinator.json")], { stdio: "inherit" });
  if (settings.status !== 0) return 2;
  const env = { ...process.env, CSTACK_COORDINATOR: "1" };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CSTACK_PROGRAM_AUTONOMY"]) delete env[k];
  const cmd = resolveCommand(daemonClaude(repo, plugin), env);
  const r = spawnSync(cmd.file, cmd.args, { cwd: repo, env, stdio: "inherit", windowsVerbatimArguments: cmd.verbatim });
  return r.status === 0 ? 0 : 1;
}

function daemonFile(args) {
  if (!args["repo-dir"]) throw new UsageError("usage: supervise.mjs daemon-file --repo-dir <d> [--plugin-dir <d>] [--out <dir>]");
  const repo = path.resolve(args["repo-dir"]);
  const plugin = path.resolve(args["plugin-dir"] || PLUGIN_ROOT);
  const backend = pickBackend(configFrom(repo));
  const outDir = path.resolve(args.out || path.join(repo, ".cstack", "daemon"));
  const slug = path.basename(repo).replace(/[^A-Za-z0-9_.-]/g, "-");
  const name = `cstack-daemon-${slug}`;
  const runArgv = [process.execPath, path.join(plugin, "gates", "supervise.mjs"), "daemon-run", "--repo-dir", repo, "--plugin-dir", plugin];
  mkdirSync(outDir, { recursive: true });
  if (backend === "systemd") {
    say(`systemd: use the unit in ${path.join(plugin, "skills", "daemon", "references", "cstack-daemon@.service")} (see cstack:daemon).`);
    return 0;
  }
  if (backend === "launchd") {
    const file = path.join(outDir, `${launchdLabel(name)}.plist`);
    const log = path.join(repo, ".cstack", "daemon", "daemon.log");
    // KeepAlive restarts a session that ends; ThrottleInterval keeps a crash loop to one start per 10 minutes.
    writeFileSync(file, plist({ label: launchdLabel(name), argv: runArgv, cwd: repo, keepAlive: true, stdout: log, stderr: log }).replace("</dict>", "  <key>ThrottleInterval</key><integer>600</integer>\n</dict>"));
    say(`wrote ${file}`);
    say("install (runs while you are logged in):");
    say(`  cp "${file}" ~/Library/LaunchAgents/ && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${path.basename(file)}`);
    say(`remove: launchctl bootout gui/$(id -u)/${launchdLabel(name)} && rm ~/Library/LaunchAgents/${path.basename(file)}`);
    return 0;
  }
  if (backend === "taskscheduler") {
    const file = path.join(outDir, `${name}.cmd`);
    writeFileSync(file, `@echo off\r\ncd /d ${cmdQuote(repo)}\r\n${runArgv.map(cmdQuote).join(" ")} >> ${cmdQuote(path.join(repo, ".cstack", "daemon", "daemon.log"))} 2>&1\r\n`);
    say(`wrote ${file}`);
    say("install (starts at logon and is retried every 10 minutes; a running instance is left alone):");
    say(`  schtasks /Create /TN "cstack\\${name}" /TR ${cmdQuote(file)} /SC MINUTE /MO 10 /F`);
    say(`remove: schtasks /Delete /TN "cstack\\${name}" /F`);
    return 0;
  }
  say("detached: this host has no service manager cstack supports, so the daemon cannot survive a logout or reboot. Run it in a terminal:");
  say(`  ${runArgv.join(" ")}`);
  return 0;
}

main(async (argv) => {
  const dash = argv.indexOf("--");
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const cmdArgv = dash < 0 ? [] : argv.slice(dash + 1);
  const args = parseArgs(own, { options: ["name", "cwd", "log-dir", "repo-dir", "plugin-dir", "out", "timeout", "interval-ms"] });
  const [command, target, ...extra] = args._;
  if (extra.length) throw new UsageError(`unexpected arguments: ${extra.join(" ")}`);
  switch (command) {
    case "backend":
      say(pickBackend(configFrom(args["repo-dir"])));
      return 0;
    case "status":
      if (!target) throw new UsageError("usage: supervise.mjs status <name>");
      say(sessionState(target).state);
      return 0;
    case "start":
      return start(args, cmdArgv);
    case "wait":
      return wait(target, args);
    case "stop":
      return stop(target);
    case "daemon-file":
      return daemonFile(args);
    case "daemon-run":
      return daemonRun(args);
    default:
      throw new UsageError("usage: supervise.mjs backend|status|start|wait|stop|daemon-file|daemon-run ... (see the header)");
  }
});

