// Scenario 1: CI fails only remotely (testbed CI requires a CHANGELOG line that local tests never check).
// Expect a CI-REPAIR ticket, CI green on the final head, a ledger approval at that head, and a merge-ready PR.
import { createIssue, unitPrompt, prFor, tickets, ledgerApproved, checkConclusion, assert } from "../lib.mjs";

export const timeoutMinutes = 75;

export function setup(ctx) {
  const issue = createIssue(
    ctx,
    "Add multiply(a, b) to the math module",
    "src/math.js exports add. Add `multiply(a, b)` that returns the product of two numbers, with a unit test.\n\nAcceptance:\n- `multiply(3, 4)` returns 12\n- `multiply(-2, 5)` returns -10",
  );
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const pr = prFor(ctx, ctx.issue);
  assert.ok(pr, "a PR closes the issue");
  assert.equal(pr.state, "OPEN", "autonomy stop leaves the PR open");
  const t = tickets(ctx, pr.headRefName);
  assert.ok(t.some((x) => x.startsWith("CI-REPAIR")), `a CI-REPAIR ticket ran (tickets: ${t.join(", ")})`);
  assert.equal(checkConclusion(ctx, pr.headRefOid), "success", "CI is green on the final head");
  assert.ok(ledgerApproved(ctx, ctx.issue, pr.headRefOid), "the ledger approves the final head");
}
