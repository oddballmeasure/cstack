#!/usr/bin/env node
// cstack Stop hook: a coordinator must not end its turn while units are in flight and nothing will wake it.
// Active only when CSTACK_COORDINATOR=1 and CSTACK_RUN names a run store under <repo>/.cstack/runs/.
// Blocks (exit 2, reason on stderr) when the store has units in-progress or verifying (or pr-open under
// effective autonomy send, from config and <store>/run.json, where the run still merges them) and no
// inbox-wait watcher is alive for the store (inbox-wait holds <store>/watchers/<pid>). Allows (exit 0) otherwise, and on the second stop in a row
// (stop_hook_active), so a session that cannot comply is nudged once and never trapped.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveAutonomy } from "../../gates/lib/run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function findStore(start, slug) {
  let dir = path.resolve(start);
  for (;;) {
    const store = path.join(dir, ".cstack", "runs", slug);
    if (existsSync(path.join(store, "units.tsv"))) return { repo: dir, store };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The run's effective autonomy: config, overridden by <store>/run.json per gates/lib/run.mjs.
function autonomy(repo, store) {
  let config = {};
  try {
    config = JSON.parse(readFileSync(path.join(repo, ".cstack", "config.json"), "utf8"));
  } catch {}
  return effectiveAutonomy(config, store).level;
}

function alive(pid) {
  if (!/^\d+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function main() {
  if (process.env.CSTACK_COORDINATOR !== "1" || !process.env.CSTACK_RUN) return 0;
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (input.stop_hook_active) return 0;
  const found = findStore(input.cwd || process.cwd(), process.env.CSTACK_RUN);
  if (!found) return 0;
  const moving = autonomy(found.repo, found.store) === "send" ? ["in-progress", "verifying", "pr-open"] : ["in-progress", "verifying"];
  const [header, ...lines] = readFileSync(path.join(found.store, "units.tsv"), "utf8").split("\n");
  const cols = header.split("\t");
  const [id, state] = [cols.indexOf("id"), cols.indexOf("state")];
  const pending = lines
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .filter((c) => moving.includes(c[state]))
    .map((c) => `${c[id]} ${c[state]}`);
  if (pending.length === 0) return 0;
  const watchers = path.join(found.store, "watchers");
  if (existsSync(watchers) && readdirSync(watchers).some(alive)) return 0;
  process.stderr.write(
    `cstack pending-work: units in flight (${pending.join(", ")}) and no watcher is armed. Do not end the turn. ` +
      `Drain with \`node ${ROOT}/gates/orch.mjs --store ${found.store} inbox drain\`, then arm the Monitor tool on ` +
      `\`node ${ROOT}/gates/inbox-wait.mjs --store ${found.store}\` and wait for its events.\n`,
  );
  return 2;
}

process.exitCode = main();
