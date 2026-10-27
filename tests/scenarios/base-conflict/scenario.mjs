// Scenario 2: the base moves under a finished unit and conflicts with it.
// The branch already holds a complete T1; main then changes the same line. Expect a SYNC ticket,
// a "Merge main into" commit, no conflict markers, and an approval at the new head.
import { slug, createIssue, unitPrompt, seedUnit, tickets, ledgerApproved, assert } from "../lib.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 75;
const title = "Make add() reject non-numbers";

export function setup(ctx) {
  const issue = createIssue(ctx, title, "add(a, b) must throw a TypeError when either argument is not a number.\n\n- R1: add(1, '2') throws TypeError\n- R2: add(2, 3) still returns 5");
  seedUnit(ctx, {
    issue,
    title,
    intake: {
      classification: "feature",
      summary: "Validate add arguments",
      requirements: [
        { id: "R1", text: "add throws TypeError for non-number arguments" },
        { id: "R2", text: "add still returns the sum of two numbers" },
      ],
      tickets: [{ id: "T1", title: "Validate add", requirements: ["R1", "R2"], depends_on: [], target_files: ["src/math.js", "new:test/add-validate.test.js"] }],
    },
    commits: [
      {
        ticket: "T1",
        message: "Validate add arguments",
        files: {
          "src/math.js": 'export const add = (a, b) => {\n  if (typeof a !== "number" || typeof b !== "number") throw new TypeError("add expects numbers");\n  return a + b;\n};\n',
          "test/add-validate.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\ntest("rejects strings", () => assert.throws(() => add(1, "2"), TypeError));\ntest("adds numbers", () => assert.equal(add(2, 3), 5));\n',
          "CHANGELOG.md": `# Changelog\n\n- Validate add() arguments (#${issue})\n`,
        },
      },
    ],
  });
  // Main changes the same line: add() gains a doc comment and a different body shape.
  ctx.git("checkout", "-q", "main");
  writeFileSync(path.join(ctx.testbed, "src/math.js"), "/** Sum two values. */\nexport const add = (a, b) => Number(a) + Number(b);\n");
  ctx.git("commit", "-qam", "Coerce add() arguments to numbers");
  ctx.git("push", "-q", "origin", "main");
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const branch = `cstack/${ctx.issue}-${slug(title)}`;
  const t = tickets(ctx, branch);
  assert.ok(t.some((x) => x.startsWith("SYNC")), `a SYNC ticket ran (tickets: ${t.join(", ")})`);
  ctx.git("fetch", "-q", "origin", branch, "main");
  const head = ctx.git("rev-parse", `origin/${branch}`);
  assert.equal(ctx.sh("git", ["-C", ctx.testbed, "merge-base", "--is-ancestor", "origin/main", head], { allowFail: true }), "", "the branch contains the new main");
  const src = ctx.git("show", `${head}:src/math.js`);
  assert.doesNotMatch(src, /^(<{7}|>{7}|={7})/m, "no conflict markers");
  assert.match(src, /TypeError/, "the unit's behaviour survived the merge");
  assert.ok(ledgerApproved(ctx, ctx.issue, head), "the merged head is approved");
}

export function teardown(ctx) {
  // Put main back for the next scenario.
  ctx.git("push", "-q", "-f", "origin", "baseline-p3^{commit}:refs/heads/main");
}
