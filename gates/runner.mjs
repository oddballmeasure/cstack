#!/usr/bin/env node
// Portable session runner for the host supervisor (gates/lib/supervisor.mjs). Every backend but
// systemd starts `node runner.mjs <spec.json>`. Spec:
//   { "name", "backend", "argv": [cmd, ...args], "cwd", "env": {k: v}, "unset": [k],
//     "stdout": file, "stderr": file, "onExit": [cmd, ...args] | null }
// It appends the command's output to the two files, records itself in the session registry, forwards
// SIGTERM, SIGINT and SIGHUP to the command, and when the command ends records the exit and runs onExit
// with systemd's exit variables (SERVICE_RESULT, EXIT_CODE, EXIT_STATUS), as ExecStopPost would.
// A runner that is killed outright records nothing; liveness then reads its dead pid as `failed`.
// Exit: the command's exit code, 1 when it died by a signal, 2 on a bad spec.
import { openSync, readFileSync, existsSync, writeSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readEntry, writeEntry, cmdQuote } from "./lib/supervisor.mjs";

// On Windows, `claude` and `codex` are .cmd shims that only cmd.exe can run. Find the file through PATH and
// PATHEXT, and wrap .cmd and .bat in `cmd.exe /d /s /c` with every argument quoted.
export function resolveCommand(argv, env, platform = process.platform) {
  if (platform !== "win32") return { file: argv[0], args: argv.slice(1), verbatim: false };
  let file = argv[0];
  if (!path.extname(file) && !path.isAbsolute(file)) {
    const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const dirs = (env.PATH || env.Path || "").split(";").filter(Boolean);
    file = dirs.flatMap((d) => exts.map((e) => path.join(d, file + e.toLowerCase()))).find(existsSync) ?? file;
  }
  if (/\.(cmd|bat)$/i.test(file)) {
    return { file: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${[file, ...argv.slice(1)].map(cmdQuote).join(" ")}"`], verbatim: true };
  }
  return { file, args: argv.slice(1), verbatim: false };
}

export function exitVars(code, signal) {
  if (signal) return { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: signal };
  return { SERVICE_RESULT: code === 0 ? "success" : "exit-code", EXIT_CODE: "exited", EXIT_STATUS: String(code) };
}

function main(specFile) {
  let spec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8"));
    if (!spec.name || !Array.isArray(spec.argv) || !spec.argv.length) throw new Error("spec needs name and argv");
  } catch (err) {
    process.stderr.write(`runner: bad spec ${specFile}: ${err.message}\n`);
    process.exit(2);
  }
  const env = { ...process.env, ...(spec.env || {}) };
  for (const k of spec.unset || []) delete env[k];
  const out = spec.stdout ? openSync(spec.stdout, "a") : "ignore";
  const err = spec.stderr ? openSync(spec.stderr, "a") : "ignore";
  const cmd = resolveCommand(spec.argv, env);
  const child = spawn(cmd.file, cmd.args, { cwd: spec.cwd, env, stdio: ["ignore", out, err], windowsHide: true, windowsVerbatimArguments: cmd.verbatim });
  // Forward signals before the registry entry announces this pid, so a stop never finds the runner unprepared.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => child.kill(sig));
  const entry = { ...(readEntry(spec.name) || {}), name: spec.name, backend: spec.backend, pid: process.pid, child: child.pid ?? null, started: new Date().toISOString(), spec: path.resolve(specFile) };
  delete entry.exited;
  writeEntry(spec.name, entry);
  let done = false;
  const finish = (code, signal) => {
    // A command that fails to start can emit both error and exit; record and run onExit once.
    /* node:coverage disable */
    if (done) return;
    /* node:coverage enable */
    done = true;
    writeEntry(spec.name, { ...entry, exited: new Date().toISOString(), code, signal });
    if (spec.onExit?.length) {
      spawnSync(spec.onExit[0], spec.onExit.slice(1), { cwd: spec.cwd, env: { ...env, ...exitVars(code, signal) }, stdio: ["ignore", out, err], windowsHide: true });
    }
    process.exit(signal ? 1 : code);
  };
  child.on("error", (e) => {
    if (typeof err === "number") writeSync(err, `runner: cannot start ${spec.argv[0]}: ${e.message}\n`);
    finish(127, null);
  });
  child.on("exit", finish);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    process.stderr.write("usage: runner.mjs <spec.json>\n");
    process.exit(2);
  }
  main(process.argv[2]);
}
