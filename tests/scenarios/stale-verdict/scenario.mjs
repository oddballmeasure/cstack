// Scenario 12: an approval exists for an older head; a later push must make the merge gate refuse.
// Deterministic: no Claude session.
import { createIssue, seedUnit, assert } from "../lib.mjs";
import path from "node:path";

const title = "Stale verdict probe";

export function setup(ctx) {
  const issue = createIssue(ctx, title, "Probe for the merge gate. Do not work this issue.");
  const { branch, store } = seedUnit(ctx, {
    issue,
    title,
    intake: { classification: "chore", summary: "probe", requirements: [{ id: "R1", text: "probe" }], tickets: [{ id: "T1", title: "probe", requirements: ["R1"], depends_on: [], target_files: ["README.md"] }] },
    commits: [{ ticket: "T1", message: "Probe change", files: { "README.md": "# cstack-testbed\n\nProbe.\n" } }],
  });
  ctx.git("checkout", "-q", branch);
  const approved = ctx.git("rev-parse", "HEAD");
  ctx.git("push", "-q", "origin", branch);
  const url = ctx.gh("pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", `Closes #${issue}`);
  ctx.pr = Number(url.split("/").pop());
  const orch = (...a) => ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", store, ...a]);
  orch("ledger", "record", "U1", approved, "approved", "--pr", String(ctx.pr), "--evidence", "seeded");
  ctx.git("commit", "-q", "--allow-empty", "-m", "Someone pushes after the approval");
  ctx.git("push", "-q", "origin", branch);
  ctx.git("checkout", "-q", "main");
  ctx.store = store;
  return { issue, prompt: null };
}

export function expect(ctx) {
  const r = ctx.sh("node", [path.join(ctx.cstack, "gates/check-merge.mjs"), String(ctx.pr), "--unit", "U1", "--repo-dir", ctx.testbed, "--store", ctx.store, "--json"], { allowFail: true });
  const res = JSON.parse(r);
  assert.equal(res.approved, false);
  assert.ok(res.findings.some((f) => f.check === "ledger"), `the ledger check refused the new head: ${JSON.stringify(res.findings)}`);
}

export function teardown(ctx) {
  ctx.gh("pr", "close", String(ctx.pr), "--delete-branch");
  ctx.gh("issue", "close", String(ctx.issue));
}
