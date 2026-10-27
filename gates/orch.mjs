#!/usr/bin/env node
// Adapted from pstack skills/poteto-mode/scripts/orch @ 519d36a (MIT, Lauren Tan).
// orch: plain-file bookkeeping for a cstack run. One command in, one line (or a few) out.
// Store: --store <dir>, else --run <slug> (.cstack/runs/<slug>), else ORCH_STORE, else CSTACK_RUN.
// Exit codes: 0 ok, 1 `ledger check` found no passing verdict, 2 usage, validation or store error.
import path from "node:path";
import { main, parseArgs, UsageError } from "./lib/common.mjs";
import { countLine, isPassing, openStore, positiveInteger } from "./lib/store.mjs";

const DISPLAY_LIMIT = 4;

const USAGE = `usage: node gates/orch.mjs [--store <dir> | --run <slug>] [--json] [--force] <command> ...

Store: --store <dir>, --run <slug> (.cstack/runs/<slug>), ORCH_STORE, or CSTACK_RUN.
ORCH_LOCK_WAIT_MS sets how long a writer waits on a live lock (default 10000); --force then steals it.

Commands:
  init
  unit add <id> --track <t> [--state planned|ready] [--brief <path>] [--issue <n>] [--depends-on <ids>] [--lanes <ids>]
  unit set <id> [--state <s>] [--track <t>] [--branch <b>] [--pr <n>] [--sha <sha>] [--issue <n>] [--depends-on <ids>] [--lanes <ids>] [--brief <path>]
  unit get <id>
  unit list [--state <s>] [--track <t>]
  unit counts
  unit ready
  ledger record <unit> <sha> <verdict> --evidence <path> [--pr <n>] [--verifier <name>]
  ledger check <unit> <sha>          exit 0 only if the latest verdict passes
  ledger summary
  inbox push <agent> <unit> <status> [--report <path>]
  inbox drain [--peek]
  inbox count
  gate park <id> --question <q> --options <o> --default <d>
  gate list
  gate resolve <id> --answer <a>
  frontier set [--repo <dir>] [--prs <n,...>]
  frontier show
  status
  standing show
  standing add <line>

Unit states: planned ready in-progress verifying pr-open merged done error needs-human
Verdicts: approved rejected live-ui-verified unit-test-verified type-check-only verifier-blocked verifier-failed
`;

const tsv = (...cells) => cells.join("\t");
const unitLine = (u) => tsv(u.id, u.track, u.state, u.branch, u.pr, u.sha, u.issue, u.depends_on, u.lanes, u.brief);
const ledgerLine = (r) => tsv(r.unit, r.pr, r.sha, r.verdict, r.evidence, r.verifier, r.ts);
const pointerLine = (p) => tsv(p.ts, p.agent, p.unit, p.status, p.report);
const gateLine = (g) => tsv(g.id, g.question, g.options, g.defaultAnswer);
const standingLine = (s) => `${s.number}. ${s.line}`;

function rows(list, format, empty, limit = DISPLAY_LIMIT) {
  if (list.length === 0) return empty;
  const shown = limit === null ? list : list.slice(0, limit);
  const lines = shown.map(format);
  if (limit !== null && list.length > limit) lines.push(`... ${list.length - limit} more; use --json`);
  return lines.join("\n");
}

function frontierLine(f) {
  const prs = f.prs.length === 0 ? "none" : f.prs.map((r) => `${r.branches}#${r.pr}@${r.sha}:${r.state}`).join(",");
  return `generation=${f.generation} prs=${prs} lowest-unmerged=${f.lowestUnmerged ?? "none"}`;
}

function statusLines(report) {
  const ids = report.summary.openGateIds;
  const more = ids.length > DISPLAY_LIMIT ? `,+${ids.length - DISPLAY_LIMIT} more` : "";
  return [
    `counts: units=${report.units.length}; states=${countLine(report.summary.unitStates)}; ledger=${countLine(report.summary.ledgerVerdicts)}`,
    `changed: ${report.changed}`,
    `gates open: ${ids.length}${ids.length > 0 ? `; ids=${ids.slice(0, DISPLAY_LIMIT).join(",")}${more}` : ""}`,
  ].join("\n");
}

function prList(value) {
  const parts = value.split(",");
  if (parts.some((p) => p === "")) throw new UsageError("--prs requires a comma-separated PR list");
  return parts.map((p) => positiveInteger(p, "--prs entry"));
}

// Each command: positional names, allowed options and flags, required options, the store call, and the
// compact renderer. `json` maps the result for --json; `exit` maps it to an exit code.
const COMMANDS = {
  init: { run: (s) => s.init(), text: (r) => `initialized ${r.store}` },
  "unit add": {
    args: ["id"],
    options: ["track", "state", "brief", "issue", "depends-on", "lanes"],
    required: ["track"],
    run: (s, a, o) => s.units.add({ id: a.id, track: o.track, state: o.state, brief: o.brief, issue: o.issue, dependsOn: o["depends-on"], lanes: o.lanes }),
    text: unitLine,
  },
  "unit set": {
    args: ["id"],
    options: ["state", "track", "branch", "pr", "sha", "issue", "depends-on", "lanes", "brief"],
    run: (s, a, o) =>
      s.units.set({ id: a.id, state: o.state, track: o.track, branch: o.branch, pr: o.pr, sha: o.sha, issue: o.issue, dependsOn: o["depends-on"], lanes: o.lanes, brief: o.brief }),
    text: unitLine,
  },
  "unit get": { args: ["id"], run: (s, a) => s.units.get(a.id), text: unitLine },
  "unit list": {
    options: ["state", "track"],
    run: (s, a, o) => s.units.list({ state: o.state, track: o.track }),
    text: (r) => rows(r, unitLine, "(no units)"),
  },
  "unit counts": { run: (s) => s.units.counts(), text: countLine },
  "unit ready": {
    run: (s) => s.units.ready(),
    text: (r) => rows(r, (u) => (u.override ? `${unitLine(u)}\t(dependency override)` : unitLine(u)), "(no ready units)", null),
  },
  "ledger record": {
    args: ["unit", "sha", "verdict"],
    options: ["evidence", "pr", "verifier"],
    required: ["evidence"],
    run: (s, a, o) => s.ledger.record({ unit: a.unit, sha: a.sha, verdict: a.verdict, evidence: o.evidence, pr: o.pr, verifier: o.verifier }),
    text: (r) => tsv(r.unit, r.sha, r.verdict),
  },
  "ledger check": {
    args: ["unit", "sha"],
    run: (s, a) => {
      const row = s.ledger.latest({ unit: a.unit, sha: a.sha });
      return row ? { ...row, approved: isPassing(row.verdict) } : { unit: a.unit, sha: a.sha, verdict: "NOT-VERIFIED", approved: false };
    },
    text: (r) => (r.verdict === "NOT-VERIFIED" ? "NOT-VERIFIED" : ledgerLine(r)),
    exit: (r) => (r.approved ? 0 : 1),
  },
  "ledger summary": { run: (s) => s.ledger.summary(), text: countLine },
  "inbox push": {
    args: ["agent", "unit", "status"],
    options: ["report"],
    run: (s, a, o) => s.inbox.push({ agent: a.agent, unit: a.unit, status: a.status, report: o.report }),
    text: (p) => tsv(p.unit, p.status, p.file),
  },
  "inbox drain": {
    flags: ["peek"],
    run: (s, a, o) => (o.peek ? s.inbox.peek() : s.inbox.drain()),
    text: (r) => rows(r, pointerLine, "(empty)", null),
  },
  "inbox count": { run: (s) => s.inbox.count(), text: String, json: (count) => ({ count }) },
  "gate park": {
    args: ["id"],
    options: ["question", "options", "default"],
    required: ["question", "options", "default"],
    run: (s, a, o) => s.gates.park({ id: a.id, question: o.question, options: o.options, defaultAnswer: o.default }),
    text: (g) => tsv(g.id, "open"),
  },
  "gate list": { run: (s) => s.gates.list(), text: (r) => rows(r, gateLine, "(no open gates)") },
  "gate resolve": {
    args: ["id"],
    options: ["answer"],
    required: ["answer"],
    run: (s, a, o) => s.gates.resolve({ id: a.id, answer: o.answer }),
    text: (g) => tsv(g.id, "resolved", g.answer),
  },
  "frontier set": {
    options: ["repo", "prs"],
    run: (s, a, o) => s.frontier.set({ repo: o.repo ?? process.env.ORCH_REPO ?? process.cwd(), prs: o.prs === undefined ? undefined : prList(o.prs) }),
    text: frontierLine,
  },
  "frontier show": { run: (s) => s.frontier.show(), text: frontierLine },
  status: { run: (s) => s.status.render(), text: statusLines },
  "standing show": { run: (s) => s.standing.show(), text: (r) => rows(r, standingLine, "(no standing orders)") },
  "standing add": { args: ["line"], run: (s, a) => s.standing.add({ line: a.line }), text: standingLine },
};

const GLOBAL_FLAGS = ["json", "force", "help"];
const GLOBAL_OPTIONS = ["store", "run"];
const ALL_FLAGS = [...new Set([...GLOBAL_FLAGS, ...Object.values(COMMANDS).flatMap((c) => c.flags ?? [])])];
const ALL_OPTIONS = [...new Set([...GLOBAL_OPTIONS, ...Object.values(COMMANDS).flatMap((c) => c.options ?? [])])];

function storeDirectory(opts, env = process.env) {
  if (opts.store !== undefined) {
    if (opts.store.trim() === "") throw new UsageError("--store must not be empty");
    return opts.store;
  }
  if (opts.run === undefined && env.ORCH_STORE) return env.ORCH_STORE;
  const slug = opts.run ?? env.CSTACK_RUN;
  if (!slug) throw new UsageError("no store: pass --store <dir> or --run <slug>, or set ORCH_STORE or CSTACK_RUN");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) throw new UsageError(`run slug ${JSON.stringify(slug)} must match [A-Za-z0-9][A-Za-z0-9._-]*`);
  return path.join(".cstack", "runs", slug);
}

function resolveCommand(positional) {
  for (const n of [2, 1]) {
    const name = positional.slice(0, n).join(" ");
    if (COMMANDS[name]) return { name, spec: COMMANDS[name], rest: positional.slice(n) };
  }
  if (positional.length === 0) throw new UsageError("a command is required (try --help)");
  throw new UsageError(`unknown command: ${positional.slice(0, 2).join(" ")} (try --help)`);
}

function cli(argv) {
  const opts = parseArgs(argv, { flags: ALL_FLAGS, options: ALL_OPTIONS });
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const { name, spec, rest } = resolveCommand(opts._);
  const allowed = new Set([...GLOBAL_FLAGS, ...GLOBAL_OPTIONS, ...(spec.flags ?? []), ...(spec.options ?? [])]);
  for (const k of Object.keys(opts)) if (k !== "_" && !allowed.has(k)) throw new UsageError(`${name} does not take --${k}`);
  for (const k of spec.required ?? []) if (opts[k] === undefined) throw new UsageError(`${name} needs --${k}`);
  const names = spec.args ?? [];
  if (rest.length !== names.length) throw new UsageError(`usage: ${name}${names.map((n) => ` <${n}>`).join("")}`);
  const args = Object.fromEntries(names.map((n, i) => [n, rest[i]]));

  const store = openStore(storeDirectory(opts), {
    force: Boolean(opts.force),
    waitMs: process.env.ORCH_LOCK_WAIT_MS === undefined ? undefined : Number(process.env.ORCH_LOCK_WAIT_MS),
    onLockStolen: (h) => process.stderr.write(`stealing store lock held by pid ${h}\n`),
    onStaleLock: (h) => process.stderr.write(`replacing stale store lock (pid ${h} is dead)\n`),
  });
  try {
    const result = spec.run(store, args, opts);
    const out = opts.json ? JSON.stringify((spec.json ?? ((r) => r))(result), null, 2) : spec.text(result);
    process.stdout.write(`${out}\n`);
    return spec.exit ? spec.exit(result) : 0;
  } finally {
    store.close();
  }
}

main(cli);
