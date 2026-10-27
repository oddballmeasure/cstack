// Scenario 6: SIGKILL a Level B worker mid-unit. A fresh coordinator session runs cstack:resume-run.
// Expect the unit finished (merge-ready, autonomy stop) by a relaunched worker, with no duplicate
// commits, PRs or issue comments, and an approval at the final head.
import {
  UNATTENDED,
  assert,
  branchLog,
  closeIssue,
  coordinatorEnv,
  createIssue,
  issueComments,
  killUnit,
  launches,
  orchCli,
  prsFor,
  slug as titleSlug,
  stopRun,
  storeOf,
  unitName,
  waitUntil,
  workerCli,
} from "../lib.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

export const timeoutMinutes = 120;
const RUN = "worker-killed";
const title = "Add negate(a) to the math module";

export async function setup(ctx) {
  const issue = createIssue(ctx, title, "Add `negate(a)` to src/math.js returning -a, with a unit test.\n\n- R1: negate(5) returns -5\n- R2: negate(-2) returns 2");
  const store = storeOf(ctx, RUN);
  const orch = orchCli(ctx, store);
  orch("init");
  orch("unit", "add", "U1", "--track", "core", "--issue", String(issue), "--state", "ready");
  workerCli(ctx, ["launch", "--store", store, "--unit", "U1", "--plugin-dir", ctx.cstack]);
  const branch = `cstack/${issue}-${titleSlug(title)}`;
  // Kill once the worker has committed its first ticket: mid-unit, before publish.
  await waitUntil(
    () => {
      const r = ctx.sh("git", ["-C", ctx.testbed, "log", "--format=%(trailers:key=Cstack-Ticket,valueonly)", `origin/main..refs/heads/${branch}`], { allowFail: true });
      return r.trim().length > 0;
    },
    { minutes: 45, label: "the worker's first ticket commit" },
  );
  await killUnit(ctx, unitName(RUN, "U1"));
  ctx.store = store;
  ctx.branch = branch;
  return {
    issue,
    env: coordinatorEnv(RUN),
    prompt: `/cstack:resume-run ${RUN}\n\n${UNATTENDED}`,
  };
}

export function expect(ctx) {
  const prs = prsFor(ctx, ctx.issue);
  assert.equal(prs.length, 1, `exactly one PR closes the issue (got ${prs.length})`);
  const pr = prs[0];
  assert.ok(["OPEN", "MERGED"].includes(pr.state), `PR state ${pr.state}`);
  assert.ok(ledgerApprovedIn(ctx, pr.headRefOid), "the ledger approves the final head");
  const l = launches(ctx.store, "U1");
  assert.equal(l.length, 2, `one launch, one restart (launches: ${l.length})`);
  const decisions = readFileSync(path.join(ctx.store, "decisions.tsv"), "utf8");
  assert.match(decisions, /restart U1/, "resume-run logged the restart");
  const log = branchLog(ctx, pr.headRefName).split("\x1e").map((c) => c.trim()).filter(Boolean);
  const subjects = log.map((c) => c.split("\x00")[1]);
  assert.equal(new Set(subjects).size, subjects.length, `no duplicate commits: ${subjects.join(" | ")}`);
  const firstLines = issueComments(ctx, ctx.issue).map((b) => b.split("\n")[0]);
  assert.equal(new Set(firstLines).size, firstLines.length, `no duplicate issue comments: ${firstLines.join(" | ")}`);
  const state = orchCli(ctx, ctx.store)("unit", "get", "U1").split("\t")[2];
  assert.ok(["pr-open", "merged"].includes(state), `unit state ${state}`);
}

function ledgerApprovedIn(ctx, sha) {
  const r = ctx.sh("node", [path.join(ctx.cstack, "gates/orch.mjs"), "--store", ctx.store, "ledger", "check", "U1", sha], { allowFail: true });
  return /approved|verified/.test(r);
}

export function teardown(ctx) {
  stopRun(ctx, RUN);
  for (const pr of prsFor(ctx, ctx.issue)) if (pr.state === "OPEN") ctx.gh("pr", "close", String(pr.number), "--delete-branch");
  closeIssue(ctx, ctx.issue);
}
