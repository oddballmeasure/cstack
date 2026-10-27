// Scenario 0: one real issue end to end with autonomy send. Expect a merged PR, the issue labelled done,
// and a ledger approval at the merged head.
import { createIssue, unitPrompt, prFor, ledgerApproved, labels, assert } from "../lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 90;

export function setup(ctx) {
  const cfgPath = path.join(ctx.testbed, ".cstack/config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, autonomy: "send" }, null, 2) + "\n");
  ctx.git("commit", "-qam", "Scenario: autonomy send");
  ctx.git("push", "-q", "origin", "main");
  const issue = createIssue(ctx, "Add subtract(a, b) to the math module", "Add `subtract(a, b)` returning a - b, with a unit test.\n\n- R1: subtract(5, 3) returns 2\n- R2: subtract(3, 5) returns -2");
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const pr = prFor(ctx, ctx.issue);
  assert.ok(pr, "a PR closes the issue");
  assert.equal(pr.state, "MERGED", "autonomy send merges");
  assert.ok(ledgerApproved(ctx, ctx.issue, pr.headRefOid), "the merged head was approved");
  assert.ok(labels(ctx, ctx.issue).includes("cstack:done"), "the issue is labelled done");
}

export function teardown(ctx) {
  ctx.git("push", "-q", "-f", "origin", "baseline-p3^{commit}:refs/heads/main");
}
