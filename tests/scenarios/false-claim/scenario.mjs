// Scenario 4: the worker claimed green but the committed code fails its own test.
// Expect check-commit to reject on resume, a retry commit for T1, and green tests at the final head.
import { slug, createIssue, unitPrompt, seedUnit, tickets, storeFile, assert } from "../lib.mjs";
import { writeFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 75;
const title = "Add square(n) to the math module";

export function setup(ctx) {
  const issue = createIssue(ctx, title, "Add `square(n)` to src/math.js returning n*n, with a unit test.\n\n- R1: square(4) returns 16");
  const { store } = seedUnit(ctx, {
    issue,
    title,
    intake: {
      classification: "feature",
      summary: "Add square",
      requirements: [{ id: "R1", text: "square(n) returns n*n" }],
      tickets: [{ id: "T1", title: "Implement square", requirements: ["R1"], depends_on: [], target_files: ["src/math.js", "new:test/square.test.js"] }],
    },
    commits: [
      {
        ticket: "T1",
        message: "Add square",
        files: {
          "src/math.js": "export const add = (a, b) => a + b;\nexport const square = (n) => n + n;\n",
          "test/square.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { square } from "../src/math.js";\ntest("square", () => assert.equal(square(4), 16));\n',
        },
      },
    ],
  });
  writeFileSync(path.join(store, "feedback-U1.md"), "## T1 attempt 1\n\nWorker report: implemented square, all tests pass.\n");
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const branch = `cstack/${ctx.issue}-${slug(title)}`;
  const t = tickets(ctx, branch);
  assert.ok(t.filter((x) => x === "T1").length >= 2 || t.some((x) => x.startsWith("REPAIR")), `a retry commit followed the false claim (tickets: ${t.join(", ")})`);
  const log = storeFile(ctx, ctx.issue, "decisions.tsv") || "";
  assert.match(log, /check-commit/i, "the decision log records the check-commit result");
  ctx.git("fetch", "-q", "origin", branch);
  ctx.git("checkout", "-q", `origin/${branch}`);
  ctx.sh("npm", ["test"], { cwd: ctx.testbed });
}
