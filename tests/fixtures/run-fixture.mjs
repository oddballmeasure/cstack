#!/usr/bin/env node
// L4 fixture runner: one whole /cstack:program run on the private testbed, graded by a held-out suite.
// Usage: node tests/fixtures/run-fixture.mjs <fixture> [--keep]
//   <fixture> is a directory under tests/fixtures/ (f1-cli-ledger), or its short prefix (f1).
// Steps:
//   1. Fresh clone of the testbed under tests/fixtures/results/<fixture>-<ts>/testbed (gitignored).
//   2. Replace testbed main with the fixture's empty project and push it.
//   3. Launch the program as a detached headless coordinator under systemd-run, with
//      CSTACK_COORDINATOR=1, CSTACK_RUN=<slug> and CSTACK_PROGRAM_AUTONOMY=send (ADR-006).
//   4. Poll `systemctl --user is-active` every 60 s; stop the run when budget.toml `hours` runs out.
//   5. Check out origin/main, run the held-out grader and cstack's own suite (run-e2e as grader), and
//      write tests/fixtures/<fixture>/results/<date>.json plus <outDir>/result.json.
//   6. Teardown (skipped with --keep): stop the run's units, close the PRs and issues the run opened,
//      remove its worktrees, and restore testbed main to tag baseline-p3.
// Prints PASS when the grader pass rate is at least 0.95 and the run stayed within budget.
// This is a plain Node script, not a model session, so it may sleep. Run one fixture at a time: a
// program can use most of a 5-hour subscription window. Not run in CI.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNATTENDED } from "../scenarios/lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSTACK = path.resolve(HERE, "../..");
const REPO = "oddballmeasure/cstack-testbed";
const REPO_NAME = "cstack-testbed";
const POLL_MS = 60_000;
const PASS_RATE = 0.95;
const LABELS = ["ready", "in-progress", "done", "error", "needs-human", "investigate", "proposed"];

// Each fixture names its run slug and the project that replaces testbed main.
const FIXTURES = {
  "f1-cli-ledger": { slug: "f1", scaffold: nodeProject },
};

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const wanted = argv.filter((a) => a !== "--keep");
const fixture = Object.keys(FIXTURES).find((f) => wanted.length === 1 && (f === wanted[0] || f.startsWith(`${wanted[0]}-`)));
if (!fixture || wanted.some((a) => a.startsWith("--"))) {
  console.error(`usage: run-fixture.mjs <${Object.keys(FIXTURES).join("|")}> [--keep]`);
  process.exit(2);
}
const { slug, scaffold } = FIXTURES[fixture];
const FIXTURE_DIR = path.join(HERE, fixture);
const GRADER = path.join(FIXTURE_DIR, "grader");
const budget = parseToml(readFileSync(path.join(FIXTURE_DIR, "budget.toml"), "utf8"));
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(HERE, "results", `${fixture}-${ts}`);
const clone = path.join(outDir, "testbed");
const store = path.join(clone, ".cstack", "runs", slug);
const unitPrefix = `cstack-${REPO_NAME}-${slug}-`;
const coordinator = `${unitPrefix}coordinator`;
mkdirSync(outDir, { recursive: true });

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  return opts.full ? r : (r.stdout ?? "").trim();
}
const git = (...a) => sh("git", ["-C", clone, ...a]);
const gh = (args, opts) => sh("gh", [...args, "--repo", REPO], opts);
const orch = (...a) => sh(process.execPath, [path.join(CSTACK, "gates/orch.mjs"), "--store", store, "--json", ...a], { allowFail: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
const isActive = (unit) => ["active", "activating", "deactivating", "reloading"].includes(sh("systemctl", ["--user", "is-active", unit], { allowFail: true }));
const json = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

// budget.toml holds flat `key = value` lines (numbers or quoted strings).
function parseToml(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = /^".*"$/.test(m[2]) ? m[2].slice(1, -1) : Number(m[2]);
  }
  return out;
}

// f1: an empty Node project with a real `npm test`, CI that runs it, and a cstack config.
function nodeProject() {
  const template = JSON.parse(readFileSync(path.join(CSTACK, "templates/config.json"), "utf8"));
  const config = {
    ...template,
    repo: REPO,
    base_branch: "main",
    test_command: ["npm", "test"],
    e2e_command: null,
    required_checks: ["ci"],
    paths_hidden: ["tests/acceptance/**"],
    autonomy: "stop",
    parallel: 1,
  };
  return {
    "package.json": `${JSON.stringify({ name: "ledger", version: "0.0.0", private: true, type: "module", engines: { node: ">=22" }, scripts: { test: "node --test 'test/**/*.test.mjs'" } }, null, 2)}\n`,
    "test/smoke.test.mjs": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      "",
      'test("package.json has no dependencies", () => {',
      '  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
      '  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");',
      '  assert.equal(pkg.devDependencies, undefined, "no dev dependencies");',
      "});",
      "",
    ].join("\n"),
    ".github/workflows/ci.yml": [
      "name: CI",
      "on:",
      "  push:",
      "    branches: [main]",
      "  pull_request:",
      "jobs:",
      "  ci:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 22",
      "      - run: npm test",
      "",
    ].join("\n"),
    ".cstack/config.json": `${JSON.stringify(config, null, 2)}\n`,
    ".gitignore": ".cstack/*\n!.cstack/config.json\nnode_modules/\n",
    "README.md": "# ledger\n\nA plain-text expense ledger CLI. Built by a cstack L4 fixture run.\n",
  };
}

function replaceMain() {
  git("checkout", "-q", "--orphan", "fixture-main");
  git("rm", "-rfq", ".");
  git("clean", "-fdxq");
  for (const [rel, text] of Object.entries(scaffold())) {
    mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
    writeFileSync(path.join(clone, rel), text);
  }
  const smoke = sh("npm", ["test"], { cwd: clone, full: true, allowFail: true });
  if (smoke.status !== 0) throw new Error(`the scaffold's npm test fails: ${smoke.stdout}${smoke.stderr}`);
  git("add", "-A");
  git("commit", "-qm", `Fixture ${fixture}: empty project`);
  git("push", "-q", "-f", "origin", "HEAD:refs/heads/main");
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-B", "main", "origin/main");
  git("branch", "-q", "-D", "fixture-main");
  for (const l of LABELS) gh(["label", "create", `cstack:${l}`, "--force", "--color", "5319e7"], { allowFail: true });
}

function launch() {
  if (isActive(coordinator)) throw new Error(`${coordinator} is already running; run one fixture at a time`);
  // The guideline is copied out of the cstack repo, so the run gets no path next to the held-out grader.
  const guideline = path.join(mkdtempSync(path.join(tmpdir(), `cstack-${fixture}-`)), "guideline.md");
  copyFileSync(path.join(FIXTURE_DIR, "guideline.md"), guideline);
  copyFileSync(guideline, path.join(outDir, "guideline.md"));
  // The plugin is copied without tests/ (which holds every fixture's held-out grader), evals/, spike/ and .git,
  // so nothing the run can read through --plugin-dir leads to the grader. The guard only protects the target repo.
  const plugin = mkdtempSync(path.join(tmpdir(), "cstack-plugin-"));
  sh("rsync", ["-a", "--exclude", "/tests", "--exclude", "/evals", "--exclude", "/spike", "--exclude", "/.git", "--exclude", "NOTES.md", `${CSTACK}/`, `${plugin}/`]);
  if (existsSync(path.join(plugin, "tests"))) throw new Error("plugin copy still contains tests/");
  writeFileSync(path.join(outDir, "plugin-dir.txt"), plugin + "\n");
  const prompt = `/cstack:program ${guideline} --autonomy=send --slug ${slug}\n\n${UNATTENDED}`;
  writeFileSync(path.join(outDir, "prompt.txt"), prompt);
  const q = JSON.stringify;
  const PATH = [path.dirname(process.execPath), `${process.env.HOME}/.local/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const script = path.join(outDir, "session.sh");
  writeFileSync(
    script,
    `#!/bin/sh
cd ${q(clone)}
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CSTACK_COORDINATOR=1 CSTACK_RUN=${slug} CSTACK_PROGRAM_AUTONOMY=send PATH=${q(PATH)} \\
  claude -p --output-format stream-json --verbose --strict-mcp-config --plugin-dir ${q(plugin)} --dangerously-skip-permissions \\
  "$(cat ${q(path.join(outDir, "prompt.txt"))})" > ${q(path.join(outDir, "coordinator.jsonl"))} 2> ${q(path.join(outDir, "coordinator.stderr.log"))}
`,
    { mode: 0o755 },
  );
  const maxSec = Math.round(budget.hours * 3600) + 600;
  sh("systemd-run", ["--user", "--collect", "--quiet", `--unit=${coordinator}`, `--property=RuntimeMaxSec=${maxSec}`, script]);
}

async function wait(started, stopping) {
  const limit = budget.hours * 3600 * 1000;
  await sleep(5000);
  for (;;) {
    if (!isActive(coordinator)) return { overBudget: false, interrupted: false };
    if (stopping.signal) return { overBudget: false, interrupted: true };
    if (Date.now() - started > limit) return { overBudget: true, interrupted: false };
    log(`${coordinator} active, ${Math.round((Date.now() - started) / 60000)} min`);
    await sleep(POLL_MS);
  }
}

function stopRun() {
  sh("systemctl", ["--user", "stop", `${unitPrefix}*`], { allowFail: true });
}

function events(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => json(l, {}));
}

function askCount(file) {
  let n = 0;
  for (const e of events(file)) for (const c of e.message?.content || []) if (c.type === "tool_use" && c.name === "AskUserQuestion") n++;
  return n;
}

function sessionFiles() {
  const files = [path.join(outDir, "coordinator.jsonl"), path.join(store, "e2e-author.jsonl")];
  const workers = path.join(store, "workers");
  if (existsSync(workers)) for (const f of readdirSync(workers)) if (f.endsWith(".jsonl")) files.push(path.join(workers, f));
  return files.filter(existsSync);
}

function grade() {
  const ids = [...readFileSync(path.join(GRADER, "index.js"), "utf8").matchAll(/\btest\(\s*["'`](G\d+)\b/g)].map((m) => m[1]);
  const r = sh(process.execPath, ["--test", "--test-reporter=tap", GRADER], {
    cwd: CSTACK,
    env: { ...process.env, LEDGER_BIN: path.join(clone, "bin/ledger.mjs") },
    full: true,
    allowFail: true,
    timeout: 600_000,
  });
  writeFileSync(path.join(outDir, "grader.tap"), `${r.stdout ?? ""}${r.stderr ?? ""}`);
  const ok = new Map();
  for (const m of String(r.stdout).matchAll(/^(not )?ok \d+ - (G\d+)\b/gm)) ok.set(m[2], !m[1]);
  const failed = ids.filter((id) => !ok.get(id));
  return { passed: ids.length - failed.length, total: ids.length, rate: ids.length ? (ids.length - failed.length) / ids.length : 0, failed };
}

function cstackE2e() {
  const planned = existsSync(path.join(store, "e2e-plan.md")) ? [...readFileSync(path.join(store, "e2e-plan.md"), "utf8").matchAll(/^###\s+(E\d+\.\d+)\b/gm)].map((m) => m[1]) : [];
  const r = sh(process.execPath, [path.join(CSTACK, "gates/run-e2e.mjs"), clone, "--json"], { cwd: CSTACK, env: { ...process.env, CSTACK_ROLE: "grader" }, full: true, allowFail: true, timeout: 1_800_000 });
  writeFileSync(path.join(outDir, "cstack-e2e.json"), r.stdout || r.stderr || "");
  const lanes = json(r.stdout, null)?.lanes;
  if (!lanes) return { passed: 0, total: planned.length, rate: null, failed: planned, error: (r.stderr || r.stdout || "").trim().split("\n").at(-1) };
  const ids = planned.length ? planned : Object.keys(lanes);
  const failed = ids.filter((id) => lanes[id] !== "pass");
  return { passed: ids.length - failed.length, total: ids.length, rate: ids.length ? (ids.length - failed.length) / ids.length : 0, failed };
}

function repairRounds() {
  const out = sh("git", ["-C", clone, "log", "origin/main", "--remotes=origin/cstack/*", "--format=%(trailers:key=Cstack-Unit,valueonly,separator=%x2C)%x1f%(trailers:key=Cstack-Ticket,valueonly,separator=%x2C)%x1e"], { allowFail: true });
  const seen = new Set();
  const counts = { REPAIR: 0, "CI-REPAIR": 0, SYNC: 0 };
  for (const rec of out.split("\x1e")) {
    const [unit, ticket] = rec.trim().split("\x1f").map((s) => (s ?? "").trim());
    const kind = ticket?.match(/^(CI-REPAIR|REPAIR|SYNC)-\d+$/)?.[1];
    if (!kind || seen.has(`${unit}/${ticket}`)) continue;
    seen.add(`${unit}/${ticket}`);
    counts[kind]++;
  }
  return { ...counts, total: counts.REPAIR + counts["CI-REPAIR"] + counts.SYNC };
}

// PRs and issues the run opened: everything created on the testbed since the run started.
function createdSince(kind, since) {
  const fields = kind === "pr" ? "number,state,title,createdAt,mergedAt,headRefName" : "number,state,title,createdAt";
  const list = json(gh([kind, "list", "--state", "all", "--limit", "200", "--json", fields], { allowFail: true }), []);
  return list.filter((x) => x.createdAt >= since).sort((a, b) => a.number - b.number);
}

function teardown(since) {
  stopRun();
  for (const pr of createdSince("pr", since)) {
    if (pr.state === "OPEN") gh(["pr", "close", String(pr.number), "--delete-branch"], { allowFail: true });
    else sh("git", ["-C", clone, "push", "-q", "origin", "--delete", pr.headRefName], { allowFail: true });
  }
  for (const issue of createdSince("issue", since)) if (issue.state === "OPEN") gh(["issue", "close", String(issue.number)], { allowFail: true });
  const worktrees = [...git("worktree", "list", "--porcelain").matchAll(/^worktree (.+)$/gm)].map((m) => m[1]).filter((p) => path.resolve(p) !== path.resolve(clone));
  for (const wt of worktrees) sh("git", ["-C", clone, "worktree", "remove", "--force", wt], { allowFail: true });
  git("push", "-q", "-f", "origin", "baseline-p3^{commit}:refs/heads/main");
}

const stopping = { signal: null };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping.signal = sig));

const startedIso = new Date().toISOString();
log(`fixture ${fixture} -> ${outDir}`);
sh("gh", ["repo", "clone", REPO, clone, "--", "-q"]);
git("config", "user.name", "cstack-fixture");
git("config", "user.email", "cstack@users.noreply.github.com");

let result;
try {
  replaceMain();
  log(`testbed main replaced with the ${fixture} scaffold at ${git("rev-parse", "HEAD")}`);
  const started = Date.now();
  launch();
  log(`launched ${coordinator}`);
  const { overBudget, interrupted } = await wait(started, stopping);
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  const leftover = sh("systemctl", ["--user", "list-units", "--plain", "--no-legend", `${unitPrefix}*`], { allowFail: true }).split("\n").filter(Boolean).map((l) => l.split(/\s+/)[0]);
  stopRun();
  log(`run ended after ${wallSeconds}s${overBudget ? " (over budget, stopped)" : ""}${interrupted ? ` (${interrupted})` : ""}`);

  const coord = events(path.join(outDir, "coordinator.jsonl"));
  const init = coord.find((e) => e.type === "system" && e.subtype === "init") || {};
  git("fetch", "-q", "origin");
  git("checkout", "-q", "-f", "--detach", "origin/main");
  const mergedSha = git("rev-parse", "HEAD");
  const grader = grade();
  const e2e = cstackE2e();
  const byFile = Object.fromEntries(sessionFiles().map((f) => [path.relative(outDir, f), askCount(f)]));
  const questions = Object.values(byFile).reduce((a, b) => a + b, 0);
  const gatesOpen = json(orch("gate", "list"), []).filter((g) => g.kind === "open").map((g) => g.id);
  const decisions = existsSync(path.join(store, "decisions.tsv")) ? readFileSync(path.join(store, "decisions.tsv"), "utf8").split("\n").filter(Boolean).length - 1 : 0;
  if (existsSync(path.join(store, "report.md"))) copyFileSync(path.join(store, "report.md"), path.join(outDir, "report.md"));
  const maxQuestions = budget.max_unplanned_questions ?? Infinity;
  const withinBudget = !overBudget && !interrupted && questions <= maxQuestions;
  const billed = init.apiKeySource && init.apiKeySource !== "none";
  result = {
    fixture,
    date: startedIso.slice(0, 10),
    started_at: startedIso,
    wall_seconds: wallSeconds,
    budget: { hours: budget.hours, max_unplanned_questions: budget.max_unplanned_questions ?? null },
    within_budget: withinBudget,
    over_budget: overBudget,
    interrupted: interrupted ? stopping.signal : null,
    billing: init.apiKeySource ?? "unknown",
    merged_sha: mergedSha,
    grader,
    cstack_e2e: e2e,
    // cstack's own suite green while the held-out grader is red is a P0 harness bug (plan 6.3).
    p0_gap: e2e.rate === 1 && grader.rate < 1,
    human_questions: { ask_user_question: questions, by_file: byFile, gates_open: gatesOpen },
    units: json(orch("unit", "counts"), {}),
    repair_rounds: repairRounds(),
    decision_rows: decisions,
    leftover_units: leftover.filter((u) => u !== coordinator),
    prs: createdSince("pr", startedIso).map((p) => ({ number: p.number, state: p.state, title: p.title })),
    final_message: coord.findLast((e) => e.type === "result")?.result?.slice(0, 2000) ?? "",
  };
  result.pass = !billed && grader.rate >= PASS_RATE && withinBudget;
} catch (err) {
  stopRun();
  result = { fixture, started_at: startedIso, pass: false, error: String(err.stack || err) };
} finally {
  if (!keep) {
    try {
      teardown(startedIso);
      log("teardown done: PRs and issues closed, testbed main restored to baseline-p3");
    } catch (err) {
      log(`teardown failed: ${err.message}`);
      result.teardown_error = String(err.message);
    }
  } else log("--keep: testbed main, PRs and issues left as the run made them");
}

const resultsDir = path.join(FIXTURE_DIR, "results");
mkdirSync(resultsDir, { recursive: true });
let file = path.join(resultsDir, `${startedIso.slice(0, 10)}.json`);
if (existsSync(file)) file = path.join(resultsDir, `${startedIso.slice(0, 10)}-${ts.slice(11, 19)}.json`);
const text = `${JSON.stringify(result, null, 2)}\n`;
writeFileSync(file, text);
writeFileSync(path.join(outDir, "result.json"), text);
const g = result.grader;
console.log(`${result.pass ? "PASS" : "FAIL"} ${fixture} grader ${g ? `${g.passed}/${g.total}` : "n/a"} e2e ${result.cstack_e2e ? `${result.cstack_e2e.passed}/${result.cstack_e2e.total}` : "n/a"} (${result.wall_seconds ?? "?"}s) ${file}`);
if (result.error) console.log(result.error);
process.exit(result.pass ? 0 : 1);
