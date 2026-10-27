// Scenario 7: the coordinator dies mid-program (standing in for compaction or a crash). Two independent
// units run as Level B workers (parallel 2, autonomy stop). Once both workers are launched, the
// coordinator is SIGKILLed; its workers keep running. A fresh session runs cstack:resume-run.
// Expect the program to continue from the store: both units merge-ready with approvals, one PR per
// issue, and no worker launched twice (resume adopts the live workers instead of relaunching them).
import {
  UNATTENDED,
  assert,
  closeIssue,
  coordinatorEnv,
  killUnit,
  launches,
  orchCli,
  prsFor,
  restoreMain,
  seedProgram,
  stopRun,
  unitName,
  waitUntil,
  workerCli,
} from "../lib.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 150;
const RUN = "coordinator-compaction";

export async function setup(ctx) {
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
        title: "Add square(a) in src/square.js",
        body: "Create `src/square.js` exporting `square(a)` that returns a * a, with a unit test in `test/square.test.js`.\n\n- R2: square(4) returns 16",
        requirement: "`square(4)` returns `16`.",
        files: ["src/square.js", "test/square.test.js"],
        lane: { title: "square multiplies", test: '  const { square } = await import("../../src/square.js");\n  assert.equal(square(4), 16);' },
      },
    ],
    { autonomy: "stop", parallel: 2 },
  );
  ctx.store = store;
  ctx.issues = issues;
  workerCli(ctx, ["launch", "--store", store, "--coordinator", "--plugin-dir", ctx.cstack]);
  await waitUntil(() => launches(store, "U1").length > 0 && launches(store, "U2").length > 0, { minutes: 30, label: "both workers launched" });
  await killUnit(ctx, unitName(RUN, "coordinator"));
  return { issue: issues[0], env: coordinatorEnv(RUN), prompt: `/cstack:resume-run ${RUN}\n\n${UNATTENDED}` };
}

export function expect(ctx) {
  const orch = orchCli(ctx, ctx.store);
  ctx.issues.forEach((issue, i) => {
    const unit = `U${i + 1}`;
    const prs = prsFor(ctx, issue);
    assert.equal(prs.length, 1, `${unit}: exactly one PR (got ${prs.length})`);
    assert.equal(prs[0].state, "OPEN", `${unit}: autonomy stop leaves the PR open`);
    const row = orch("unit", "get", unit).split("\t");
    assert.equal(row[2], "pr-open", `${unit}: merge-ready`);
    const check = ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", ctx.store, "ledger", "check", unit, prs[0].headRefOid], { allowFail: true });
    assert.match(check, /approved|verified/, `${unit}: approval at the final head`);
    assert.equal(launches(ctx.store, unit).length, 1, `${unit}: the live worker was adopted, not relaunched`);
  });
  assert.equal(launches(ctx.store, "coordinator").length, 1, "only the original coordinator was launched as a unit");
  assert.match(readFileSync(path.join(ctx.store, "decisions.tsv"), "utf8"), /resume|orchestrate/, "the fresh session logged its pickup");
}

export function teardown(ctx) {
  stopRun(ctx, RUN);
  for (const issue of ctx.issues ?? []) {
    for (const pr of prsFor(ctx, issue)) if (pr.state === "OPEN") ctx.gh("pr", "close", String(pr.number), "--delete-branch");
    closeIssue(ctx, issue);
  }
  restoreMain(ctx);
}
