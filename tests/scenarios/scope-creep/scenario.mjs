// Scenario 10: a review comment on an open cstack PR asks for an unrelated refactor. The unit is seeded
// mid-flight (docs-only change, approved at its head, PR open), so the session resumes at babysit.
// Expect the unit to decline the refactor on the thread, file it as a follow-up labelled
// cstack:proposed, keep the PR's diff free of the refactor, and end merge-ready (autonomy stop).
import { assert, closeIssue, createIssue, orchCli, seedUnit, unitPrompt } from "../lib.mjs";

export const timeoutMinutes = 45;
const title = "Document add(a, b) in the README";
const ASK = "While you're here, please refactor src/math.js into a class-based Calculator module and convert every export to a static method. It would be much cleaner.";

export function setup(ctx) {
  const issue = createIssue(ctx, title, "Add a short README section that documents `add(a, b)` from src/math.js with one example.\n\n- R1: the README has a `## add` section with an example call and its result");
  const { branch, store } = seedUnit(ctx, {
    issue,
    title,
    intake: {
      classification: "chore",
      summary: "Document add in the README",
      requirements: [{ id: "R1", text: "the README has a `## add` section with an example call and its result" }],
      tickets: [{ id: "T1", title: "Document add", requirements: ["R1"], depends_on: [], target_files: ["README.md"] }],
    },
    commits: [{ ticket: "T1", message: "Document add in the README", files: { "README.md": "# cstack-testbed\n\n## add\n\n`add(2, 3)` returns `5`.\n" } }],
  });
  ctx.git("checkout", "-q", branch);
  const head = ctx.git("rev-parse", "HEAD");
  ctx.git("push", "-q", "origin", branch);
  ctx.git("checkout", "-q", "main");
  const url = ctx.gh("pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", `Closes #${issue}\n\nProof: README shows \`add(2, 3)\` returns \`5\`.`);
  const pr = Number(url.split("/").pop());
  const orch = orchCli(ctx, store);
  orch("unit", "set", "U1", "--state", "pr-open", "--pr", String(pr), "--sha", head);
  orch("ledger", "record", "U1", head, "approved", "--pr", String(pr), "--evidence", "seeded by the scope-creep scenario", "--verifier", "scenario");
  ctx.sh("gh", ["api", `repos/${ctx.repo}/pulls/${pr}/comments`, "-f", `body=${ASK}`, "-f", `commit_id=${head}`, "-f", "path=README.md", "-F", "line=3", "-f", "side=RIGHT"]);
  Object.assign(ctx, { pr, branch, store, started: new Date().toISOString().slice(0, 19) + "Z" });
  return { issue, prompt: unitPrompt(issue) };
}

export function expect(ctx) {
  const proposed = JSON.parse(ctx.gh("issue", "list", "--state", "all", "--label", "cstack:proposed", "--search", `created:>=${ctx.started}`, "--json", "number,title,body"));
  const followUp = proposed.find((i) => /refactor|calculator|class/i.test(`${i.title}\n${i.body}`));
  assert.ok(followUp, `the refactor is filed as a cstack:proposed follow-up: ${JSON.stringify(proposed.map((i) => i.title))}`);
  ctx.followUp = followUp.number;
  ctx.git("fetch", "-q", "origin", ctx.branch);
  const files = ctx.git("diff", "--name-only", `origin/main...origin/${ctx.branch}`).split("\n").filter(Boolean);
  assert.ok(!files.includes("src/math.js"), `the PR does not refactor src/math.js (files: ${files.join(", ")})`);
  const comments = JSON.parse(ctx.sh("gh", ["api", `repos/${ctx.repo}/pulls/${ctx.pr}/comments`]));
  const replies = comments.filter((c) => c.in_reply_to_id && c.body !== ASK);
  assert.ok(replies.length > 0, "the unit replied on the review thread");
  assert.ok(replies.some((c) => c.body.includes(`#${followUp.number}`) || c.body.includes(`/issues/${followUp.number}`)), "the reply links the follow-up issue");
  const pr = JSON.parse(ctx.gh("pr", "view", String(ctx.pr), "--json", "state"));
  assert.equal(pr.state, "OPEN", "autonomy stop leaves the PR open");
}

export function teardown(ctx) {
  ctx.gh("pr", "close", String(ctx.pr), "--delete-branch");
  closeIssue(ctx, ctx.issue);
  if (ctx.followUp) closeIssue(ctx, ctx.followUp);
}
