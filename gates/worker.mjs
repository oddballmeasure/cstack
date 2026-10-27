#!/usr/bin/env node
// Level B unit workers: one detached headless `claude -p` session per unit, under `systemd-run --user`.
// Usage:
//   worker.mjs launch --store <dir> --unit <id> [--plugin-dir <root>] [--wait] [--dry-run]
//   worker.mjs launch --store <dir> --coordinator [--resume] [--plugin-dir <root>] [--wait] [--dry-run]
//   worker.mjs exit   --store <dir> --unit <id>        (systemd ExecStopPost; also safe by hand)
//   worker.mjs next   --store <dir> [--json]           units to launch now, and units deferred by a usage limit
// launch is idempotent: a live worker is left alone. It marks the unit in-progress, records the launch
// in workers/<unit>.launches, and arranges for `exit` to run when the session ends for any reason,
// SIGKILL included. `exit` classifies the end and pushes one inbox entry (agent `worker`):
//   setup        the session billed through an API key
//   <state>      the unit reached merged, done, error, needs-human or pr-open
//   usage_limit  the subscription window ran out; the unit goes back to ready with workers/<unit>.not-before
//   crash        anything else
// --coordinator launches the run's coordinator instead (`/cstack:orchestrate --run <slug>`, or with --resume
// `/cstack:resume-run <slug>`) as cstack-<repo>-<slug>-coordinator with CSTACK_COORDINATOR=1, so the
// pending-work Stop hook applies to it. It has no exit hook and no unit row.
// The PATH comes from CSTACK_WORKER_PATH, else node's directory, ~/.local/bin and the system dirs.
// Exit 0 on success, 2 on usage or environment errors.
import { appendFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";
import { openStore } from "./lib/store.mjs";
import {
  IN_FLIGHT_STATES,
  TERMINAL_STATES,
  USAGE_LIMIT,
  launchCount,
  notBefore,
  parseReset,
  readText,
  workerFile,
  workerName,
  workerState,
} from "./lib/workers.mjs";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), "..");
const USAGE = "usage: worker.mjs launch|exit|next --store <dir> [--unit <id> | --coordinator [--resume]] [--plugin-dir <root>] [--wait] [--dry-run] [--json]";
const SETTLED = [...TERMINAL_STATES, "pr-open"];

// systemd command-line quoting for ExecStopPost: double quotes, C escapes, and doubled $ and %.
const quote = (s) => `"${String(s).replace(/[\\"]/g, "\\$&").replace(/\$/g, "$$$$").replace(/%/g, "%%")}"`;

function withStore(dir, fn) {
  const store = openStore(dir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function launch(store, unit, args) {
  const { root: repoRoot, config } = loadConfig(store);
  const coordinator = Boolean(args.coordinator);
  const id = coordinator ? "coordinator" : unit;
  const name = workerName(config.repo, store, id);
  const row = coordinator ? null : withStore(store, (s) => s.units.get(unit));
  if (workerState(name).alive) {
    process.stdout.write(`running ${name}\n`);
    return 0;
  }
  const slug = path.basename(store);
  const pluginDir = path.resolve(args["plugin-dir"] || PLUGIN_ROOT);
  const home = process.env.HOME;
  const PATH = process.env.CSTACK_WORKER_PATH || [path.dirname(process.execPath), `${home}/.local/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const prompt = coordinator
    ? args.resume
      ? `/cstack:resume-run ${slug}`
      : `/cstack:orchestrate --run ${slug}`
    : `/cstack:unit ${row.issue ? `${row.issue} ` : ""}--run ${slug} --unit ${unit}`;
  const role = coordinator
    ? ["--setenv=CSTACK_COORDINATOR=1"]
    : [`--setenv=CSTACK_UNIT=${unit}`, `--property=ExecStopPost=${[process.execPath, SELF, "exit", "--store", store, "--unit", unit].map(quote).join(" ")}`];
  const argv = [
    "--user",
    `--unit=${name}`,
    "--collect",
    "--quiet",
    ...(args.wait ? ["--wait"] : []),
    `--working-directory=${repoRoot}`,
    `--setenv=PATH=${PATH}`,
    `--setenv=HOME=${home}`,
    `--setenv=CSTACK_RUN=${slug}`,
    `--property=StandardOutput=truncate:${workerFile(store, id, "jsonl")}`,
    `--property=StandardError=truncate:${workerFile(store, id, "stderr.log")}`,
    ...role,
    "/usr/bin/env",
    "-u",
    "ANTHROPIC_API_KEY",
    "-u",
    "ANTHROPIC_AUTH_TOKEN",
    ...(coordinator ? [] : ["-u", "CSTACK_COORDINATOR"]),
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--plugin-dir",
    pluginDir,
    "--dangerously-skip-permissions",
    prompt,
  ];
  if (args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(["systemd-run", ...argv])}\n`);
    return 0;
  }
  mkdirSync(path.join(store, "workers"), { recursive: true });
  if (!coordinator) {
    rmSync(workerFile(store, unit, "not-before"), { force: true });
    if (["planned", "ready"].includes(row.state)) withStore(store, (s) => s.units.set({ id: unit, state: "in-progress" }));
  }
  appendFileSync(workerFile(store, id, "launches"), `${new Date().toISOString()}\t${name}\n`);
  const r = run("systemd-run", argv);
  // With --wait, systemd-run exits with the session's own status, which `exit` has already classified.
  if (r.code !== 0 && !args.wait) throw new UsageError(`systemd-run failed (${r.code}): ${r.stderr.trim()}`);
  process.stdout.write(`${args.wait ? "finished" : "launched"} ${name} (launch ${launchCount(store, id)})\n`);
  return 0;
}

function events(file) {
  const out = [];
  for (const line of readText(file).split("\n")) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function exit(store, unit) {
  const row = withStore(store, (s) => s.units.get(unit));
  const evs = events(workerFile(store, unit, "jsonl"));
  const init = evs.find((e) => e?.type === "system" && e.subtype === "init");
  const result = evs.findLast((e) => e?.type === "result");
  const text = `${readText(workerFile(store, unit, "stderr.log"))}\n${result?.result ?? ""}`;
  let status;
  let detail;
  if (init?.apiKeySource && init.apiKeySource !== "none") {
    status = "setup";
    detail = `billed through ${init.apiKeySource}; workers must run on the subscription`;
  } else if (SETTLED.includes(row.state)) {
    status = row.state;
    detail = `unit ${row.state}`;
  } else if (USAGE_LIMIT.test(text)) {
    const until = parseReset(text).toISOString();
    mkdirSync(path.join(store, "workers"), { recursive: true });
    writeFileSync(workerFile(store, unit, "not-before"), `${until}\n`);
    withStore(store, (s) => s.units.set({ id: unit, state: "ready" }));
    status = "usage_limit";
    detail = `resets_at=${until}`;
  } else {
    status = "crash";
    const e = process.env;
    detail = `service ${e.SERVICE_RESULT || "unknown"}, ${e.EXIT_CODE || "unknown"} ${e.EXIT_STATUS || "?"}, unit state ${row.state}`;
  }
  mkdirSync(path.join(store, "workers"), { recursive: true });
  const exitFile = workerFile(store, unit, "exit.txt");
  writeFileSync(exitFile, `${status} ${detail}\n`);
  const report = path.join(store, `report-${unit}.md`);
  const pointer = SETTLED.includes(status) && existsSync(report) ? report : exitFile;
  withStore(store, (s) => s.inbox.push({ agent: "worker", unit, status, report: pointer }));
  process.stdout.write(`${unit}\t${status}\t${detail}\n`);
  return 0;
}

function next(store, json) {
  const { config } = loadConfig(store);
  const parallel = Number.isInteger(config.parallel) && config.parallel > 0 ? config.parallel : 1;
  const { rows, ready } = withStore(store, (s) => ({ rows: s.units.list(), ready: s.units.ready() }));
  // A pr-open unit whose worker has exited is merge-ready and waits on the human, so it holds no slot.
  const busy = rows.filter((u) => IN_FLIGHT_STATES.includes(u.state) && (u.state !== "pr-open" || workerState(workerName(config.repo, store, u.id)).alive)).length;
  const now = new Date();
  const defer = [];
  const candidates = [];
  for (const u of ready) {
    const nb = notBefore(store, u.id);
    if (nb && nb > now) defer.push({ id: u.id, until: nb.toISOString() });
    else candidates.push({ id: u.id, override: u.override });
  }
  const launchNow = candidates.slice(0, Math.max(0, parallel - busy));
  const wake = defer.map((d) => d.until).sort()[0] ?? null;
  if (json) {
    process.stdout.write(`${JSON.stringify({ parallel, busy, launch: launchNow, defer, wake }, null, 2)}\n`);
    return 0;
  }
  const lines = [
    ...launchNow.map((u) => `launch ${u.id}${u.override ? " (dependency override)" : ""}`),
    ...defer.map((d) => `defer ${d.id} until ${d.until}`),
    `slots ${parallel - busy}/${parallel}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

main((argv) => {
  const args = parseArgs(argv, { flags: ["json", "wait", "dry-run", "coordinator", "resume"], options: ["store", "unit", "plugin-dir"] });
  const [command] = args._;
  if (args._.length !== 1 || !args.store || !["launch", "exit", "next"].includes(command)) throw new UsageError(USAGE);
  if (args.coordinator && command !== "launch") throw new UsageError("--coordinator goes with launch only");
  if (command !== "next" && !args.unit && !args.coordinator) throw new UsageError(`${command} needs --unit`);
  const store = path.resolve(args.store);
  if (command === "launch") return launch(store, args.unit, args);
  if (command === "exit") return exit(store, args.unit);
  return next(store, args.json);
});
