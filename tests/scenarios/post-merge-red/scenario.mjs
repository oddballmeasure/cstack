// Scenario 8: a merged change breaks main's CI. Deterministic: no Claude session. The setup merges a PR
// that adds a failing unit test, records it as a merged unit, and the expectation runs
// gates/post-merge.mjs directly. Expect one re-run of the failed Actions run, then exactly one
// follow-up issue labelled cstack:ready, and nothing new on a second judgement.
import { assert, closeIssue, createIssue, orchCli, restoreMain, storeOf, waitUntil } from "../lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 5;
const RUN = "post-merge-red";

export async function setup(ctx) {
  const issue = createIssue(ctx, "Scenario: a change that breaks main", "Seeded by the post-merge-red scenario. Do not work this issue.");
  const branch = `scenario/post-merge-red-${Date.now()}`;
  ctx.git("checkout", "-q", "-b", branch, "origin/main");
  mkdirSync(path.join(ctx.testbed, "test"), { recursive: true });
  writeFileSync(path.join(ctx.testbed, "test/broken.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("broken on purpose", () => assert.equal(1, 2));\n');
  ctx.git("add", "-A");
  ctx.git("commit", "-qm", "Scenario: add a failing test");
  ctx.git("push", "-q", "origin", branch);
  const url = ctx.gh("pr", "create", "--head", branch, "--base", "main", "--title", "Scenario: add a failing test", "--body", `Closes #${issue}`);
  const pr = Number(url.split("/").pop());
  ctx.gh("pr", "merge", String(pr), "--merge", "--delete-branch");
  const mergeSha = await waitUntil(() => JSON.parse(ctx.gh("pr", "view", String(pr), "--json", "mergeCommit")).mergeCommit?.oid, { minutes: 2, label: "the merge commit", everyMs: 3000 });
  ctx.git("checkout", "-q", "main");
  const store = storeOf(ctx, RUN);
  const orch = orchCli(ctx, store);
  orch("init");
  orch("unit", "add", "U1", "--track", "core", "--issue", String(issue), "--state", "ready");
  orch("unit", "set", "U1", "--state", "merged", "--pr", String(pr), "--sha", mergeSha);
  Object.assign(ctx, { store, pr, mergeSha, started: new Date().toISOString() });
  return { issue, prompt: null };
}

function judge(ctx) {
  const out = ctx.sh("node", [path.join(ctx.cstack, "gates/post-merge.mjs"), "--store", ctx.store, "--wait", "--json"], {
    allowFail: true,
    env: { ...process.env, CSTACK_POST_MERGE_POLL_MS: "30000" },
    timeout: 45 * 60e3,
  });
  return JSON.parse(out);
}

function followUps(ctx) {
  const title = `CI failed on main after #${ctx.pr}`;
  // List, not search: the search index lags new issues by up to a minute.
  return JSON.parse(ctx.gh("issue", "list", "--state", "all", "--limit", "200", "--json", "number,title,labels")).filter((i) => i.title.startsWith(title));
}

export function expect(ctx) {
  const first = judge(ctx);
  const m = first.merges.find((x) => x.pr === ctx.pr);
  assert.equal(m.state, "filed", `the red merge is filed: ${JSON.stringify(m)}`);
  const runs = JSON.parse(ctx.sh("gh", ["api", `repos/${ctx.repo}/actions/runs?head_sha=${ctx.mergeSha}`, "--jq", ".workflow_runs"]));
  assert.ok(runs.some((r) => r.run_attempt === 2), `the failed run was re-run once (attempts: ${runs.map((r) => r.run_attempt).join(",")})`);
  assert.ok(!runs.some((r) => r.run_attempt > 2), "never re-run twice");
  let issues = followUps(ctx);
  assert.equal(issues.length, 1, `exactly one follow-up (got ${issues.length})`);
  assert.ok(issues[0].labels.some((l) => l.name === "cstack:ready"), "the follow-up is labelled ready");
  const second = judge(ctx);
  assert.equal(second.merges.find((x) => x.pr === ctx.pr).state, "filed");
  issues = followUps(ctx);
  assert.equal(issues.length, 1, "a second judgement files nothing new");
  ctx.followUps = issues.map((i) => i.number);
}

export function teardown(ctx) {
  for (const n of ctx.followUps ?? followUps(ctx).map((i) => i.number)) closeIssue(ctx, n);
  closeIssue(ctx, ctx.issue);
  restoreMain(ctx);
}
