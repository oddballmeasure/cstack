// Per-run settings from <store>/run.json, written by cstack:program (and full-send, full-stop) for one run.
// Format: {"slug": "<slug>", "autonomy": "stop"|"send", "parallel": <n>, ...}. Every key is optional.
//
// The run store is writable by any session in the run, implementers included, while the guard hook
// protects .cstack/config.json. So run.json may LOWER autonomy (send to stop) but never raise it on its
// own. It raises stop to send only when the session that runs the gate has CSTACK_PROGRAM_AUTONOMY=send
// in its environment, which only a human-launched session or the headless coordinator launch sets
// (ADR-006). An unreadable run.json or an unknown autonomy value fails closed to stop.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const LEVELS = ["stop", "send"];

// {run, error}: run is the parsed object or null when the file is absent; error explains a bad file.
export function readRun(store) {
  const file = path.join(store, "run.json");
  if (!existsSync(file)) return { run: null, error: null };
  try {
    const run = JSON.parse(readFileSync(file, "utf8"));
    if (!run || typeof run !== "object" || Array.isArray(run)) return { run: null, error: `${file} is not a JSON object` };
    return { run, error: null };
  } catch (err) {
    return { run: null, error: `${file} does not parse: ${err.message}` };
  }
}

// {level, source, note}. level is "send" or "stop". note explains an ignored or refused override.
export function effectiveAutonomy(config, store) {
  const base = config.autonomy === "send" ? "send" : "stop";
  const { run, error } = readRun(store);
  if (error) return { level: "stop", source: "run.json", note: `${error}; failing closed to stop` };
  if (!run || run.autonomy === undefined) return { level: base, source: "config", note: "" };
  if (!LEVELS.includes(run.autonomy)) return { level: "stop", source: "run.json", note: `run.json autonomy ${JSON.stringify(run.autonomy)} is not stop or send; failing closed to stop` };
  if (run.autonomy === "stop") return { level: "stop", source: "run.json", note: "" };
  if (base === "send") return { level: "send", source: "config", note: "" };
  if (process.env.CSTACK_PROGRAM_AUTONOMY === "send") return { level: "send", source: "run.json + CSTACK_PROGRAM_AUTONOMY", note: "" };
  return { level: base, source: "config", note: "run.json asks for send, but run.json may only lower autonomy unless the session has CSTACK_PROGRAM_AUTONOMY=send" };
}

// {value, source}: run.json parallel when it is a positive integer, else config parallel, else 1.
export function effectiveParallel(config, store) {
  const ok = (n) => Number.isInteger(n) && n > 0;
  const { run } = readRun(store);
  if (ok(run?.parallel)) return { value: run.parallel, source: "run.json" };
  if (ok(config.parallel)) return { value: config.parallel, source: "config" };
  return { value: 1, source: "default" };
}
