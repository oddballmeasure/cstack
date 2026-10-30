#!/usr/bin/env node
// Watcher for the orchestrate coordinator, made for the Monitor tool. Prints one line per event:
//   inbox <agent> <unit> <status> <report>     a new inbox entry (peeked, never drained)
//   worker <unit> <state>                      a Level B worker seen not alive on the first poll
//   worker <unit> <old> -> <new>               a worker's systemd state changed
// and exits 0 with a last line:
//   done: all units terminal                   every unit is merged, done, error or needs-human
//   idle: no live worker (<n> units open)      nothing runs any more; the coordinator must act
//   deadline: <iso>                            --until passed (the wait for a usage-limit reset)
//   event: <n> lines                           --once: the first poll that printed an event
// and exits 3 with:
//   timeout: <n>s                              --timeout passed with no reason above; run it again
// With --until it waits for the deadline instead of exiting idle. --once and --timeout serve harnesses
// without a Monitor tool (Codex): the session runs the watcher in the foreground and re-runs it.
// While it runs it holds <store>/watchers/<pid>, which tells the pending-work Stop hook that the
// coordinator is waiting correctly.
// Usage: inbox-wait.mjs --store <dir> [--interval-ms 15000] [--until <iso>] [--once] [--timeout <s>]
// Exit 0 when it stops for a reason above, 3 on --timeout, 2 on usage or store errors.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { main, parseArgs, UsageError, loadConfig } from "./lib/common.mjs";
import { openStore } from "./lib/store.mjs";
import { IN_FLIGHT_STATES, TERMINAL_STATES, registerWatcher, workerName, workerState } from "./lib/workers.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => process.stdout.write(`${line}\n`);

main(async (argv) => {
  const args = parseArgs(argv, { flags: ["once"], options: ["store", "interval-ms", "until", "timeout"] });
  const interval = Number(args["interval-ms"] ?? 15000);
  const until = args.until === undefined ? null : Date.parse(args.until);
  const timeout = args.timeout === undefined ? null : Number(args.timeout);
  if (args._.length || !args.store || !Number.isInteger(interval) || interval < 1 || Number.isNaN(until) || (timeout !== null && !(timeout > 0))) {
    throw new UsageError("usage: inbox-wait.mjs --store <dir> [--interval-ms n] [--until <iso>] [--once] [--timeout <s>]");
  }
  const started = Date.now();
  const store = path.resolve(args.store);
  const { config } = loadConfig(store);
  const snapshot = () => {
    const s = openStore(store);
    try {
      return { units: s.units.list(), inbox: s.inbox.peek() };
    } finally {
      s.close();
    }
  };
  snapshot();
  // Handle signals before the mark announces this watcher, so a stop never finds it unprepared.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(0));
  registerWatcher(store, "inbox-wait");

  const seen = new Set();
  const workers = new Map();
  for (;;) {
    let events = 0;
    const event = (line) => (events++, say(line));
    const { units, inbox } = snapshot();
    for (const p of inbox) {
      if (seen.has(p.file)) continue;
      seen.add(p.file);
      event(`inbox ${p.agent} ${p.unit} ${p.status} ${p.report}`.trimEnd());
    }
    let live = 0;
    for (const u of units.filter((u) => IN_FLIGHT_STATES.includes(u.state))) {
      const { state, alive } = workerState(workerName(config.repo, store, u.id));
      if (alive) live++;
      const before = workers.get(u.id);
      if (before === undefined && !alive) event(`worker ${u.id} ${state}`);
      if (before !== undefined && before !== state) event(`worker ${u.id} ${before} -> ${state}`);
      workers.set(u.id, state);
    }
    const open = units.filter((u) => !TERMINAL_STATES.includes(u.state)).length;
    if (open === 0) return say("done: all units terminal"), 0;
    if (until !== null) {
      if (Date.now() >= until) return say(`deadline: ${new Date(until).toISOString()}`), 0;
    } else if (live === 0) {
      return say(`idle: no live worker (${open} units open)`), 0;
    }
    if (args.once && events) return say(`event: ${events} lines`), 0;
    if (timeout !== null && Date.now() - started >= timeout * 1000) return say(`timeout: ${timeout}s`), 3;
    await sleep(interval);
  }
});
