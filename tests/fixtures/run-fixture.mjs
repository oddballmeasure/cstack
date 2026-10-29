#!/usr/bin/env node
// L4 fixture runner: one whole /cstack:program run on the private testbed, graded by a held-out suite.
// Usage: node tests/fixtures/run-fixture.mjs <fixture> [--keep] [--harness claude|codex]   (--help prints the usage and the fixtures)
//   <fixture> is a directory under tests/fixtures/ with a fixture.json (f2-http-shortener), or its short prefix (f2).
// Each fixture's fixture.json names its slug, the entry point the grader tests, the grader command, and the empty
// project that replaces testbed main (package.json, .gitignore, CI steps, cstack config overrides).
// Steps:
//   1. Fresh clone of the testbed under tests/fixtures/results/<fixture>-<ts>/testbed (gitignored).
//   2. Replace testbed main with the fixture's empty project and push it.
//   3. Launch the program as a detached headless coordinator under systemd-run, with
//      CSTACK_COORDINATOR=1, CSTACK_RUN=<slug> and CSTACK_PROGRAM_AUTONOMY=send (ADR-006).
//   4. Poll `systemctl --user is-active` every 60 s; stop the run when budget.toml `hours` runs out.
//   5. Check out origin/main, run the held-out grader and cstack's own suite (run-e2e as grader), and
//      write tests/fixtures/<fixture>/results/<date>.json plus <outDir>/result.json. The grader is copied to a
//      temporary directory only now, after every unit of the run has stopped, and runs there (with its setup).
//   6. Teardown (skipped with --keep): stop the run's units, close the PRs and issues the run opened, delete the clone,
//      remove its worktrees, and restore testbed main to tag baseline-p3.
// Prints PASS when the grader pass rate is at least 0.95 and the run stayed within budget.
// This is a plain Node script, not a model session, so it may sleep. Run one fixture at a time: a
// program can use most of a 5-hour subscription window. Not run in CI.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UNATTENDED } from "../scenarios/lib.mjs";
import { codexSandboxArgs } from "../../gates/lib/harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSTACK = path.resolve(HERE, "../..");
// A sandbox repo you own: the run replaces its main branch and restores it afterwards.
const REPO = process.env.CSTACK_TESTBED_REPO || "oddballmeasure/cstack-testbed";
const REPO_NAME = REPO.split("/")[1];
const POLL_MS = 60_000;
const PASS_RATE = 0.95;
const LABELS = ["ready", "in-progress", "done", "error", "needs-human", "investigate", "proposed"];

// A fixture is a directory under tests/fixtures/ with guideline.md, budget.toml, fixture.json and grader/.
const FIXTURES = readdirSync(HERE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(HERE, d.name, "fixture.json")))
  .map((d) => d.name)
  .sort();

const USAGE = `usage: node tests/fixtures/run-fixture.mjs <fixture> [--keep] [--harness claude|codex]
       node tests/fixtures/run-fixture.mjs --help

Runs one whole /cstack:program on ${REPO} for the fixture's guideline.md, then grades
origin/main with the fixture's held-out grader/ and with cstack's own e2e suite.

  <fixture>   a directory under tests/fixtures/ with a fixture.json, or its short prefix
              (${FIXTURES.map((f) => `${f.split("-")[0]} = ${f}`).join(", ") || "none found"})
  --keep      skip teardown: leave testbed main, the run's PRs, issues and worktrees as the run made them
  --harness   claude (default) or codex. Codex runs the coordinator as codex exec with CSTACK_HARNESS=codex,
              using the installed Codex plugin, which must be this checkout with its hooks trusted in /hooks.
              Every grader/ in the checkout and in the install is hidden from the run by the guard.
              CSTACK_CODEX_SANDBOX picks the sandbox (default workspace-write). Codex must be logged in with
              ChatGPT (ADR-010, ADR-012).
  --help      print this text

The run takes hours. Start it detached and follow the journal:
  systemd-run --user --unit=cstack-fixture-f2 --collect --working-directory="$PWD" node tests/fixtures/run-fixture.mjs f2
  journalctl --user -fu cstack-fixture-f2

fixture.json keys:
  slug                       run slug (CSTACK_RUN); units are named cstack-${REPO_NAME}-<slug>-*
  entry.env, entry.path      the grader gets env <entry.env> = <clone>/<entry.path>
  grader.setup               optional command run first in a temporary copy of grader/ (for example npm ci)
  grader.command             command run in that copy; it prints TAP whose test names start with G<n>
  grader.timeout_seconds     limit for grader.command (default 600)
  project.package            package.json of the empty project; devDependencies get a package-lock.json
  project.smoke              "no-dependencies" or "no-runtime-dependencies": the scaffold's one smoke test
  project.gitignore          .gitignore lines
  project.readme             README.md text
  ci.install, ci.playwright  CI runs npm ci, and npx playwright install --with-deps chromium, before npm test
  config                     overrides merged over templates/config.json and the fixture defaults

Exit 0 on PASS (grader at least ${PASS_RATE * 100}%, within budget.toml, on the subscription), 1 on FAIL, 2 on bad usage.`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const keep = argv.includes("--keep");
const hi = argv.indexOf("--harness");
const harness = hi < 0 ? "claude" : argv[hi + 1];
if (!["claude", "codex"].includes(harness)) {
  console.error("--harness must be claude or codex");
  process.exit(2);
}
const wanted = argv.filter((a, i) => a !== "--keep" && i !== hi && i !== hi + 1);
const fixture = FIXTURES.find((f) => wanted.length === 1 && (f === wanted[0] || f.startsWith(`${wanted[0]}-`)));
if (!fixture || wanted.some((a) => a.startsWith("-"))) {
  console.error(`usage: run-fixture.mjs <${FIXTURES.join("|")}> [--keep]   (--help for details)`);
  process.exit(2);
}
const FIXTURE_DIR = path.join(HERE, fixture);
const GRADER = path.join(FIXTURE_DIR, "grader");
const spec = JSON.parse(readFileSync(path.join(FIXTURE_DIR, "fixture.json"), "utf8"));
for (const key of ["slug", "entry.env", "entry.path", "grader.command", "project.package", "project.smoke"]) {
  if (key.split(".").reduce((o, k) => o?.[k], spec) == null) {
    console.error(`${fixture}/fixture.json: missing ${key}`);
    process.exit(2);
  }
}
if (!["no-dependencies", "no-runtime-dependencies"].includes(spec.project.smoke)) {
  console.error(`${fixture}/fixture.json: project.smoke must be no-dependencies or no-runtime-dependencies`);
  process.exit(2);
}
const { slug } = spec;
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
// npm and npx resolve `node` from PATH; under systemd-run that PATH may lack this Node, so put it first.
const withNode = (extra = {}) => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter), ...extra });
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

// Plain objects merge key by key (config.limits, config.models); anything else replaces.
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    const plain = (x) => x && typeof x === "object" && !Array.isArray(x);
    out[k] = plain(v) && plain(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

// The empty project from fixture.json: a Node package with a real `npm test` (one smoke test), CI job `ci`
// that runs it, and a cstack config. Without fixture.json `config` overrides this is exactly the f1 scaffold.
function scaffold() {
  const template = JSON.parse(readFileSync(path.join(CSTACK, "templates/config.json"), "utf8"));
  const config = merge(
    {
      ...template,
      repo: REPO,
      base_branch: "main",
      test_command: ["npm", "test"],
      e2e_command: null,
      required_checks: ["ci"],
      paths_hidden: ["tests/acceptance/**"],
      autonomy: "stop",
      parallel: 1,
    },
    spec.config,
  );
  const { project, ci = {} } = spec;
  const noDev = project.smoke === "no-dependencies";
  return {
    "package.json": `${JSON.stringify(project.package, null, 2)}\n`,
    "test/smoke.test.mjs": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      "",
      `test("package.json has no ${noDev ? "" : "runtime "}dependencies", () => {`,
      '  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));',
      '  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");',
      ...(noDev ? ['  assert.equal(pkg.devDependencies, undefined, "no dev dependencies");'] : []),
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
      ...(ci.install ? ["      - run: npm ci"] : []),
      ...(ci.playwright ? ["      - run: npx playwright install --with-deps chromium"] : []),
      "      - run: npm test",
      "",
    ].join("\n"),
    ".cstack/config.json": `${JSON.stringify(config, null, 2)}\n`,
    ".gitignore": `${(project.gitignore || [".cstack/*", "!.cstack/config.json", "node_modules/"]).join("\n")}\n`,
    "README.md": project.readme || `# ${project.package.name}\n\nBuilt by a cstack L4 fixture run.\n`,
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
  // `npm ci` (CI and setup_command) needs a lockfile when the project starts with dev dependencies.
  if (spec.project.package.devDependencies) sh("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"], { cwd: clone, env: withNode() });
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
  // The plugin is copied without tests/ (which holds every fixture's held-out grader), evals/ and .git,
  // so nothing the run can read through --plugin-dir leads to the grader. The guard only protects the target repo.
  const plugin = mkdtempSync(path.join(tmpdir(), "cstack-plugin-"));
  sh("rsync", ["-a", "--exclude", "/tests", "--exclude", "/evals", "--exclude", "/.git", "--exclude", "NOTES.md", `${CSTACK}/`, `${plugin}/`]);
  if (existsSync(path.join(plugin, "tests"))) throw new Error("plugin copy still contains tests/");
  writeFileSync(path.join(outDir, "plugin-dir.txt"), plugin + "\n");
  const prompt = `${harness === "codex" ? "$" : "/"}cstack:program ${guideline} --autonomy=send --slug ${slug}\n\n${UNATTENDED}`;
  writeFileSync(path.join(outDir, "prompt.txt"), prompt);
  const q = JSON.stringify;
  // The coordinator runs under its role's allowlist with dontAsk, never a permission bypass (ADR-009).
  const settings = path.join(outDir, "coordinator.settings.json");
  sh(process.execPath, [path.join(plugin, "gates/run-settings.mjs"), "--permissions", "coordinator", "--repo-dir", clone, "--plugin-dir", plugin, "--out", settings]);
  const PATH = [path.dirname(process.execPath), `${process.env.HOME}/.local/bin`, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const script = path.join(outDir, "session.sh");
  // Every fixture's held-out grader, hidden by the guard from the run and every session it launches.
  const installed = harness === "codex" ? codexPluginRoot() : null;
  const graders = FIXTURES.flatMap((f) => [path.join(HERE, f, "grader"), ...(installed ? [path.join(installed, "tests", "fixtures", f, "grader")] : [])]);
  const hide = q(graders.join(path.delimiter));
  if (harness === "codex") {
    const sandbox = process.env.CSTACK_CODEX_SANDBOX || "workspace-write";
    const box = codexSandboxArgs(sandbox, clone).map((x) => q(x)).join(" ");
    writeFileSync(
      script,
      `#!/bin/sh
cd ${q(clone)}
exec env -u OPENAI_API_KEY -u CODEX_API_KEY CSTACK_GUARD_HIDE=${hide} CSTACK_CODEX_SANDBOX=${sandbox} CSTACK_COORDINATOR=1 CSTACK_RUN=${slug} CSTACK_HARNESS=codex CSTACK_PROGRAM_AUTONOMY=send PATH=${q(PATH)} \\
  codex exec --json -C ${q(clone)} ${box} \\
  "$(cat ${q(path.join(outDir, "prompt.txt"))})" < /dev/null > ${q(path.join(outDir, "coordinator.jsonl"))} 2> ${q(path.join(outDir, "coordinator.stderr.log"))}
`,
      { mode: 0o755 },
    );
    const maxSec = Math.round(budget.hours * 3600) + 600;
    sh("systemd-run", ["--user", "--collect", "--quiet", `--unit=${coordinator}`, `--property=RuntimeMaxSec=${maxSec}`, script]);
    return;
  }
  writeFileSync(
    script,
    `#!/bin/sh
cd ${q(clone)}
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CSTACK_GUARD_HIDE=${hide} CSTACK_COORDINATOR=1 CSTACK_RUN=${slug} CSTACK_PROGRAM_AUTONOMY=send PATH=${q(PATH)} \\
  claude -p --output-format stream-json --verbose --strict-mcp-config --plugin-dir ${q(plugin)} --permission-mode dontAsk --settings ${q(settings)} \\
  "$(cat ${q(path.join(outDir, "prompt.txt"))})" > ${q(path.join(outDir, "coordinator.jsonl"))} 2> ${q(path.join(outDir, "coordinator.stderr.log"))}
`,
    { mode: 0o755 },
  );
  const maxSec = Math.round(budget.hours * 3600) + 600;
  sh("systemd-run", ["--user", "--collect", "--quiet", `--unit=${coordinator}`, `--property=RuntimeMaxSec=${maxSec}`, script]);
}

// Codex runs the installed plugin and trusts its hooks per plugin fingerprint, so the run uses the install as it
// is: it must be this checkout (codex plugin marketplace add <this checkout>; codex plugin add cstack@cstack).
function codexPluginRoot() {
  const cache = path.join(process.env.HOME, ".codex", "plugins", "cache", "cstack", "cstack");
  const version = existsSync(cache) ? readdirSync(cache).sort().at(-1) : null;
  const root = version && path.join(cache, version);
  const same = (rel) => root && existsSync(path.join(root, rel)) && readFileSync(path.join(root, rel), "utf8") === readFileSync(path.join(CSTACK, rel), "utf8");
  if (!["gates/worker.mjs", "hooks/scripts/guard.mjs", "skills/program/SKILL.md"].every(same)) {
    throw new Error(`the Codex install of cstack (${root ?? "none"}) is not this checkout; reinstall it from ${CSTACK} and trust its hooks in /hooks`);
  }
  return root;
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

// The held-out grader. It is copied out of the cstack repo only here, after the run's units have stopped, into a
// fresh temporary directory (never inside the clone), set up there (for example `npm ci`), run, and removed.
// Test ids are every `test("G<n>` in the grader's top-level .js/.mjs files; one that never reports counts as failed.
function grade() {
  const sources = readdirSync(GRADER).filter((f) => /\.m?js$/.test(f));
  const ids = [...new Set(sources.flatMap((f) => [...readFileSync(path.join(GRADER, f), "utf8").matchAll(/\btest\(\s*["'`](G\d+)\b/g)].map((m) => m[1])))];
  const dir = mkdtempSync(path.join(tmpdir(), `cstack-grader-${fixture}-`));
  const tap = path.join(outDir, "grader.tap");
  const resolve = ([cmd, ...args]) => [cmd === "node" ? process.execPath : cmd, args];
  const env = withNode({ [spec.entry.env]: path.join(clone, spec.entry.path) });
  const score = (stdout, extra = {}) => {
    const ok = new Map();
    for (const m of String(stdout).matchAll(/^(not )?ok \d+ - (G\d+)\b/gm)) if (ok.get(m[2]) !== false) ok.set(m[2], !m[1]);
    const failed = ids.filter((id) => !ok.get(id));
    return { passed: ids.length - failed.length, total: ids.length, rate: ids.length ? (ids.length - failed.length) / ids.length : 0, failed, ...extra };
  };
  try {
    sh("rsync", ["-a", "--exclude", "/node_modules", "--exclude", "/test-results", `${GRADER}/`, `${dir}/`]);
    if (spec.grader.setup?.length) {
      const [cmd, args] = resolve(spec.grader.setup);
      const s = sh(cmd, args, { cwd: dir, env, full: true, allowFail: true, timeout: 900_000 });
      if (s.status !== 0) {
        writeFileSync(tap, `# grader setup failed (${s.status}): ${spec.grader.setup.join(" ")}\n${s.stdout ?? ""}${s.stderr ?? ""}`);
        return score("", { setup_error: `exit ${s.status}` });
      }
    }
    const [cmd, args] = resolve(spec.grader.command);
    const r = sh(cmd, args, { cwd: dir, env, full: true, allowFail: true, timeout: (spec.grader.timeout_seconds ?? 600) * 1000 });
    writeFileSync(tap, `${r.stdout ?? ""}${r.stderr ?? ""}`);
    return score(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // Codex reports no billing source in its stream; its login must be ChatGPT (ADR-012).
  const init = harness === "codex"
    ? { apiKeySource: /ChatGPT/.test(sh("codex", ["login", "status"], { allowFail: true })) ? "none" : "codex-api-key" }
    : coord.find((e) => e.type === "system" && e.subtype === "init") || {};
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
    harness,
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
    final_message: (coord.findLast((e) => e.type === "result")?.result ?? coord.findLast((e) => e.item?.type === "agent_message")?.item.text ?? "").slice(0, 2000),
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
      // The clone holds the built app and its own tests. Leaving it inside the cstack repo let a broad
      // test glob run those tests, some of which run `npm test` from the cwd: a recursive suite (2026-10-29).
      rmSync(clone, { recursive: true, force: true });
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
