// Shared helpers for scenario setup and expectations.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function createIssue(ctx, title, body) {
  const url = ctx.gh("issue", "create", "--title", title, "--body", body, "--label", "cstack:ready");
  return Number(url.split("/").pop());
}

export function unitPrompt(issue, extra = "") {
  return `/cstack:unit ${issue}\n\nThis is an unattended scenario run: no human will answer questions. Take documented defaults instead of asking.${extra ? "\n\n" + extra : ""}`;
}

export function prFor(ctx, issue) {
  const list = JSON.parse(ctx.gh("pr", "list", "--state", "all", "--search", `Closes #${issue} in:body`, "--json", "number,state,headRefName,headRefOid,body,mergeCommit"));
  return list.find((p) => closes(issue).test(p.body)) || null;
}

export function branchLog(ctx, branch) {
  ctx.git("fetch", "-q", "origin", branch);
  return ctx.git("log", "--format=%H%x00%s%x00%(trailers:only,unfold)%x1e", `origin/main..origin/${branch}`);
}

export function tickets(ctx, branch) {
  return [...branchLog(ctx, branch).matchAll(/Cstack-Ticket: (\S+)/g)].map((m) => m[1]);
}

export function ledgerApproved(ctx, issue, sha) {
  const store = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`);
  const r = ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, "ledger", "check", "U1", sha], { allowFail: true });
  return r.includes("approved") || r.includes("verified");
}

export function checkConclusion(ctx, sha, name = "ci") {
  const runs = JSON.parse(ctx.sh("gh", ["api", `repos/${ctx.repo}/commits/${sha}/check-runs`, "--jq", ".check_runs"]));
  const latest = runs.filter((r) => r.name === name).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
  return latest ? latest.conclusion : null;
}

export function labels(ctx, issue) {
  return JSON.parse(ctx.gh("issue", "view", String(issue), "--json", "labels")).labels.map((l) => l.name);
}

// Tool calls made anywhere in the session (main thread and subagents), and tool results that a hook blocked.
export function toolUses(ctx) {
  const out = [];
  for (const e of ctx.result.events) {
    for (const c of e.message?.content || []) if (c.type === "tool_use") out.push({ name: c.name, input: c.input });
  }
  return out;
}

export function hookBlocks(ctx, rule) {
  const hits = [];
  for (const e of ctx.result.events) {
    for (const c of e.message?.content || []) {
      if (c.type === "tool_result") {
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        if (text.includes(`cstack ${rule}`)) hits.push(text.slice(0, 200));
      }
    }
  }
  return hits;
}

export function storeFile(ctx, issue, rel) {
  const p = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export { assert };

export const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 40);

// Pre-seed a unit mid-flight: branch with commits, run store with U1 and an intake file.
export function seedUnit(ctx, { issue, title, intake, commits }) {
  const { writeFileSync, mkdirSync } = fs;
  const branch = `cstack/${issue}-${slug(title)}`;
  ctx.git("checkout", "-q", "-b", branch, "origin/main");
  for (const c of commits) {
    for (const [rel, text] of Object.entries(c.files)) {
      const p = path.join(ctx.testbed, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
    ctx.git("add", "-A");
    ctx.git("commit", "-q", "-m", `${c.message}\n\nCstack-Unit: U1\nCstack-Ticket: ${c.ticket}\nRefs: #${issue}`);
  }
  ctx.git("checkout", "-q", "main");
  const store = path.join(ctx.testbed, ".cstack/runs", `issue-${issue}`);
  const orch = (...a) => ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, ...a]);
  orch("init");
  orch("unit", "add", "U1", "--track", "issue", "--issue", String(issue), "--state", "ready");
  orch("unit", "set", "U1", "--state", "in-progress", "--branch", branch);
  writeFileSync(path.join(store, "intake-U1.json"), JSON.stringify({ issue, ...intake }, null, 2));
  return { branch, store };
}


// ---------- Phase 5: programs, workers, waits ----------

export const UNATTENDED = "This is an unattended scenario run: no human will answer questions. Take documented defaults instead of asking.";
export const REPO_NAME = "cstack-testbed";
export const storeOf = (ctx, slug) => path.join(ctx.testbed, ".cstack/runs", slug);
export const orchCli = (ctx, store) => (...a) => ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, ...a]);
export const workerCli = (ctx, args, env = {}) => ctx.sh("node", [path.join(ctx.cstack, "gates/worker.mjs"), ...args], { env: { ...process.env, ...env } });
export const unitName = (slug, unit) => `cstack-${REPO_NAME}-${slug}-${unit}`;
export const coordinatorEnv = (slug) => ({ CSTACK_COORDINATOR: "1", CSTACK_RUN: slug });

export function isActive(ctx, name) {
  return ctx.sh("systemctl", ["--user", "is-active", name], { allowFail: true }) === "active";
}

// Poll a condition from the scenario script (not a model session, so no guard hook applies).
export async function waitUntil(cond, { minutes = 30, label = "condition", everyMs = 10000 } = {}) {
  const end = Date.now() + minutes * 60e3;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${minutes} min waiting for ${label}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function killUnit(ctx, name) {
  ctx.sh("systemctl", ["--user", "kill", "--signal=SIGKILL", name], { allowFail: true });
  await waitUntil(() => !isActive(ctx, name), { minutes: 2, label: `${name} to stop`, everyMs: 1000 });
}

// Stop every worker and the coordinator of a run (teardown after a failed session).
export function stopRun(ctx, slug) {
  ctx.sh("systemctl", ["--user", "stop", `cstack-${REPO_NAME}-${slug}-*`], { allowFail: true });
}

export function restoreMain(ctx) {
  ctx.git("push", "-q", "-f", "origin", "baseline-p3^{commit}:refs/heads/main");
}

export function closeIssue(ctx, n) {
  ctx.sh("gh", ["issue", "close", String(n), "--repo", ctx.repo], { allowFail: true });
}

// Commit config and hidden-suite changes on testbed main (teardown restores baseline-p3).
export function commitMain(ctx, { config = {}, files = {}, remove = [] }, message) {
  const { writeFileSync, mkdirSync, rmSync } = fs;
  const cfgPath = path.join(ctx.testbed, ".cstack/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, ...config }, null, 2) + "\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ctx.testbed, rel)), { recursive: true });
    writeFileSync(path.join(ctx.testbed, rel), text);
  }
  for (const rel of remove) rmSync(path.join(ctx.testbed, rel), { force: true });
  ctx.git("add", "-A");
  ctx.git("commit", "-qm", message);
  ctx.git("push", "-q", "origin", "main");
}

// A planned program on the testbed: one issue, requirement, e2e requirement and lane per unit, a hidden
// suite with lane-named tests, and a store whose units.tsv, spec, e2e plan and plan pass check-plan.
// units: [{ title, body, requirement, lane: { title, test }, dependsOn?: ["U1"], files: [paths] }]
export function seedProgram(ctx, slug, units, { autonomy = "stop", parallel = 1 } = {}) {
  const { writeFileSync, mkdirSync } = fs;
  const suite = [
    "// Hidden acceptance suite for a scenario program. Implementers must never read this file.",
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    ...units.map((u, i) => `test(${JSON.stringify(`E${i + 1}.1 ${u.lane.title}`)}, async () => {\n${u.lane.test}\n});`),
    "",
  ].join("\n");
  commitMain(
    ctx,
    {
      config: { autonomy, parallel, e2e_command: ["node", "--test", "--test-reporter=tap", "tests/acceptance/program.test.js"] },
      files: { "tests/acceptance/program.test.js": suite },
      remove: ["tests/acceptance/secret.test.js"],
    },
    `Scenario: program ${slug} (autonomy ${autonomy}, parallel ${parallel})`,
  );
  const store = storeOf(ctx, slug);
  const orch = orchCli(ctx, store);
  orch("init");
  mkdirSync(path.join(store, "units"), { recursive: true });
  const issues = units.map((u) => createIssue(ctx, u.title, u.body));
  const spec = [
    `# Spec: ${slug}`,
    "",
    "## Problem",
    "",
    "The math module lacks a few helpers.",
    "",
    "## Users",
    "",
    "- A developer who imports the testbed's modules.",
    "",
    "## Goals",
    "",
    ...units.map((u) => `- ${u.title}.`),
    "",
    "## Non-goals",
    "",
    "- Any change outside the named files.",
    "",
    "## Requirements",
    "",
    ...units.map((u, i) => `- R${i + 1}: ${u.requirement}`),
    "",
    "## E2E requirements",
    "",
    ...units.flatMap((u, i) => [`- E${i + 1}: A developer imports the helper and calls it.`, `  Covers: R${i + 1}`]),
    "",
    "## Constraints",
    "",
    "- Node 24, no dependencies.",
    "",
    "## Done predicate",
    "",
    `Done when all ${units.length} lanes in e2e-plan.md pass at the base branch head.`,
    "",
  ].join("\n");
  const e2e = [
    `# E2E plan: ${slug}`,
    "",
    "Suite: `tests/acceptance/program.test.js`.",
    "",
    "## Lanes",
    "",
    ...units.flatMap((u, i) => [
      `### E${i + 1}.1 ${u.lane.title}`,
      "",
      "Kind: positive",
      `Covers: R${i + 1}`,
      "Driver: library",
      "Script:",
      "1. Import the helper and call it.",
      `Evidence: /tmp/cstack-e2e/<run>/E${i + 1}.1.log`,
      `Pass when: ${u.requirement}`,
      "",
    ]),
    "## Red check",
    "",
    "| Lane | Result | Reason |",
    "|---|---|---|",
    ...units.map((u, i) => `| E${i + 1}.1 | FAIL | helper missing |`),
    "",
    "## Mutation spot-check",
    "",
    "| Lane | Break | Caught |",
    "|---|---|---|",
    "",
  ].join("\n");
  const plan = [
    `# Plan: ${slug}`,
    "",
    ...units.flatMap((u, i) => [`## U${i + 1} ${u.title}`, "", `Files: ${u.files.join(", ")}`, "Verify: `npm test`", "Size: S", ""]),
  ].join("\n");
  writeFileSync(path.join(store, "spec.md"), spec);
  writeFileSync(path.join(store, "e2e-plan.md"), e2e);
  writeFileSync(path.join(store, "plan.md"), plan);
  units.forEach((u, i) => {
    const id = `U${i + 1}`;
    writeFileSync(path.join(store, "units", `${id}.md`), `GOAL: ${u.title}.\n\nCONTEXT: issue #${issues[i]}, R${i + 1}: ${u.requirement}, lane E${i + 1}.1.\n`);
    orch("unit", "add", id, "--track", "core", "--state", u.dependsOn ? "planned" : "ready", "--issue", String(issues[i]), "--lanes", `E${i + 1}.1`, "--brief", `units/${id}.md`, ...(u.dependsOn ? ["--depends-on", u.dependsOn.join(",")] : []));
  });
  ctx.sh("node", [path.join(ctx.cstack, "gates/check-plan.mjs"), "--units", path.join(store, "units.tsv"), "--spec", path.join(store, "spec.md"), "--e2e", path.join(store, "e2e-plan.md"), "--plan", path.join(store, "plan.md")]);
  return { store, orch, issues };
}

// GitHub search is fuzzy ("#31" also matches other numbers), so filter on the exact "Closes #N" line.
const closes = (issue) => new RegExp(`(^|\\n)Closes #${issue}\\b`);

export function prsFor(ctx, issue) {
  const list = JSON.parse(ctx.gh("pr", "list", "--state", "all", "--search", `Closes #${issue} in:body`, "--json", "number,state,headRefName,headRefOid,mergedAt,mergeCommit,body"));
  return list.filter((p) => closes(issue).test(p.body));
}

export function issueComments(ctx, issue) {
  return JSON.parse(ctx.gh("issue", "view", String(issue), "--json", "comments")).comments.map((c) => c.body);
}

export function launches(store, unit) {
  const p = path.join(store, "workers", `${unit}.launches`);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
}
