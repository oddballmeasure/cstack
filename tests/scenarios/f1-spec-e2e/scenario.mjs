// Phase 4 exit check: from the f1 guideline, write a spec and a hidden e2e suite.
// The testbed main is swapped for an empty Node project for this run and restored afterwards.
// Expect: spec passes check-spec, e2e plan passes check-e2e, every lane FAILs in the red check,
// every mutation row is caught, and PR #0 touches only the hidden suite and the config.
import { assert } from "../lib.mjs";
import { readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 120;
const SLUG = "f1";

export function setup(ctx) {
  const t = ctx.testbed;
  for (const f of readdirSync(t)) if (![".git", ".cstack", ".github", ".gitignore"].includes(f)) rmSync(path.join(t, f), { recursive: true, force: true });
  rmSync(path.join(t, ".github/workflows/ci.yml"), { force: true });
  mkdirSync(path.join(t, ".github/workflows"), { recursive: true });
  writeFileSync(path.join(t, ".github/workflows/ci.yml"), "name: ci\non: [pull_request]\njobs:\n  ci:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: npm test\n");
  writeFileSync(path.join(t, "package.json"), JSON.stringify({ name: "ledger", private: true, type: "module", scripts: { test: "node --test 'test/**/*.test.mjs' || true" } }, null, 2) + "\n");
  writeFileSync(path.join(t, "README.md"), "# ledger\n\nEmpty project. See the guideline.\n");
  const cfgPath = path.join(t, ".cstack/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, e2e_command: null, autonomy: "stop" }, null, 2) + "\n");
  ctx.git("add", "-A");
  ctx.git("commit", "-qm", "Empty ledger project for the f1 spec and e2e check");
  ctx.git("push", "-q", "-f", "origin", "HEAD:main");
  const guideline = path.join(ctx.cstack, "tests/fixtures/f1-cli-ledger/guideline.md");
  return {
    prompt: `Use cstack:spec on the guideline file ${guideline} with run slug ${SLUG}, then cstack:e2e-plan for the same run. Stop when PR #0 (the hidden suite) is merge-ready; do not implement the product.\n\nThis is an unattended scenario run: no human will answer questions. Take documented defaults instead of asking.`,
  };
}

export function expect(ctx) {
  const store = path.join(ctx.testbed, ".cstack/runs", SLUG);
  const gate = (name, args) => JSON.parse(ctx.sh("node", [path.join(ctx.cstack, "gates", name), ...args, "--json"], { allowFail: true }));
  const spec = gate("check-spec.mjs", [path.join(store, "spec.md")]);
  assert.ok(spec.approved, `spec gate: ${JSON.stringify(spec.findings)}`);
  ctx.git("fetch", "-q", "origin");
  const prs = JSON.parse(ctx.gh("pr", "list", "--state", "open", "--json", "number,headRefName,files"));
  const pr0 = prs.find((p) => p.files.some((f) => f.path.startsWith("tests/acceptance/")));
  assert.ok(pr0, "PR #0 with the hidden suite is open");
  const bad = pr0.files.map((f) => f.path).filter((p) => !p.startsWith("tests/acceptance/") && p !== ".cstack/config.json");
  assert.deepEqual(bad, [], "PR #0 touches only the hidden suite and the config");
  ctx.git("checkout", "-q", `origin/${pr0.headRefName}`);
  const e2e = gate("check-e2e.mjs", [path.join(store, "e2e-plan.md"), "--spec", path.join(store, "spec.md"), "--config", path.join(ctx.testbed, ".cstack/config.json")]);
  assert.ok(e2e.approved, `e2e gate: ${JSON.stringify(e2e.findings)}`);
  // Independent red check: every lane fails on the empty project.
  const red = JSON.parse(ctx.sh("node", [path.join(ctx.cstack, "gates/run-e2e.mjs"), ctx.testbed, "--json"], { allowFail: true, env: { ...process.env, CSTACK_ROLE: "grader" } }));
  const lanes = Object.entries(red.lanes || {});
  assert.ok(lanes.length >= 6, `at least 6 lanes reported (${lanes.length})`);
  assert.ok(lanes.every(([, v]) => v === "fail"), `every lane fails on the empty project: ${JSON.stringify(red.lanes)}`);
  ctx.prNumber = pr0.number;
}

export function teardown(ctx) {
  if (ctx.prNumber) ctx.gh("pr", "close", String(ctx.prNumber), "--delete-branch");
  ctx.git("push", "-q", "-f", "origin", "baseline-p3^{commit}:refs/heads/main");
}
