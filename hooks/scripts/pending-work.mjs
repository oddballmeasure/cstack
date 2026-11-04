#!/usr/bin/env node
// cstack Stop hook: a coordinator must not end its turn while units are in flight and nothing will wake it,
// and a unit worker must not end its turn before its unit reaches a PR or a settled state.
// Active only when CSTACK_COORDINATOR=1, or CSTACK_UNIT with CSTACK_HEADLESS=1, and CSTACK_RUN names a run store under <repo>/.cstack/runs/.
// Blocks (exit 2, reason on stderr) when the store has units in-progress or verifying (or pr-open under
// effective autonomy send, from config and <store>/run.json, where the run still merges them) and no
// watcher is alive for the store. inbox-wait, pr-wait and post-merge --wait each hold <store>/watchers/<pid>. Allows (exit 0) otherwise, and on the second stop in a row
// (stop_hook_active), so a session that cannot comply is nudged once and never trapped.
// A headless unit worker (CSTACK_UNIT and CSTACK_HEADLESS=1, set by gates/worker.mjs) is blocked while its own row is in-progress
// or verifying. Under `claude -p` and `codex exec` the end of the turn ends the process and every subagent it
// started, and before its PR the unit has no watcher of its own (the store's watchers belong to the coordinator).
// Under Codex (a payload with turn_id) the block is {"decision":"block","reason":…} on stdout with exit 0,
// the form measured to keep a Codex session going.
// Any headless Codex session cstack launched (CSTACK_HEADLESS=1, a payload with turn_id) is also blocked while a child
// it started with spawn_agent is still running, read from its rollout (transcript_path). PreToolUse never sees
// spawn_agent under hooks.json's matcher (measured, Codex CLI 0.166.0), and spawn_agent is always asynchronous, so a
// tool guard could not make the session wait anyway. This check is the control. A Codex child (a payload with
// agent_id) inherits the parent's markers but is neither the coordinator nor the unit worker, so only this check
// applies to it.
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

function block(codex, reason) {
  if (codex) {
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
    return 0;
  }
  process.stderr.write(reason + "\n");
  return 2;
}

// Children the session started and has not seen end. The rollout's SubAgentActivity items carry a kind and the other
// agent's agent_thread_id. The kinds seen in real rollouts (Codex CLI 0.165 and 0.166) are "started" (spawn_agent),
// "completed" and "interacted" (send_input and follow-ups). "interacted" can follow "completed" and start the child
// again, so it marks one of this session's own children live; in a child's rollout it names the parent, which this
// session did not start, so there it changes nothing. Only "completed" ends a child. An unknown kind changes nothing:
// that fails closed, and the second-stop escape bounds the cost to one extra turn. An unreadable rollout or line
// counts as no children. The hook reads the whole rollout on every headless Codex stop.
function liveChildren(transcript) {
  let text;
  try {
    text = readFileSync(transcript, "utf8");
  } catch {
    return [];
  }
  const own = new Set();
  const live = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes('"SubAgentActivity"')) continue;
    let item;
    try {
      item = JSON.parse(line).payload?.item;
    } catch {
      continue;
    }
    if (item?.type !== "SubAgentActivity" || typeof item.agent_thread_id !== "string") continue;
    const id = item.agent_thread_id;
    if (item.kind === "started") own.add(id);
    if (item.kind === "started" || (item.kind === "interacted" && own.has(id))) live.set(id, item.agent_path || id);
    else if (item.kind === "completed") live.delete(id);
  }
  return [...live.values()];
}

function readUnits(store) {
  const [header, ...lines] = readFileSync(path.join(store, "units.tsv"), "utf8").split("\n");
  const cols = header.split("\t");
  const [id, state] = [cols.indexOf("id"), cols.indexOf("state")];
  return lines
    .filter(Boolean)
    .map((l) => l.split("\t"))
    .map((c) => ({ id: c[id], state: c[state] }));
}

function main() {
  const headless = process.env.CSTACK_HEADLESS === "1";
  const coordinator = process.env.CSTACK_COORDINATOR === "1";
  const unit = coordinator || !headless ? "" : process.env.CSTACK_UNIT || "";
  const run = (coordinator || unit) && process.env.CSTACK_RUN;
  if (!run && !headless) return 0;
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  if (input.stop_hook_active) return 0;
  const codex = typeof input.turn_id === "string";
  if (headless && codex && typeof input.transcript_path === "string") {
    const live = liveChildren(input.transcript_path);
    if (live.length) {
      return block(
        true,
        `cstack pending-work: child agents still running (${live.join(", ")}). This headless session ends when its turn ends, and they die with it. Do not end the turn. ` +
          `Call wait_agent with a long timeout until every child has finished, then go on.`,
      );
    }
  }
  if (!run || input.agent_id) return 0;
  const found = findStore(input.cwd || process.cwd(), process.env.CSTACK_RUN);
  if (!found) return 0;
  const rows = readUnits(found.store);
  if (unit) {
    const own = rows.find((r) => r.id === unit);
    if (!own || !["in-progress", "verifying"].includes(own.state)) return 0;
    const wait = codex ? "Wait for every child with wait_agent before you end the turn" : "Spawn subagents with run_in_background: false and wait for each result in the foreground";
    return block(
      codex,
      `cstack pending-work: unit ${unit} is still ${own.state}. This headless session ends when its turn ends, and every subagent it started dies with it. Do not end the turn. ` +
        `${wait}, then go on with the unit's stages until it opens its PR or settles through cstack:settle.`,
    );
  }
  const moving = autonomy(found.repo, found.store) === "send" ? ["in-progress", "verifying", "pr-open"] : ["in-progress", "verifying"];
  const pending = rows.filter((r) => moving.includes(r.state)).map((r) => `${r.id} ${r.state}`);
  if (pending.length === 0) return 0;
  const watchers = path.join(found.store, "watchers");
  if (existsSync(watchers) && readdirSync(watchers).some(alive)) return 0;
  const watch = codex ? "run it in the foreground with --once --timeout 1500, act on its lines, and run it again while it exits 3" : "arm the Monitor tool on it and wait for its events";
  const reason =
    `cstack pending-work: units in flight (${pending.join(", ")}) and no watcher is armed (inbox-wait, pr-wait --store, or post-merge --wait). Do not end the turn. ` +
    `Drain with \`node ${ROOT}/gates/orch.mjs --store ${found.store} inbox drain\`, then start ` +
    `\`node ${ROOT}/gates/inbox-wait.mjs --store ${found.store}\` and ${watch}.`;
  return block(codex, reason);
}

process.exitCode = main();
