#!/usr/bin/env node
// The deterministic parts of one cstack:daemon tick: which standalone issue runs to launch, which workers
// are alive, which runs are orphaned, and which errored issues are due a retry.
// Adapted from Cardinal src/cardinal/daemon/loop.py (oddballmeasure/cardinal, same owner).
// Standalone runs live in <repo>/.cstack/runs/issue-<N>/ with one unit, U1, run by a Level B worker named
// cstack-<repo name>-issue-<N>-U1 (gates/worker.mjs).
// Usage:
//   daemon-tick.mjs scan    [--repo-dir <d>] [--json]   every issue-<N> store: unit state, worker, inbox,
//                                                       orphan (in flight, launched here, worker dead) and
//                                                       judge (merged with a PR: post-merge CI to run)
//   daemon-tick.mjs select  [--repo-dir <d>] [--json]   open issues labelled <prefix>:ready, oldest first,
//                                                       without a live worker and not deferred by a usage
//                                                       limit, up to config parallel minus the live workers
//   daemon-tick.mjs prepare <N> [--repo-dir <d>] [--json]   create issue-<N> with U1 ready, or set an
//                                                       existing U1 back to ready when no worker runs it
//   daemon-tick.mjs retry   [--repo-dir <d>] [--apply] [--json]   open issues labelled <prefix>:error whose
//                                                       failure-U1.txt names a retryable kind and is older
//                                                       than config retry_after_hours (unset: never). --apply
//                                                       relabels each ready through settle.mjs, sets U1 ready
//                                                       and moves the failure file aside.
// Exit 0 ok, 1 when prepare finds a live worker or a retry relabel fails, 2 on usage errors.
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";
import { openForge } from "./lib/forge.mjs";
import { openStore } from "./lib/store.mjs";
import { effectiveAutonomy } from "./lib/run.mjs";
import { notBefore, workerFile, workerName, workerState } from "./lib/workers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UNIT = "U1";
// Failures a later attempt can fix. crash is a cstack defect, setup means billing or the repo setup is
// wrong, and deploy is not a unit failure, so none of those is retried on a timer.
const RETRYABLE = new Set(["invalid_output", "tests_failed", "no_change", "verification", "ci_failed", "ci_timeout", "base_conflict", "pr_violation", "git", "github", "usage_limit"]);
const USAGE = "usage: daemon-tick.mjs scan|select|retry [--repo-dir d] [--apply] [--json] | prepare <N> [--repo-dir d] [--json]";

function withStore(dir, fn) {
  const s = openStore(dir);
  try {
    return fn(s);
  } finally {
    s.close();
  }
}

function scan(ctx) {
  const runs = path.join(ctx.root, ".cstack", "runs");
  const slugs = existsSync(runs) ? readdirSync(runs).filter((d) => /^issue-\d+$/.test(d) && existsSync(path.join(runs, d, "units.tsv"))) : [];
  const rows = [];
  for (const slug of slugs.sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
    const store = path.join(runs, slug);
    const { unit, inbox } = withStore(store, (s) => ({ unit: s.units.list().find((u) => u.id === UNIT), inbox: s.inbox.count() }));
    if (!unit) continue;
    const worker = workerState(workerName(ctx.config.repo, store, UNIT));
    const launched = existsSync(workerFile(store, UNIT, "launches"));
    const send = effectiveAutonomy(ctx.config, store).level === "send";
    const inFlight = ["in-progress", "verifying"].includes(unit.state) || (unit.state === "pr-open" && send);
    rows.push({
      slug,
      store,
      issue: Number(slug.slice(6)),
      state: unit.state,
      pr: unit.pr,
      worker: worker.state,
      alive: worker.alive,
      inbox,
      orphan: launched && inFlight && !worker.alive,
      judge: ["merged", "done"].includes(unit.state) && unit.pr !== "",
    });
  }
  return rows;
}

function scanCommand(gate, ctx) {
  const rows = scan(ctx);
  for (const r of rows) {
    const flags = [r.orphan && "orphan", r.judge && "judge", r.inbox && `inbox ${r.inbox}`].filter(Boolean);
    gate.pass(r.slug, `U1 ${r.state}, worker ${r.worker}${flags.length ? `, ${flags.join(", ")}` : ""}`);
  }
  return gate.finish({ stores: rows });
}

function select(gate, ctx) {
  const ready = ctx.forge.issues({ state: "open", label: `${ctx.prefix}:ready`, want: ["number", "title", "createdAt"] });
  ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number);
  const rows = new Map(scan(ctx).map((r) => [r.issue, r]));
  const parallel = Number.isInteger(ctx.config.parallel) && ctx.config.parallel > 0 ? ctx.config.parallel : 1;
  const busy = [...rows.values()].filter((r) => r.alive).length;
  const now = new Date();
  const launch = [];
  const skipped = [];
  for (const issue of ready) {
    const row = rows.get(issue.number);
    const until = notBefore(path.join(ctx.root, ".cstack", "runs", `issue-${issue.number}`), UNIT);
    if (row?.alive) skipped.push({ number: issue.number, why: `worker ${row.worker}` });
    else if (until && until > now) skipped.push({ number: issue.number, why: `deferred until ${until.toISOString()}` });
    else if (launch.length < parallel - busy) launch.push({ number: issue.number, title: issue.title });
    else skipped.push({ number: issue.number, why: "no free slot" });
  }
  for (const l of launch) gate.pass(`launch #${l.number}`, l.title);
  for (const s of skipped) gate.pass(`skip #${s.number}`, s.why);
  gate.pass("slots", `${Math.max(0, parallel - busy)}/${parallel} free before launch`);
  return gate.finish({ parallel, busy, launch, skipped });
}

function prepare(gate, ctx, issue) {
  const store = path.join(ctx.root, ".cstack", "runs", `issue-${issue}`);
  const worker = workerState(workerName(ctx.config.repo, store, UNIT));
  const action = withStore(store, (s) => {
    s.init();
    const unit = s.units.list().find((u) => u.id === UNIT);
    if (!unit) {
      s.units.add({ id: UNIT, track: "issue", issue, state: "ready" });
      return "created U1 ready";
    }
    if (worker.alive) return null;
    if (unit.state === "ready") return "U1 already ready";
    s.units.set({ id: UNIT, state: "ready" });
    return `U1 ${unit.state} -> ready`;
  });
  gate.check(action !== null, "prepare", `${store}: ${action}`, `worker ${worker.state} already runs issue-${issue}`);
  return gate.finish({ store });
}

function retry(gate, ctx, apply) {
  const hours = ctx.config.retry_after_hours;
  if (hours === undefined || hours === null) {
    gate.pass("retry", "disabled: config retry_after_hours is unset");
    return gate.finish({ eligible: [] });
  }
  const cutoff = Date.now() - hours * 3600 * 1000;
  const errored = ctx.forge.issues({ state: "open", label: `${ctx.prefix}:error`, want: ["number"] });
  const eligible = [];
  for (const { number } of errored.sort((a, b) => a.number - b.number)) {
    const store = path.join(ctx.root, ".cstack", "runs", `issue-${number}`);
    const file = path.join(store, `failure-${UNIT}.txt`);
    if (!existsSync(file)) {
      gate.pass(`#${number}`, "no failure-U1.txt here; not a daemon run, left alone");
      continue;
    }
    const kind = readFileSync(file, "utf8").match(/^cstack stopped at .+? \(([a-z_]+)\):/m)?.[1] ?? "unknown";
    const ended = statSync(file).mtimeMs;
    if (!RETRYABLE.has(kind)) {
      gate.pass(`#${number}`, `${kind} is not retryable`);
      continue;
    }
    if (ended > cutoff) {
      gate.pass(`#${number}`, `${kind}, due at ${new Date(ended + hours * 3600 * 1000).toISOString()}`);
      continue;
    }
    eligible.push({ number, kind });
    if (!apply) {
      gate.pass(`#${number}`, `${kind}, due a retry (dry run; pass --apply)`);
      continue;
    }
    const r = run(process.execPath, [path.join(HERE, "settle.mjs"), String(number), "--state", "ready", "--repo-dir", ctx.root], { cwd: ctx.root });
    if (!gate.check(r.code === 0, `#${number}`, `${kind}, requeued ready`, `settle failed: ${(r.stdout + r.stderr).trim().split("\n").at(-1)}`)) continue;
    withStore(store, (s) => s.units.set({ id: UNIT, state: "ready" }));
    renameSync(file, path.join(store, `failure-${UNIT}.${new Date().toISOString().replace(/[:.]/g, "-")}.txt`));
  }
  return gate.finish({ eligible });
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "apply"], options: ["repo-dir"] });
  const [command, issue] = args._;
  const ok = ["scan", "select", "retry"].includes(command) ? args._.length === 1 : command === "prepare" && args._.length === 2 && /^[1-9]\d*$/.test(issue);
  if (!ok) throw new UsageError(USAGE);
  const { root, config } = loadConfig(args["repo-dir"] || process.cwd());
  const ctx = { root, config, prefix: config.label_prefix, forge: openForge(config, { cwd: root }) };
  const gate = new Gate(`daemon-tick ${command}`, { json: args.json });
  if (command === "scan") return scanCommand(gate, ctx);
  if (command === "select") return select(gate, ctx);
  if (command === "prepare") return prepare(gate, ctx, Number(issue));
  return retry(gate, ctx, args.apply);
});
