// Level B unit workers: session names, liveness, and the per-unit files under <store>/workers/.
//   workers/<unit>.jsonl        the headless session's stream-json output
//   workers/<unit>.stderr.log   its stderr
//   workers/<unit>.launches     one line per launch: <iso ts> <session name>
//   workers/<unit>.spec.json    the runner spec, for every supervisor backend but systemd (gates/runner.mjs)
//   workers/<unit>.exit.txt     the last exit: <status> <detail>
//   workers/<unit>.not-before   ISO time before which the unit must not be relaunched (usage limit)
//   watchers/<pid>              one file per live watcher (inbox-wait, pr-wait, post-merge --wait): <kind> <iso ts>
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envPath } from "./common.mjs";
import { sessionState } from "./supervisor.mjs";

export const TERMINAL_STATES = ["merged", "done", "error", "needs-human"];
export const IN_FLIGHT_STATES = ["in-progress", "verifying", "pr-open"];

// The PATH a detached session gets: CSTACK_WORKER_PATH, else node's directory, ~/.local/bin, the Homebrew
// directories and the system directories. A supervisor does not give a session the login PATH.
// Windows has no fixed system bin dirs, so a Windows session keeps this process's PATH behind node's dir.
export function workerPath({ env = process.env, platform = process.platform, home = os.homedir(), nodeDir = path.dirname(process.execPath) } = {}) {
  if (env.CSTACK_WORKER_PATH) return env.CSTACK_WORKER_PATH;
  if (platform === "win32") return [nodeDir, envPath(env)].join(";");
  return [nodeDir, `${home}/.local/bin`, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/home/linuxbrew/.linuxbrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

const clean = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, "-");

// cstack-<repo name>-<run slug>-<unit>, from config `repo` (owner/name) and the store directory name.
export function workerName(repo, store, unit) {
  const name = String(repo).split("/").pop();
  return `cstack-${clean(name)}-${clean(path.basename(path.resolve(store)))}-${clean(unit)}`;
}

// The session's state in systemd's words (active, failed, inactive, ...) and whether it counts as alive,
// for whichever supervisor backend started it (gates/lib/supervisor.mjs).
export const workerState = (name) => sessionState(name);

export const workerFile = (store, unit, ext) => path.join(store, "workers", `${unit}.${ext}`);

export function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function launchCount(store, unit) {
  return readText(workerFile(store, unit, "launches")).split("\n").filter(Boolean).length;
}

// The relaunch time after a usage limit, or null. A file that does not parse counts as no limit.
export function notBefore(store, unit) {
  const t = Date.parse(readText(workerFile(store, unit, "not-before")).trim());
  return Number.isNaN(t) ? null : new Date(t);
}

// Milliseconds the zone's wall clock is ahead of UTC at instant t. Throws RangeError for an unknown zone.
function zoneOffset(zone, t) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60000) * 60000;
}

// When the subscription window resets, from text such as "limit reached|1761580800",
// "resets 3pm (America/New_York)" or "resets at 4:30 pm". A clock time is read in the named IANA
// zone, else in the host's zone, and rolls to the next day when already past. Without a time: one hour from now.
export function parseReset(text, now = new Date()) {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = text.match(/\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+\/[A-Za-z_/]+)\))?/i);
  if (!m) return new Date(now.getTime() + 3600 * 1000);
  const meridiem = m[3]?.toLowerCase();
  const hour = meridiem ? (Number(m[1]) % 12) + (meridiem === "pm" ? 12 : 0) : Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[4]) {
    try {
      const wallNow = new Date(now.getTime() + zoneOffset(m[4], now.getTime()));
      const wall = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate(), hour, minute);
      let at = wall - zoneOffset(m[4], wall);
      if (at <= now.getTime()) at += 24 * 3600 * 1000;
      return new Date(at);
    } catch {
      // An unknown zone name: fall back to the host's zone.
    }
  }
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// The last thing a finished session did in its own thread: the tool calls of its final assistant message (the
// calls since its last tool result), the last call, and the text it wrote after that call, if any. Reads
// `claude -p` stream-json (subagent events carry parent_tool_use_id and are skipped) and `codex exec --json`
// items, where each command is its own step. A call is { id, name, input }; call and message may be null.
export function lastActions(events) {
  let calls = [];
  let open = false;
  let message = null;
  for (const e of events) {
    const own = !e?.parent_tool_use_id;
    if (e?.type === "assistant" && own && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === "tool_use") {
          calls = open ? [...calls, { id: c.id, name: c.name, input: c.input }] : [{ id: c.id, name: c.name, input: c.input }];
          [open, message] = [true, null];
        } else if (c?.type === "text" && c.text?.trim()) message = c.text;
      }
    } else if (e?.type === "user" && own && Array.isArray(e.message?.content) && e.message.content.some((c) => c?.type === "tool_result")) {
      open = false;
    } else if (e?.type === "item.completed" && e.item?.type === "command_execution") {
      [calls, message] = [[{ id: e.item.id, name: "Bash", input: { command: e.item.command } }], null];
    } else if (e?.type === "item.completed" && e.item?.type === "agent_message" && e.item.text?.trim()) {
      message = e.item.text;
    }
  }
  return { calls, call: calls.at(-1) ?? null, message };
}

// The first of these calls that the result event's permission_denials hold, matched by tool_use_id, else by
// name and input; or null.
export function refusedCall(calls, events) {
  const result = events.findLast((e) => e?.type === "result");
  const list = Array.isArray(result?.permission_denials) ? result.permission_denials : [];
  const same = (call) => (d) => (d?.tool_use_id ? d.tool_use_id === call.id : d?.tool_name === call.name && JSON.stringify(d?.tool_input) === JSON.stringify(call.input));
  return calls.find((call) => list.some(same(call))) ?? null;
}

// A worker session that stopped on the subscription usage window.
export const USAGE_LIMIT = /usage limit|limit reached|hit your (?:[\w-]+ )?limit|out of (?:extra )?usage/i;

// Mark this process as a live watcher for a run store, so the pending-work Stop hook knows the coordinator
// will be woken. The mark is removed on exit; a mark whose pid is dead is ignored by the hook.
export function registerWatcher(store, kind) {
  const mark = path.join(store, "watchers", String(process.pid));
  mkdirSync(path.dirname(mark), { recursive: true });
  writeFileSync(mark, `${kind} ${new Date().toISOString()}\n`);
  process.on("exit", () => rmSync(mark, { force: true }));
  return mark;
}
