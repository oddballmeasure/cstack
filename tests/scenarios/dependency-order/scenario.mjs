// Scenario 11: unit U2 depends on U1. Autonomy send (set on testbed main and restored, as happy-merge
// does), parallel 2, so a scheduler that ignored the dependency could start both at once. One headless
// coordinator session runs cstack:orchestrate. Expect both PRs merged, U2's worker launched only after
// U1's PR merged, U2's first commit after that merge, and every merge judged by post-merge.
import { UNATTENDED, assert, closeIssue, coordinatorEnv, launches, prsFor, restoreMain, seedProgram, stopRun } from "../lib.mjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 180;
const RUN = "dependency-order";

export function setup(ctx) {
  const { store, issues } = seedProgram(
    ctx,
    RUN,
    [
      {
        title: "Add negate(a) in src/negate.js",
        body: "Create `src/negate.js` exporting `negate(a)` that returns -a, with a unit test in `test/negate.test.js`.\n\n- R1: negate(5) returns -5",
        requirement: "`negate(5)` returns `-5`.",
        files: ["src/negate.js", "test/negate.test.js"],
        lane: { title: "negate flips the sign", test: '  const { negate } = await import("../../src/negate.js");\n  assert.equal(negate(5), -5);' },
      },
      {
        title: "Add subtract(a, b) built on negate",
        body: "Create `src/subtract.js` exporting `subtract(a, b)` that returns `add(a, negate(b))`, importing `add` from src/math.js and `negate` from src/negate.js (added by the unit this one depends on). Add a unit test in `test/subtract.test.js`.\n\n- R2: subtract(5, 3) returns 2",
        requirement: "`subtract(5, 3)` returns `2`.",
        files: ["src/subtract.js", "test/subtract.test.js"],
        dependsOn: ["U1"],
        lane: { title: "subtract uses negate", test: '  const { subtract } = await import("../../src/subtract.js");\n  assert.equal(subtract(5, 3), 2);' },
      },
    ],
    { autonomy: "send", parallel: 2 },
  );
  ctx.store = store;
  ctx.issues = issues;
  return { issue: issues[0], env: coordinatorEnv(RUN), prompt: `/cstack:orchestrate --run ${RUN}\n\n${UNATTENDED}` };
}

export function expect(ctx) {
  const [a, b] = ctx.issues.map((n) => prsFor(ctx, n));
  assert.equal(a.length, 1, "one PR for U1");
  assert.equal(b.length, 1, "one PR for U2");
  assert.equal(a[0].state, "MERGED", "U1 merged");
  assert.equal(b[0].state, "MERGED", "U2 merged");
  const aMerged = Date.parse(a[0].mergedAt);
  const u2Launch = launches(ctx.store, "U2")[0];
  assert.ok(u2Launch, "U2 ran as a Level B worker");
  assert.ok(Date.parse(u2Launch[0]) > aMerged, `U2 launched (${u2Launch[0]}) after U1 merged (${a[0].mergedAt})`);
  ctx.git("fetch", "-q", "origin");
  const first = ctx.git("log", "--reverse", "--format=%cI", `${a[0].mergeCommit.oid}..${b[0].mergeCommit.oid}^2`).split("\n")[0];
  assert.ok(Date.parse(first) > aMerged, `U2's first commit (${first}) is after U1's merge`);
  const pm = path.join(ctx.store, "post-merge.tsv");
  assert.ok(existsSync(pm), "post-merge judged the merges");
  const judged = readFileSync(pm, "utf8");
  for (const pr of [a[0], b[0]]) assert.match(judged, new RegExp(`\\t${pr.number}\\t`), `post-merge has a row for #${pr.number}`);
}

export function teardown(ctx) {
  stopRun(ctx, RUN);
  for (const issue of ctx.issues ?? []) {
    for (const pr of prsFor(ctx, issue)) if (pr.state === "OPEN") ctx.gh("pr", "close", String(pr.number), "--delete-branch");
    closeIssue(ctx, issue);
  }
  restoreMain(ctx);
}
