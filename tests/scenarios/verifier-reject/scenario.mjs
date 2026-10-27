// Scenario 3: a seeded requirement gap. The branch already has T1, which delivers R1 but not R2.
// Expect check-commit to pass, the verifier to reject, a REPAIR ticket, then an approval.
import { slug, createIssue, unitPrompt, seedUnit, tickets, ledgerApproved, storeFile, assert } from "../lib.mjs";

export const timeoutMinutes = 75;
const title = "Add clamp(value, min, max) to the math module";

export function setup(ctx) {
  const issue = createIssue(
    ctx,
    title,
    "Add `clamp(value, min, max)` to src/math.js.\n\nRequirements:\n- R1: values inside the range are returned unchanged\n- R2: values below min return min and values above max return max",
  );
  const intake = {
    classification: "feature",
    summary: "Add clamp to the math module",
    requirements: [
      { id: "R1", text: "clamp returns values inside [min, max] unchanged" },
      { id: "R2", text: "clamp returns min for values below min and max for values above max" },
    ],
    tickets: [{ id: "T1", title: "Implement clamp with tests", requirements: ["R1", "R2"], depends_on: [], target_files: ["src/math.js", "new:test/clamp.test.js"] }],
  };
  seedUnit(ctx, {
    issue,
    title,
    intake,
    commits: [
      {
        ticket: "T1",
        message: "Add clamp",
        files: {
          "src/math.js": "export const add = (a, b) => a + b;\nexport const clamp = (value, min, max) => value;\n",
          "test/clamp.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { clamp } from "../src/math.js";\ntest("inside the range", () => assert.equal(clamp(5, 0, 10), 5));\n',
        },
      },
    ],
  });
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const branch = `cstack/${ctx.issue}-${slug(title)}`;
  const t = tickets(ctx, branch);
  assert.ok(t.some((x) => x.startsWith("REPAIR")), `a REPAIR ticket ran (tickets: ${t.join(", ")})`);
  const ledger = storeFile(ctx, ctx.issue, "ledger.tsv") || "";
  assert.match(ledger, /\trejected\t/, "the verifier rejected the seeded head");
  ctx.git("fetch", "-q", "origin", branch);
  const head = ctx.git("rev-parse", `origin/${branch}`);
  assert.ok(ledgerApproved(ctx, ctx.issue, head), "the repaired head is approved");
}
