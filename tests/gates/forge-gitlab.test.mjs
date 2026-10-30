// The gitlab forge backend (gates/lib/forge-gitlab.mjs) against the scenario-driven fake glab. The response shapes
// are the ones measured on gitlab.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FAKE_BIN, GATES } from "./helpers.mjs";

const MOD = pathToFileURL(path.join(GATES, "lib", "forge-gitlab.mjs")).href;
const P = "projects/grp%2Fsub%2Fapp";

// Runs `code` against a gitlab backend for grp/sub/app with the given fake glab rules; returns its JSON output.
function call(rules, code, { host = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-glab-"));
  const scenario = path.join(dir, "scenario.json");
  const log = path.join(dir, "glab.log");
  writeFileSync(scenario, JSON.stringify({ rules }));
  writeFileSync(path.join(dir, "body.md"), "the body\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { gitlab } from ${JSON.stringify(MOD)};\nconst f = gitlab("grp/sub/app", ${JSON.stringify(dir)}, ${JSON.stringify(host)});\nconst body = ${JSON.stringify(path.join(dir, "body.md"))};\nconsole.log(JSON.stringify(await (async () => { ${code} })()));`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_GLAB_SCENARIO: scenario, FAKE_GLAB_LOG: log },
  });
  const calls = (() => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })();
  return { code: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout) : null, err: r.stderr, calls };
}

const mr = (o = {}) => ({ iid: 7, web_url: "https://gitlab.com/grp/sub/app/-/merge_requests/7", state: "opened", draft: false, sha: "h".repeat(40), target_branch: "main", diff_refs: { base_sha: "b".repeat(40) }, detailed_merge_status: "mergeable", diverged_commits_count: 0, merge_commit_sha: null, merged_at: null, ...o });

test("change: fields, files, merge-state mapping and diverged commits", () => {
  const states = ["mergeable", "conflict", "need_rebase", "checking", "ci_must_pass", "requested_changes"];
  const rules = [
    { match: `^api -X GET ${P}/merge_requests/7/changes$`, responses: [{ json: { changes: [{ new_path: "src/a.js" }, { new_path: "README.md" }] } }] },
    { match: `^api -X GET ${P}/merge_requests/7\\?include_diverged_commits_count=true$`, responses: [...states.map((s, i) => ({ json: mr({ detailed_merge_status: s, diverged_commits_count: i }) })), { json: mr({ state: "merged", merge_commit_sha: "m".repeat(40), merged_at: "2026-10-30T00:00:00Z", draft: true, diff_refs: null }) }, { json: mr({ state: "locked", diverged_commits_count: undefined }) }, { json: mr({ state: "weird" }) }] },
  ];
  const r = call(rules, `const out = [f.change(7)]; for (let i = 0; i < 8; i++) out.push(f.change(7, [])); return out;`);
  assert.equal(r.code, 0, r.err);
  const [first, ...rest] = r.out;
  assert.deepEqual(first, { id: 7, url: "https://gitlab.com/grp/sub/app/-/merge_requests/7", state: "open", draft: false, head: "h".repeat(40), base: "main", baseSha: "b".repeat(40), merge: "clean", mergeRaw: "mergeable", behind: 0, review: "none", reviewRaw: "", files: ["src/a.js", "README.md"], mergeSha: null, mergedAt: null });
  assert.deepEqual(rest.slice(0, 5).map((c) => [c.merge, c.behind]), [["conflict", 1], ["behind", 2], ["unknown", 3], ["blocked", 4], ["blocked", 5]]);
  assert.deepEqual([rest[4].review, rest[4].reviewRaw], ["changes", "REQUESTED_CHANGES"]);
  assert.deepEqual([rest[5].state, rest[5].mergeSha, rest[5].mergedAt, rest[5].draft, rest[5].baseSha], ["merged", "m".repeat(40), "2026-10-30T00:00:00Z", true, null]);
  assert.deepEqual([rest[6].state, rest[6].behind], ["closed", 0], "a locked MR reads as closed; no count means 0");
  assert.equal(rest[7].state, "weird", "an unknown state passes through");
  assert.equal(r.calls.filter((c) => c.endsWith("/changes")).length, 1, "files only when asked");
});

test("merge at an exact sha; a moved head is refused; errors name the call", () => {
  const rules = [
    { match: `^api -X PUT ${P}/merge_requests/7/merge -f sha=h{40}$`, responses: [{ json: { state: "merged" } }, { stderr: "glab: SHA does not match HEAD of source branch (HTTP 409)\n", code: 1 }] },
    { match: `merge_requests/8`, responses: [{ stderr: "404 Not Found", code: 1 }] },
    { match: `merge_requests/9`, responses: [{ stdout: "{\"message\":\"404\"}", code: 1 }] },
  ];
  const r = call(rules, `const a = f.merge(7, "${"h".repeat(40)}"); const b = f.merge(7, "${"h".repeat(40)}"); let e, g; try { f.change(8); } catch (x) { e = x.message; } try { f.change(9); } catch (x) { g = x.message; } return [a, b, e, g];`);
  assert.deepEqual(r.out[0], { ok: true, error: "" });
  assert.deepEqual(r.out[1], { ok: false, error: "glab: SHA does not match HEAD of source branch (HTTP 409)" });
  assert.match(r.out[2], /^glab api GET projects\/grp%2Fsub%2Fapp\/merge_requests\/8\?include_diverged_commits_count=true failed: 404 Not Found$/);
  assert.match(r.out[3], /failed: \{"message":"404"\}$/, "glab can print the error on stdout");
});

test("checks: newest pipeline's jobs, newest per name, mapped to GitHub's words", () => {
  const job = (id, name, status, o = {}) => ({ id, name, status, started_at: `2026-10-30T00:00:0${id % 10}Z`, web_url: `https://gitlab.com/j/${id}`, allow_failure: false, ...o });
  const rules = [
    { match: `^api -X GET ${P}/pipelines\\?sha=s1`, responses: [{ json: [{ id: 10 }, { id: 12 }, { id: 11 }] }] },
    { match: `^api -X GET ${P}/pipelines\\?sha=s2`, responses: [{ json: [] }] },
    { match: `^api -X GET ${P}/pipelines/12/jobs`, responses: [{ json: [job(1, "test", "failed"), job(4, "test", "success"), job(2, "lint", "failed", { allow_failure: true }), job(3, "build", "canceled"), job(5, "deploy", "manual"), job(6, "docs", "skipped"), job(7, "e2e", "running", { started_at: null }), job(9, "zz", "failed")] }] },
  ];
  const r = call(rules, `return [f.checks("s1"), f.checks("s2")];`);
  assert.equal(r.code, 0, r.err);
  const [checks, none] = r.out;
  assert.deepEqual(none, []);
  assert.deepEqual(checks.map((c) => [c.name, c.state, c.status, c.conclusion]), [
    ["build", "fail", "completed", "cancelled"],
    ["deploy", "skipped", "completed", "skipped"],
    ["docs", "skipped", "completed", "skipped"],
    ["e2e", "pending", "in_progress", null],
    ["lint", "pass", "completed", "neutral"],
    ["test", "pass", "completed", "success"],
    ["zz", "fail", "completed", "failure"],
  ]);
  assert.deepEqual([checks[5].id, checks[5].url, checks[5].details_url, checks[3].started_at], [4, "https://gitlab.com/j/4", "https://gitlab.com/j/4", null]);
});

test("log tails strip colours and section markers; reruns retry the job", () => {
  const trace = "\x1b[0Ksection_start:1:step\r\x1b[0KRunning\nline 1\n\x1b[31;1mERROR boom\x1b[0;m\nsection_end:1:step\r\x1b[0K\nJob failed\n";
  const rules = [
    { match: `^api -X GET ${P}/jobs/4/trace$`, responses: [{ stdout: trace }, { stderr: "403 Forbidden", code: 1 }] },
    { match: `^api -X POST ${P}/jobs/4/retry$`, responses: [{ json: { id: 40 } }, { code: 1 }] },
  ];
  const r = call(rules, `const c = { id: 4 }; return [f.checkTail(c, 3), f.checkTail(c, 3), f.rerunHandle(c), f.rerunHandle({ id: "x" }), f.rerun("4"), f.rerun("4")];`);
  assert.deepEqual(r.out, ["line 1\nERROR boom\nJob failed", "(job log unavailable: 403 Forbidden)", "4", null, { ok: true }, { ok: false }]);
});

test("issues: view with notes, relabel, comment, list, create", () => {
  const issue = { iid: 3, title: "T", state: "opened", labels: ["cstack:ready"], description: null, created_at: "2026-10-30T00:00:00Z", web_url: "https://gitlab.com/grp/sub/app/-/work_items/3" };
  const rules = [
    { match: `^api -X GET ${P}/issues/3/notes`, responses: [{ json: [{ body: "hi", system: false }, { body: "added label", system: true }] }, { stderr: "500", code: 1 }] },
    { match: `^api -X GET ${P}/issues/3$`, responses: [{ json: issue }] },
    { match: `^api -X GET ${P}/issues/9$`, responses: [{ stderr: "404 Not Found", code: 1 }] },
    { match: `^api -X PUT ${P}/issues/3 -f add_labels=a -f remove_labels=b,c$`, responses: [{ json: issue }] },
    { match: `^api -X PUT ${P}/issues/3$`, responses: [{ stderr: "nothing to change", code: 1 }] },
    { match: `^api -X POST ${P}/issues/3/notes -F body=@\\S*body\\.md$`, responses: [{ json: {} }] },
    { match: `^api -X GET ${P}/issues\\?state=opened&per_page=100&order_by=created_at&sort=desc&labels=cstack%3Aready --paginate$`, responses: [{ json: [issue] }] },
    { match: `^api -X GET ${P}/issues\\?state=all&per_page=100&order_by=created_at&sort=desc&search=Cstack-Scout&in=description --paginate$`, responses: [{ json: [issue, { ...issue, iid: 4, state: "closed", labels: undefined }] }] },
    { match: `^api -X POST ${P}/issues -F description=@\\S*body\\.md -f title=New -f labels=cstack:ready$`, responses: [{ json: issue }, { stderr: "422", code: 1 }] },
  ];
  const r = call(rules, `return [f.issue(3, ["labels", "comments"]), f.issue(3, ["title"]), f.issue(9, ["title"]), f.issue(3, ["comments"]), f.relabel(3, { add: ["a"], remove: ["b", "c"] }), f.relabel(3, {}), f.comment(3, body), f.issues({ label: "cstack:ready", want: ["number"] }), f.issues({ state: "all", search: "Cstack-Scout", want: [], limit: 1 }), f.issues({ state: "all", search: "Cstack-Scout", want: [] }), f.createIssue({ title: "New", bodyFile: body, label: "cstack:ready" }), f.createIssue({ title: "New", bodyFile: body, label: "cstack:ready" })];`);
  assert.equal(r.code, 0, r.err);
  const [full, plain, missing, noteFail, relabel, relabelFail, comment, labelled, limited, all, created, createFail] = r.out;
  assert.deepEqual(full, { ok: true, number: 3, title: "T", state: "open", labels: ["cstack:ready"], comments: ["hi"], body: "", createdAt: "2026-10-30T00:00:00Z" });
  assert.deepEqual(plain.comments, [], "notes only when asked");
  assert.deepEqual(missing, { ok: false, error: "404 Not Found" });
  assert.deepEqual(noteFail, { ok: false, error: "500" });
  assert.deepEqual([relabel, relabelFail, comment], [{ ok: true, error: "" }, { ok: false, error: "nothing to change" }, { ok: true, error: "" }]);
  assert.deepEqual(labelled.map((i) => i.number), [3]);
  assert.deepEqual(limited.map((i) => i.number), [3]);
  assert.deepEqual(all.map((i) => [i.number, i.state, i.labels]), [[3, "open", ["cstack:ready"]], [4, "closed", []]]);
  assert.deepEqual(created, { ok: true, id: 3, url: "https://gitlab.com/grp/sub/app/-/work_items/3" });
  assert.deepEqual(createFail, { ok: false, error: "422" });
});

test("changesOn lists MRs by source or target branch; a self-hosted host is passed to glab", () => {
  const rules = [
    { match: `^api --hostname git\\.example\\.com -X GET ${P}/merge_requests\\?source_branch=feat%2Fa&state=all`, responses: [{ json: [{ iid: 2, state: "merged", source_branch: "feat/a", target_branch: "main" }, { iid: 3, state: "opened", source_branch: "feat/a", target_branch: "main" }, { iid: 4, state: "weird", source_branch: "feat/a", target_branch: "main" }] }] },
    { match: `^api --hostname git\\.example\\.com -X GET ${P}/merge_requests\\?target_branch=feat%2Fa&state=all`, responses: [{ json: [] }] },
  ];
  const r = call(rules, `return [f.kind, f.name, f.repo, f.changesOn("--head", "feat/a"), f.changesOn("--base", "feat/a")];`, { host: "git.example.com" });
  assert.deepEqual(r.out, ["gitlab", "GitLab", "grp/sub/app", [{ pr: 2, state: "MERGED", branch: "feat/a", base: "main" }, { pr: 3, state: "OPEN", branch: "feat/a", base: "main" }, { pr: 4, state: "CLOSED", branch: "feat/a", base: "main" }], []]);
});

test("skill verbs: repo, user, change detail, find, merged, create, edit, ready, comment", () => {
  const full = mr({ title: "Fix", source_branch: "feat", author: { username: "dev", bot: false }, description: "Closes #3", merge_when_pipeline_succeeds: true, source_project_id: 1, target_project_id: 1 });
  const rules = [
    { match: `^api -X GET ${P}$`, responses: [{ json: { path_with_namespace: "grp/sub/app", default_branch: "main", web_url: "https://gitlab.com/grp/sub/app" } }] },
    { match: "^api -X GET user$", responses: [{ json: { username: "me", name: "Me", bot: true } }] },
    { match: `^api -X GET ${P}/merge_requests/7\\?include`, responses: [{ json: full }, { json: { ...full, source_project_id: 2, description: null, author: null, merge_when_pipeline_succeeds: false, auto_merge_enabled: true } }] },
    { match: `^api -X GET ${P}/merge_requests/7/changes$`, responses: [{ json: { changes: [{ new_path: "a.js" }] } }] },
    { match: `^api -X GET ${P}/merge_requests/7/commits`, responses: [{ json: [{}, {}] }] },
    { match: `^api -X GET ${P}/merge_requests/7/approvals$`, responses: [{ json: { approved: false, approvals_required: 1, approvals_left: 1 } }, { json: { approved: true, approvals_required: 1, approvals_left: 0 } }] },
    { match: `^api -X GET ${P}/merge_requests\\?state=opened&per_page=100&source_branch=feat%2Fa&target_branch=main$`, responses: [{ json: [full] }] },
    { match: `^api -X GET ${P}/merge_requests\\?state=all&per_page=100$`, responses: [{ json: [] }] },
    { match: `^api -X GET ${P}/merge_requests\\?state=opened&per_page=100$`, responses: [{ json: [mr()] }] },
    { match: `^api -X GET ${P}/merge_requests\\?state=merged&order_by=merged_at&sort=desc&per_page=2$`, responses: [{ json: [{ iid: 5, title: "Old", web_url: "u5", merged_at: "t" }] }] },
    { match: `^api -X POST ${P}/merge_requests -F description=@\\S*body\\.md -f source_branch=feat -f target_branch=main -f title=Fix$`, responses: [{ json: { iid: 9, web_url: "u9" } }, { stderr: "409 conflict", code: 1 }] },
    { match: `^api -X PUT ${P}/merge_requests/7 -F description=@\\S*body\\.md -f title=New$`, responses: [{ json: {} }] },
    { match: `^api -X PUT ${P}/merge_requests/7 -f title=Ready one$`, responses: [{ json: {} }] },
    { match: `^api -X PUT ${P}/merge_requests/7$`, responses: [{ stderr: "nothing", code: 1 }] },
    { match: `^api -X GET ${P}/merge_requests/7$`, responses: [{ json: { title: "Draft: Ready one" } }, { json: { title: "Ready one" } }] },
    { match: `^api -X POST ${P}/merge_requests/7/notes -F body=@\\S*body\\.md$`, responses: [{ json: {} }] },
  ];
  const r = call(rules, `return [f.repoInfo(), f.currentUser(), f.changeDetail(7), f.changeDetail(7), f.findChanges({ head: "feat/a", base: "main" }), f.findChanges({ state: "all" }), f.findChanges(), f.recentMerged(2), f.createChange({ head: "feat", base: "main", title: "Fix", bodyFile: body }), f.createChange({ head: "feat", base: "main", title: "Fix", bodyFile: body }), f.editChange(7, { title: "New", bodyFile: body }), f.editChange(7), f.markReady(7), f.markReady(7), f.commentChange(7, body)];`);
  assert.equal(r.code, 0, r.err);
  const [repo, me, d1, d2, found, all, none, merged, created, createFail, edited, editFail, ready, already, commented] = r.out;
  assert.deepEqual(repo, { path: "grp/sub/app", defaultBranch: "main", url: "https://gitlab.com/grp/sub/app" });
  assert.deepEqual(me, { login: "me", name: "Me", bot: true });
  assert.deepEqual([d1.title, d1.branch, d1.author, d1.bot, d1.body, d1.autoMerge, d1.headRepo, d1.commits, d1.reviewRequired, d1.review, d1.files], ["Fix", "feat", "dev", false, "Closes #3", true, "grp/sub/app", 2, true, "none", ["a.js"]]);
  assert.deepEqual([d2.headRepo, d2.body, d2.author, d2.reviewRequired, d2.review, d2.autoMerge], [null, "", "ghost", false, "approved", true], "a fork MR, no description, a deleted author, approved, auto-merge");
  assert.deepEqual([found.length, found[0].commits, all, none.map((c) => c.autoMerge)], [1, null, [], [false]]);
  assert.deepEqual(merged, [{ id: 5, title: "Old", url: "u5", mergedAt: "t" }]);
  assert.deepEqual([created, createFail], [{ ok: true, id: 9, url: "u9", via: "rest" }, { ok: false, error: "409 conflict" }]);
  assert.deepEqual([edited.ok, editFail.ok, ready.ok, already.ok, commented.ok], [true, false, true, true, true]);
});

test("skill verbs: threads, reviews, replies, resolving, issue detail, labels, required checks", () => {
  const n = (id, o = {}) => ({ id, body: `b${id}`, author: { username: "u", bot: false }, created_at: `2026-10-30T00:00:0${id}Z`, system: false, resolvable: false, resolved: false, ...o });
  const rules = [
    { match: `^api -X GET ${P}/merge_requests/7$`, responses: [{ json: { web_url: "https://g/mr/7" } }] },
    { match: `^api -X GET ${P}/merge_requests/7/discussions`, responses: [{ json: [
      { id: "d1", notes: [n(1, { resolvable: true, position: { new_path: "a.js", new_line: 4 }, author: { username: "bot1", bot: true } }), n(2, { resolvable: true, resolved: true }), n(3, { system: true })] },
      { id: "d2", notes: [n(4, { resolvable: true, resolved: true }), n(5, { resolvable: false })] },
      { id: "d3", notes: [n(6, { resolvable: true, system: true })] },
      { id: "d4", notes: [n(7)] },
      { id: "d5", notes: [] },
    ] }] },
    { match: `^api -X GET ${P}/merge_requests/7/approvals$`, responses: [{ json: { approved_by: [{ user: { username: "lead" } }] } }, { json: {} }] },
    { match: `^api -X POST ${P}/merge_requests/7/discussions/d1/notes -F body=@\\S*body\\.md$`, responses: [{ json: {} }, { stderr: "403", code: 1 }] },
    { match: `^api -X PUT ${P}/merge_requests/7/discussions/d1 -f resolved=true$`, responses: [{ json: {} }] },
    { match: `^api -X GET ${P}/issues/3$`, responses: [{ json: { iid: 3, title: "T", state: "opened", labels: ["x"], web_url: "https://g/i/3", author: { username: "a" }, description: "d", created_at: "t" } }, { json: { iid: 3, title: "T", state: "closed", author: null, created_at: "t" } }] },
    { match: `^api -X GET ${P}/issues/3/notes`, responses: [{ json: [n(8), n(9, { system: true })] }] },
    { match: `^api -X GET ${P}/issues\\?state=opened&per_page=100&order_by=created_at&sort=desc&search=CI%20failed&in=title --paginate$`, responses: [{ json: [] }] },
    { match: `^api -X POST ${P}/labels -f name=new -f color=#5319e7$`, responses: [{ json: {} }] },
    { match: `^api -X POST ${P}/labels -f name=old -f color=#5319e7$`, responses: [{ stdout: "{\"message\":\"Label already exists\"}", stderr: "409", code: 1 }] },
    { match: `^api -X POST ${P}/labels -f name=old -f color=#0e8a16 -f description=Ready$`, responses: [{ stderr: "Label already exists", code: 1 }] },
    { match: `^api -X PUT ${P}/labels/old -f new_name=old -f color=#0e8a16 -f description=Ready$`, responses: [{ json: {} }, { stderr: "500", code: 1 }] },
    { match: `^api -X POST ${P}/labels -f name=bad`, responses: [{ stderr: "403 Forbidden", code: 1 }] },
    { match: `^api -X POST ${P}/labels -f name=old -f color=#0e8a16$`, responses: [{ stderr: "Label already exists", code: 1 }] },
    { match: `^api -X PUT ${P}/labels/old -f new_name=old -f color=#0e8a16$`, responses: [{ json: {} }] },
    { match: `^api -X GET ${P}/pipelines\\?ref=main&per_page=1$`, responses: [{ json: [{ id: 50 }] }] },
    { match: `^api -X GET ${P}/pipelines\\?ref=dev&per_page=1$`, responses: [{ json: [] }] },
    { match: `^api -X GET ${P}/pipelines/50/jobs`, responses: [{ json: [{ name: "test", allow_failure: false }, { name: "lint", allow_failure: true }, { name: "build", allow_failure: false }, { name: "test", allow_failure: false }] }] },
  ];
  const r = call(rules, `return [f.threads(7), f.reviews(7), f.reviews(7), f.replyThread(7, "d1", body), f.replyThread(7, "d1", body), f.resolveThread(7, "d1"), f.issueDetail(3), f.issueDetail(3), f.ensureLabels(["new", "old"]), f.ensureLabels(["old"], "0e8a16", "Ready"), f.ensureLabels(["old", "bad"], "#0e8a16", "Ready"), f.requiredChecks("main"), f.requiredChecks("dev"), f.issues({ search: "CI failed", within: "title", want: [] }), f.ensureLabels(["old"], "0e8a16")];`);
  assert.equal(r.code, 0, r.err);
  const [threads, reviews, noApprovals, reply, replyFail, resolved, issue, closed, labels, updated, partly, required, noPipeline] = r.out;
  assert.deepEqual(threads.map((t) => [t.id, t.resolved, t.path, t.line, t.author, t.bot, t.comments.length]), [["d1", false, "a.js", 4, "bot1", true, 2], ["d2", true, null, null, "u", false, 2], ["d3", false, null, null, null, false, 0]]);
  assert.equal(threads[0].url, "https://g/mr/7#note_1");
  assert.deepEqual(reviews.map((x) => [x.kind, x.state, x.author]), [["comment", null, "u"], ["review", "approved", "lead"]]);
  assert.deepEqual(noApprovals.map((x) => x.kind), ["comment"]);
  assert.deepEqual([reply, replyFail.ok, resolved.ok], [{ ok: true, url: null }, false, true]);
  assert.deepEqual([issue.number, issue.state, issue.labels, issue.author, issue.body, issue.comments.map((c) => c.body)], [3, "open", ["x"], "a", "d", ["b8"]]);
  assert.deepEqual([closed.state, closed.labels, closed.author, closed.body, closed.comments[0].url], ["closed", [], "ghost", "", null]);
  assert.deepEqual(labels, { ok: true, done: ["new", "old"], failed: [] });
  assert.deepEqual(updated, { ok: true, done: ["old"], failed: [] });
  assert.deepEqual(partly, { ok: false, done: [], failed: [{ name: "old", error: "Label already exists" }, { name: "bad", error: "403 Forbidden" }] });
  assert.deepEqual([required, noPipeline], [["build", "test"], []]);
  assert.deepEqual(r.out.at(-1), { ok: true, done: ["old"], failed: [] }, "a colour without a description updates the colour");
});
