// The forge CLI (gates/forge.mjs) and the github backend's skill verbs, through the scenario-driven fake gh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gate, write, path } from "./helpers.mjs";

// A directory with a cstack config for o/r, a scenario of [match, ...responses] rules, and a runner.
function setup(rules, { config = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-forge-"));
  if (config) write(dir, ".cstack/config.json", JSON.stringify({ repo: "o/r" }));
  const scenario = path.join(dir, "gh.json");
  const log = path.join(dir, "gh.log");
  writeFileSync(scenario, JSON.stringify({ rules: rules.map(([match, ...responses]) => ({ match, responses })) }));
  // A trailing { env } object adds environment variables for that call.
  const run = (...args) => {
    const extra = typeof args.at(-1) === "object" ? args.pop()["env"] : {};
    return gate("forge.mjs", args, { cwd: dir, env: { FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: log, ...extra } });
  };
  const calls = () => readFileSync(log, "utf8").trim().split("\n");
  return { dir, run, calls };
}

const RATE = { stderr: "GraphQL: API rate limit exceeded for user ID 1.\n", code: 1 };
const fail = (stderr) => ({ stderr: `${stderr}\n`, code: 1 });

const view = {
  number: 5,
  title: "Fix it",
  url: "https://github.com/o/r/pull/5",
  state: "OPEN",
  isDraft: false,
  headRefName: "cstack/u1",
  headRefOid: "a".repeat(40),
  baseRefName: "main",
  baseRefOid: "b".repeat(40),
  mergeStateStatus: "BEHIND",
  reviewDecision: "REVIEW_REQUIRED",
  mergeCommit: null,
  mergedAt: null,
  files: [{ path: "src/f.js" }],
  author: { login: "dev", is_bot: false },
  body: "Closes #3",
  autoMergeRequest: { enabledAt: "x" },
  headRepository: { name: "r" },
  headRepositoryOwner: { login: "fork" },
  commits: [{}, {}],
};

const pull = (over = {}) => ({
  number: 7,
  html_url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: false,
  merged_at: null,
  merge_commit_sha: "c".repeat(40),
  head: { sha: "a".repeat(40), ref: "cstack/u1", repo: { full_name: "o/r" } },
  base: { ref: "main", sha: "b".repeat(40) },
  title: "T",
  user: { login: "dev", type: "User" },
  body: "Closes #3",
  auto_merge: null,
  ...over,
});

test("repo and user", () => {
  const s = setup([
    ["^repo view o/r --json", { json: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" }, url: "https://github.com/o/r" } }],
    ["^repo view --json", { json: { nameWithOwner: "x/y", defaultBranchRef: { name: "trunk" }, url: "u" } }],
    ["^api user$", { json: { login: "me", name: "Me", type: "User" } }, { json: { login: "bot[bot]", name: null, type: "Bot" } }],
  ]);
  assert.deepEqual(s.run("repo", "--json").json, { path: "o/r", defaultBranch: "main", url: "https://github.com/o/r" });
  assert.equal(s.run("repo").out, "o/r default main https://github.com/o/r\n");
  assert.equal(s.run("user").out, "me\n");
  assert.deepEqual(s.run("user", "--json").json, { login: "bot[bot]", name: null, bot: true });
  assert.equal(s.run("user").out, "bot[bot] (bot)\n");
  // Without a config, repo reads the cwd's checkout and other verbs need --repo.
  const bare = setup([["^repo view --json", { json: { nameWithOwner: "x/y", defaultBranchRef: { name: "trunk" }, url: "u" } }], ["^pr view 5 --repo x/y", { json: view }]], { config: false });
  assert.equal(bare.run("repo", "--json").json.path, "x/y");
  const r = bare.run("change", "view", "5");
  assert.equal(r.code, 2);
  assert.match(r.err, /no repo/);
  assert.equal(bare.run("change", "view", "5", "--repo", "x/y").code, 0);
});

test("change view: GraphQL detail, REST on a rate limit, and a plain failure", () => {
  const s = setup([
    ["^pr view 5 ", { json: view }, { json: { ...view, author: null, headRepository: null, autoMergeRequest: null, reviewDecision: "APPROVED", isDraft: true } }],
    ["^pr view 6 ", RATE],
    ["^api repos/o/r/pulls/6$", { json: pull({ number: 6, merged_at: "2026-10-30", mergeable_state: "clean", commits: 3, user: null, body: null, auto_merge: {}, draft: true }) }],
    ["^pr view 8 ", RATE],
    ["^api repos/o/r/pulls/8$", { json: pull({ number: 8, user: { login: "b", type: "Bot" }, head: { sha: "a", ref: "x", repo: null } }) }],
    ["^pr view 9 ", fail("HTTP 404: not found")],
  ]);
  const c = s.run("change", "view", "5", "--json").json;
  assert.deepEqual(
    { id: c.id, state: c.state, branch: c.branch, merge: c.merge, author: c.author, bot: c.bot, autoMerge: c.autoMerge, headRepo: c.headRepo, commits: c.commits, reviewRequired: c.reviewRequired, files: c.files },
    { id: 5, state: "open", branch: "cstack/u1", merge: "behind", author: "dev", bot: false, autoMerge: true, headRepo: "fork/r", commits: 2, reviewRequired: true, files: ["src/f.js"] },
  );
  assert.ok(s.calls()[0].includes(" --json number,title,url,state,isDraft,headRefName,headRefOid,"));
  const t = s.run("change", "view", "5");
  assert.match(t.out, /^#5 open draft cstack\/u1 -> main head aaaaaaaaaaaa merge behind/);
  assert.match(t.out, /author: ghost; review approved; auto-merge off; commits 2/);

  const m = s.run("change", "view", "6", "--json").json;
  assert.deepEqual(
    { state: m.state, mergeSha: m.mergeSha, merge: m.merge, commits: m.commits, author: m.author, body: m.body, autoMerge: m.autoMerge, draft: m.draft, headRepo: m.headRepo, review: m.review },
    { state: "merged", mergeSha: "c".repeat(40), merge: "clean", commits: 3, author: "ghost", body: "", autoMerge: true, draft: true, headRepo: "o/r", review: "none" },
  );
  const b = s.run("change", "view", "8");
  assert.match(b.out, /merge unknown/);
  assert.match(b.out, /author: b \(bot\); review none; auto-merge off; commits null/);
  assert.equal(s.run("change", "view", "8", "--json").json.headRepo, null);

  const e = s.run("change", "view", "9");
  assert.equal(e.code, 1);
  assert.match(e.err, /gh pr view 9 failed: HTTP 404/);
  assert.equal(s.run("change", "view", "x").code, 2);
  assert.equal(s.run("change", "view", "5", "extra").code, 2);
});

test("change find by head, base and state", () => {
  const s = setup([
    ["^api repos/o/r/pulls\\?state=open&per_page=100&head=o:cstack/u1&base=main$", { json: [pull()] }],
    ["^api repos/o/r/pulls\\?state=closed&per_page=100$", { json: [pull({ merged_at: "x", state: "closed" }), pull({ number: 8, state: "closed" })] }],
    ["^api repos/o/r/pulls\\?state=all&per_page=100&head=o:none$", { json: [] }],
  ]);
  const open = s.run("change", "find", "--head", "cstack/u1", "--base", "main", "--json").json;
  assert.deepEqual(open.map((c) => [c.id, c.state, c.branch, c.merge]), [[7, "open", "cstack/u1", "unknown"]]);
  assert.match(s.run("change", "find", "--head", "cstack/u1", "--base", "main").out, /^#7 open cstack\/u1 -> main head aaaaaaaaaaaa merge unknown https/);
  assert.deepEqual(s.run("change", "find", "--state", "merged", "--json").json.map((c) => c.id), [7]);
  assert.equal(s.run("change", "find", "--state", "closed", "--json").json.length, 2);
  assert.equal(s.run("change", "find", "--head", "none", "--state", "all").out, "no changes\n");
  const bad = s.run("change", "find", "--state", "draft");
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--state must be one of open, closed, merged, all/);
});

test("change create: GraphQL, one REST attempt on its rate limit, and failures", () => {
  const s = setup([
    ["^pr create .*--title ok", { stdout: "https://github.com/o/r/pull/11\n" }],
    ["^pr create .*--title other", fail("a pull request already exists")],
    ["^pr create", RATE],
    ["^api repos/o/r/pulls -f title=rest -f head=h -f base=main -F body=@b.md$", { json: { number: 12, html_url: "https://github.com/o/r/pull/12" } }],
    ["^api repos/o/r/pulls -f title=both", fail("HTTP 403: secondary rate limit")],
  ]);
  const args = (title) => ["change", "create", "--head", "h", "--base", "main", "--title", title, "--body-file", "b.md"];
  assert.deepEqual(s.run(...args("ok"), "--json").json, { ok: true, id: 11, url: "https://github.com/o/r/pull/11", via: "graphql" });
  assert.equal(s.run(...args("rest")).out, "#12 https://github.com/o/r/pull/12\n");
  const o = s.run(...args("other"));
  assert.equal(o.code, 1);
  assert.match(o.err, /change create failed: a pull request already exists/);
  const both = s.run(...args("both"));
  assert.equal(both.code, 1);
  assert.match(both.err, /GraphQL rate limited; REST failed too: HTTP 403/);
  assert.equal(s.run("change", "create", "--head", "h").code, 2);
  assert.ok(!s.calls().some((c) => c.includes("--draft")));
});

test("change edit, ready and comment", () => {
  const s = setup([
    ["^pr edit 5 --repo o/r --title T --body-file b.md$", {}],
    ["^pr edit 5 --repo o/r --body-file b.md$", {}],
    ["^pr edit 5 --repo o/r --title T$", fail("no")],
    ["^pr ready 5 --repo o/r$", {}],
    ["^pr comment 5 --repo o/r --body-file c.md$", {}],
  ]);
  assert.equal(s.run("change", "edit", "5", "--title", "T", "--body-file", "b.md").out, "edited #5\n");
  assert.equal(s.run("change", "edit", "5", "--body-file", "b.md").code, 0);
  assert.equal(s.run("change", "edit", "5", "--title", "T").code, 1);
  assert.equal(s.run("change", "edit", "5").code, 2);
  assert.equal(s.run("change", "ready", "5").out, "#5 ready\n");
  assert.equal(s.run("change", "comment", "5", "--body-file", "c.md", "--json").json.ok, true);
  assert.equal(s.run("change", "comment", "5").code, 2);
});

test("changes merged lists titles", () => {
  const s = setup([["^pr list --repo o/r --state merged --limit (10|3) --json number,title,url,mergedAt$", { json: [{ number: 4, title: "feat: x", url: "u", mergedAt: "d" }] }]]);
  assert.equal(s.run("changes", "merged").out, "#4 feat: x\n");
  assert.deepEqual(s.run("changes", "merged", "--limit", "3", "--json").json, [{ id: 4, title: "feat: x", url: "u", mergedAt: "d" }]);
  assert.equal(s.run("changes", "merged", "--limit", "x").code, 2);
});

test("checks and checks rerun", () => {
  const job = (name, conclusion, run) => ({ name, status: "completed", conclusion, id: run, details_url: run ? `https://github.com/o/r/actions/runs/${run}/job/9` : null });
  const s = setup([
    ["^api repos/o/r/commits/s1/check-runs", { json: [job("lint", "success", 1), job("ci", "failure", 2), job("ext", "failure", null), job("ci2", "failure", 2)] }],
    ["^api repos/o/r/commits/s2/check-runs", { json: [job("ci", "success", 1)] }],
    ["^api repos/o/r/commits/s3/check-runs", { json: [job("ci", "failure", 3)] }],
    ["^api repos/o/r/commits/s4/check-runs", { json: [] }],
    ["^run rerun 2 --failed --repo o/r$", {}],
    ["^run rerun 3 ", fail("cannot rerun")],
  ]);
  assert.equal(s.run("checks", "s1").out, "fail ci https://github.com/o/r/actions/runs/2/job/9\nfail ci2 https://github.com/o/r/actions/runs/2/job/9\nfail ext\npass lint https://github.com/o/r/actions/runs/1/job/9\n");
  assert.equal(s.run("checks", "s4").out, "no checks\n");
  assert.equal(s.run("checks").code, 2);
  assert.deepEqual(s.run("checks", "rerun", "s1", "--json").json, { failed: ["ci", "ci2", "ext"], rerun: ["2"], skipped: [] });
  assert.equal(s.run("checks", "rerun", "s1").out, "re-ran 1 run(s) for ci, ci2, ext\n");
  assert.equal(s.run("checks", "rerun", "s2").out, "no failed checks\n");
  const r = s.run("checks", "rerun", "s3");
  assert.equal(r.code, 1);
  assert.match(r.err, /rerun failed for 3/);
  assert.equal(s.run("checks", "rerun").code, 2);
});

test("threads, reviews, reply and resolve", () => {
  const node = (id, resolved, author, line = 4) => ({ id, isResolved: resolved, path: "src/f.js", line, comments: { nodes: [{ author, body: "first\nmore", url: `u/${id}`, createdAt: "t1" }, { author: { login: "dev", __typename: "User" }, body: "reply", url: "u2", createdAt: "t2" }] } });
  const s = setup([
    ["^api graphql -f query=query.* -f owner=o -f name=r -F number=5$", { json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [node("T1", false, { login: "coderabbitai", __typename: "Bot" }), node("T2", true, null, null), { id: "T3", isResolved: true, path: "x", line: 1, comments: { nodes: [] } }] } } } } } }],
    ["^api graphql -f query=query.* -F number=6$", { json: { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } }],
    ["^api repos/o/r/pulls/5/reviews\\?per_page=100$", { json: [{ id: 1, state: "CHANGES_REQUESTED", user: { login: "bot", type: "Bot" }, body: "fix", commit_id: "abc", html_url: "r1", submitted_at: "2026-10-30T02:00:00Z" }, { id: 2, state: "APPROVED", user: null, body: "", commit_id: "abc", html_url: "r2", submitted_at: "2026-10-30T03:00:00Z" }] }],
    ["^api repos/o/r/issues/5/comments\\?per_page=100$", { json: [{ id: 3, user: { login: "dev", type: "User" }, body: "hello", html_url: "c1", created_at: "2026-10-30T01:00:00Z" }] }],
    ["^api repos/o/r/pulls/6/reviews", { json: [] }],
    ["^api repos/o/r/issues/6/comments", { json: [] }],
    ["^api graphql -f query=mutation\\(\\$thread:ID!,\\$body:String!\\).* -f thread=T1 -F body=@r.md$", { json: { data: { addPullRequestReviewThreadReply: { comment: { url: "https://x/c" } } } } }],
    ["^api graphql -f query=mutation.*addPullRequestReviewThreadReply.* -f thread=T9 ", fail("not found")],
    ["^api graphql -f query=mutation\\(\\$thread:ID!\\)\\{resolveReviewThread.* -f thread=T1$", {}],
  ]);
  const ts = s.run("threads", "5", "--json").json;
  assert.deepEqual(ts[0], { id: "T1", resolved: false, path: "src/f.js", line: 4, author: "coderabbitai", bot: true, body: "first\nmore", url: "u/T1", comments: [{ author: "coderabbitai", bot: true, body: "first\nmore", url: "u/T1", createdAt: "t1" }, { author: "dev", bot: false, body: "reply", url: "u2", createdAt: "t2" }] });
  assert.equal(ts[1].author, "ghost");
  assert.deepEqual([ts[2].author, ts[2].bot, ts[2].body, ts[2].comments], [null, false, "", []], "a thread with no comments does not crash");
  assert.equal(s.run("threads", "5", "--open").out, "open T1 src/f.js:4 coderabbitai (bot): first\n");
  assert.equal(s.run("threads", "5").out.split("\n")[1], "resolved T2 src/f.js:null ghost: first");
  assert.equal(s.run("threads", "6").out, "no threads\n");

  const rs = s.run("reviews", "5", "--json").json;
  assert.deepEqual(rs.map((r) => [r.id, r.kind, r.state, r.author, r.bot, r.commit]), [[3, "comment", null, "dev", false, null], [1, "review", "changes", "bot", true, "abc"], [2, "review", "approved", "ghost", false, "abc"]]);
  assert.equal(s.run("reviews", "5").out, "comment dev: hello\nreview changes bot (bot): fix\nreview approved ghost: \n");
  assert.equal(s.run("reviews", "6").out, "no reviews\n");

  assert.equal(s.run("thread", "reply", "5", "T1", "--body-file", "r.md").out, "replied https://x/c\n");
  assert.equal(s.run("thread", "reply", "5", "T9", "--body-file", "r.md").code, 1);
  assert.equal(s.run("thread", "reply", "5", "T1").code, 2);
  assert.equal(s.run("thread", "resolve", "5", "T1").out, "resolved T1\n");
  assert.equal(s.run("thread", "resolve", "5").code, 2);
});

test("issue verbs", () => {
  const issue = { number: 3, title: "Bug", body: "b", state: "OPEN", labels: [{ name: "cstack:ready" }], comments: [{ author: { login: "dev" }, body: "q", url: "c", createdAt: "t" }], author: { login: "dev" }, createdAt: "t0", url: "https://github.com/o/r/issues/3" };
  const s = setup([
    ["^issue view 3 --repo o/r --json number,title,body,state,labels,comments,author,createdAt,url$", { json: issue }, { json: { ...issue, labels: [], comments: [] } }],
    ["^issue list --repo o/r --state all --label cstack:ready --search Bug in:title --json number,title,state,labels,createdAt --limit 5$", { json: [{ number: 3, title: "Bug", state: "OPEN", labels: [] }] }],
    ["^issue list --repo o/r --state open --search x in:body ", { json: [] }],
    ["^issue create --repo o/r --title T --body-file b.md --label cstack:proposed$", { stdout: "https://github.com/o/r/issues/9\n" }],
    ["^issue create --repo o/r --title T --body-file b.md$", fail("HTTP 422")],
    ["^issue edit 3 --repo o/r --add-label a,b --remove-label c$", {}],
    ["^issue edit 3 --repo o/r --add-label a$", {}],
    ["^issue comment 3 --repo o/r --body-file c.md$", {}],
  ]);
  const v = s.run("issue", "view", "3", "--json").json;
  assert.deepEqual(v, { number: 3, title: "Bug", state: "open", labels: ["cstack:ready"], url: issue.url, author: "dev", bot: false, body: "b", createdAt: "t0", comments: [{ author: "dev", bot: false, body: "q", url: "c", createdAt: "t" }] });
  assert.equal(s.run("issue", "view", "3").out, `#3 open Bug\nlabels: none; 0 comment(s); ${issue.url}\n`);
  assert.equal(s.run("issue", "list", "--state", "all", "--label", "cstack:ready", "--search", "Bug", "--in", "title", "--limit", "5").out, "#3 open Bug\n");
  assert.equal(s.run("issue", "list", "--search", "x").out, "no issues\n");
  assert.equal(s.run("issue", "list", "--in", "comments").code, 2);
  assert.deepEqual(s.run("issue", "create", "--title", "T", "--body-file", "b.md", "--label", "cstack:proposed", "--json").json, { ok: true, id: 9, url: "https://github.com/o/r/issues/9" });
  assert.equal(s.run("issue", "create", "--title", "T", "--body-file", "b.md").code, 1);
  assert.equal(s.run("issue", "create", "--title", "T").code, 2);
  assert.equal(s.run("issue", "edit", "3", "--add-label", "a, b", "--remove-label", "c").out, "edited #3\n");
  assert.equal(s.run("issue", "edit", "3", "--add-label", "a").code, 0);
  assert.equal(s.run("issue", "edit", "3").code, 2);
  assert.equal(s.run("issue", "comment", "3", "--body-file", "c.md").out, "commented on #3\n");
  assert.equal(s.run("issue", "comment", "3").code, 2);
});

test("labels ensure and required-checks", () => {
  const s = setup([
    ["^label create cstack:ready --repo o/r --force --color 0e8a16 --description Ready$", {}],
    ["^label create cstack:done --repo o/r$", fail("label with name \"cstack:done\" already exists; use `--force` to update its color and description")],
    ["^label create bad --repo o/r$", fail("HTTP 403")],
    ["^api repos/o/r/rules/branches/main ", { stdout: "ci\nlint\n" }],
    ["^api repos/o/r/branches/main/protection/", { stdout: "ci\n\n" }],
    ["^api repos/o/r/rules/branches/dev ", fail("gh: Not Found (HTTP 404)")],
    ["^api repos/o/r/branches/dev/protection/", fail("gh: Upgrade to GitHub Pro (HTTP 403)")],
    ["^api repos/o/r/rules/branches/err ", fail("HTTP 500: boom")],
    ["^api repos/o/r/rules/branches/limited ", fail("gh: API rate limit exceeded for user (HTTP 403)")],
  ]);
  assert.equal(s.run("labels", "ensure", "cstack:ready", "--color", "0e8a16", "--description", "Ready").out, "ensured cstack:ready\n");
  assert.deepEqual(s.run("labels", "ensure", "cstack:done", "--json").json, { ok: true, done: ["cstack:done"], failed: [] });
  const bad = s.run("labels", "ensure", "cstack:done", "bad");
  assert.equal(bad.code, 1);
  assert.match(bad.err, /bad: HTTP 403/);
  assert.equal(s.run("labels", "ensure").code, 2);
  assert.deepEqual(s.run("required-checks", "main", "--json").json, ["ci", "lint"]);
  assert.equal(s.run("required-checks", "main").out, "ci\nlint\n");
  assert.equal(s.run("required-checks", "dev").out, "none\n");
  const e = s.run("required-checks", "err");
  assert.equal(e.code, 1);
  assert.match(e.err, /HTTP 500/);
  const limited = s.run("required-checks", "limited");
  assert.equal(limited.code, 1, "a rate-limit 403 is not 'no required checks'");
  assert.match(limited.err, /API rate limit exceeded/);
  assert.equal(s.run("required-checks").code, 2);
});

test("usage errors exit 2", () => {
  const s = setup([]);
  for (const args of [[], ["merge", "5"], ["change", "merge", "5"], ["repo", "x"], ["user", "x"], ["--bogus"]]) {
    const r = s.run(...args);
    assert.equal(r.code, 2, args.join(" "));
  }
  assert.match(s.run("pr", "merge").err, /usage: forge.mjs repo\|user/);
});

test("the grader role may run only read verbs", () => {
  const s = setup([["^issue view 3 ", { json: { number: 3, title: "T", state: "OPEN", labels: [], comments: [], body: "", createdAt: "2026-10-30T00:00:00Z" } }]]);
  const env = { CSTACK_ROLE: "grader" };
  for (const args of [["issue", "comment", "3", "--body-file", "c.md"], ["--json", "issue", "comment", "3", "--body-file", "c.md"], ["change", "create", "--head", "b"], ["labels", "ensure", "x"], ["thread", "resolve", "5", "t"], ["checks", "rerun", "abc"]]) {
    const r = s.run(...args, { env });
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, /the grader role reads only/);
  }
  assert.equal(s.run("issue", "view", "3", { env }).code, 0, "reads are fine");
});
