// The forge layer: every gate reaches the code host (issues, labels, change requests, checks, merges) through
// one object from openForge(config, {cwd}), never through a forge CLI directly. Backends:
//   github  the gh CLI; the reference backend, with the exact calls cstack made before the layer existed
//   gitlab  glab api, in gates/lib/forge-gitlab.mjs; config forge_host for a self-hosted instance
//   local   plain git with any remote or none, in gates/lib/forge-local.mjs; records under .cstack/forge/
// Records are normalised so a gate reads the same fields on every forge:
//   change  {id, url, state: open|merged|closed, draft, head, base, baseSha, merge: clean|behind|conflict|blocked|unknown,
//            mergeRaw, review: approved|changes|none, reviewRaw, files: [path], mergeSha, mergedAt}
//   check   {name, state: pass|fail|pending|skipped, status, conclusion, id, started_at, url, output}
//   issue   {number, title, state: open|closed, labels: [name], comments: [body], body, createdAt}
// Skills reach the same layer through gates/forge.mjs, whose verbs read richer records:
//   detail  a change plus {title, branch, author, bot, body, autoMerge, headRepo, commits, reviewRequired}
//   thread  {id, resolved, path, line, author, bot, body, url, comments: [{author, bot, body, url, createdAt}]}
//   review  {id, kind: review|comment, state, author, bot, body, commit, url, createdAt}
// Errors: methods that a gate can survive return {ok:false, error}; methods whose failure ends the gate throw a
// UsageError naming the forge command, as the gates did before.
import { UsageError, run } from "./common.mjs";
import { gitlab } from "./forge-gitlab.mjs";
import { local } from "./forge-local.mjs";

export const FORGES = ["github", "gitlab", "local"];

// A check conclusion that counts as passed, and one that counts as failed. Anything else is still running.
const PASSED = new Set(["success", "skipped", "neutral"]);
export const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

// The forge is always GitHub unless config `forge` (or CSTACK_FORGE) names another; there is no detection from
// the remote (Monty, 2026-10-30).
export function forgeKind(config = {}) {
  const k = process.env.CSTACK_FORGE || config.forge || "github";
  if (!FORGES.includes(k)) throw new UsageError(`unknown forge '${k}' (use github, gitlab or local)`);
  return k;
}

export function openForge(config, { cwd } = {}) {
  const kind = forgeKind(config);
  if (kind === "github") return github(config.repo, cwd);
  if (kind === "gitlab") return gitlab(config.repo, cwd, config.forge_host ?? null);
  return local(config, cwd ?? process.cwd());
}

// A re-run adds a newer check run with the same name. Prefer the higher id; without ids, the later start.
// A queued run has no start time yet, so it counts as the newest.
function newer(a, b) {
  if (Number.isInteger(a.id) && Number.isInteger(b.id)) return a.id > b.id;
  return String(a.started_at ?? "~") > String(b.started_at ?? "~");
}

const checkState = (c) => (c.status !== "completed" ? "pending" : PASSED.has(c.conclusion) ? (c.conclusion === "skipped" ? "skipped" : "pass") : "fail");
const mergeState = (s) => ({ DIRTY: "conflict", BEHIND: "behind", BLOCKED: "blocked", UNKNOWN: "unknown" })[s] ?? "clean";
const reviewState = (d) => ({ APPROVED: "approved", CHANGES_REQUESTED: "changes" })[d] ?? "none";
const lower = (s) => String(s ?? "").toLowerCase();
// A GraphQL failure that REST can route around: REST has its own, separate limit.
const RATE_LIMITED = /rate limit/i;

// Review threads with their first comments, as cstack:babysit-pr has always read them.
const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line comments(first:50){nodes{author{login __typename} body url createdAt}}}}}}}";
const REPLY_MUTATION = "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{url}}}";
const RESOLVE_MUTATION = "mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}";
// The detail fields `gh pr view` reads for a skill.
const DETAIL = ["number", "title", "url", "state", "isDraft", "headRefName", "headRefOid", "baseRefName", "baseRefOid", "mergeStateStatus", "reviewDecision", "mergeCommit", "mergedAt", "files", "author", "body", "autoMergeRequest", "headRepository", "headRepositoryOwner", "commits"];

// A GraphQL actor (login, __typename) and a REST user (login, type). Deleted accounts come back null.
const actor = (a) => ({ author: a?.login ?? "ghost", bot: a?.__typename === "Bot" || a?.is_bot === true });
const restUser = (u) => ({ author: u?.login ?? "ghost", bot: u?.type === "Bot" });

function github(repo, cwd) {
  const gh = (args) => run("gh", args, { cwd });
  const must = (args) => {
    const r = gh(args);
    if (r.code !== 0) throw new UsageError(`gh ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  const toChange = (p) => ({
    id: p.number,
    url: p.url,
    state: lower(p.state),
    draft: Boolean(p.isDraft),
    head: p.headRefOid,
    base: p.baseRefName,
    baseSha: p.baseRefOid,
    merge: mergeState(p.mergeStateStatus),
    mergeRaw: p.mergeStateStatus,
    review: reviewState(p.reviewDecision),
    reviewRaw: p.reviewDecision ?? "",
    files: (p.files ?? []).map((f) => f.path),
    mergeSha: p.mergeCommit?.oid ?? null,
    mergedAt: p.mergedAt ?? null,
  });
  const toIssue = (i) => ({
    number: i.number,
    title: i.title,
    state: lower(i.state),
    labels: (i.labels ?? []).map((l) => l.name),
    comments: (i.comments ?? []).map((c) => c.body),
    body: i.body,
    createdAt: i.createdAt,
  });
  // A pull from the REST API, for when GraphQL is rate limited and for listing by head and base.
  // List rows carry no merge state or commit count, so those read unknown and null.
  const fromRest = (p) => ({
    id: p.number,
    url: p.html_url,
    state: p.merged_at ? "merged" : lower(p.state),
    draft: Boolean(p.draft),
    head: p.head.sha,
    base: p.base.ref,
    baseSha: p.base.sha,
    merge: mergeState(String(p.mergeable_state ?? "unknown").toUpperCase()),
    mergeRaw: String(p.mergeable_state ?? "unknown").toUpperCase(),
    review: "none",
    reviewRaw: "",
    files: [],
    mergeSha: p.merged_at ? p.merge_commit_sha : null,
    mergedAt: p.merged_at ?? null,
    title: p.title,
    branch: p.head.ref,
    ...restUser(p.user),
    body: p.body ?? "",
    autoMerge: Boolean(p.auto_merge),
    headRepo: p.head.repo?.full_name ?? null,
    commits: p.commits ?? null,
    reviewRequired: false,
  });
  const toDetail = (p) => ({
    ...toChange(p),
    title: p.title,
    branch: p.headRefName,
    ...actor(p.author),
    body: p.body,
    autoMerge: Boolean(p.autoMergeRequest),
    headRepo: p.headRepository && p.headRepositoryOwner ? `${p.headRepositoryOwner.login}/${p.headRepository.name}` : null,
    commits: p.commits.length,
    reviewRequired: p.reviewDecision === "REVIEW_REQUIRED",
  });
  const result = (r) => ({ ok: r.code === 0, error: r.stderr.trim() });
  const [owner, name] = String(repo).split("/");
  // `gh issue create` prints the new issue's URL; its number ends it.
  const created = (r) => (r.code === 0 ? { ok: true, id: Number(r.stdout.trim().split("/").pop()), url: r.stdout.trim() } : { ok: false, error: r.stderr.trim() });

  return {
    kind: "github",
    name: "GitHub",
    repo,

    // The change's fields a gate asks for; `want` names them so each call reads only what it needs.
    change(id, want = ["number", "state", "isDraft", "headRefOid", "baseRefName", "baseRefOid", "mergeStateStatus", "reviewDecision", "mergeCommit", "files"]) {
      return toChange(JSON.parse(must(["pr", "view", String(id), "--repo", repo, "--json", want.join(",")])));
    },
    // Merge at exactly `sha` with a merge commit. Returns the command's result; callers re-read the change.
    merge(id, sha) {
      const r = gh(["pr", "merge", String(id), "--repo", repo, "--merge", "--match-head-commit", sha]);
      return { ok: r.code === 0, error: r.stderr.trim() };
    },

    // The newest check of each name on one commit, sorted by name.
    checks(sha) {
      const runs = JSON.parse(must(["api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", ".check_runs"]));
      const latest = new Map();
      for (const c of runs) {
        const prev = latest.get(c.name);
        if (!prev || newer(c, prev)) latest.set(c.name, c);
      }
      return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, state: checkState(c), url: c.details_url }));
    },
    // The last `lines` lines of a check's log: the Actions job log, else the check's output summary and text.
    checkTail(check, lines) {
      const job = String(check.url ?? check.details_url).match(/\/actions\/runs\/\d+\/job\/(\d+)/);
      let tail;
      if (job) {
        // Job logs carry terminal color codes; gh refuses them unless allowed, so allow and strip them.
        const r = gh(["api", "--allow-escape-sequences", `repos/${repo}/actions/jobs/${job[1]}/logs`]);
        tail = r.code === 0 ? r.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") : `(job log unavailable: ${r.stderr.trim()})`;
      } else {
        const output = check.output ?? {};
        tail = [output.summary, output.text].filter(Boolean).join("\n") || "(no output)";
      }
      return tail.trimEnd().split("\n").slice(-lines).join("\n");
    },
    // The handle that re-runs a failed check, or null when the forge cannot re-run it.
    rerunHandle(check) {
      return String(check.url ?? check.details_url ?? "").match(/\/actions\/runs\/(\d+)/)?.[1] ?? null;
    },
    rerun(handle) {
      return { ok: gh(["run", "rerun", handle, "--failed", "--repo", repo]).code === 0 };
    },

    issue(id, want) {
      const r = gh(["issue", "view", String(id), "--repo", repo, "--json", want.join(",")]);
      return r.code === 0 ? { ok: true, ...toIssue(JSON.parse(r.stdout)) } : { ok: false, error: r.stderr.trim() };
    },
    // Labels to add and to remove, in one edit.
    relabel(id, { add = [], remove = [] }) {
      const args = ["issue", "edit", String(id), "--repo", repo];
      if (add.length) args.push("--add-label", add.join(","));
      if (remove.length) args.push("--remove-label", remove.join(","));
      const r = gh(args);
      return { ok: r.code === 0, error: r.stderr.trim() };
    },
    comment(id, bodyFile) {
      const r = gh(["issue", "comment", String(id), "--repo", repo, "--body-file", bodyFile]);
      return { ok: r.code === 0, error: r.stderr.trim() };
    },
    // Issues by state (open|closed|all), optionally one label or a search in the body (or the title),
    // newest first as the forge lists them.
    issues({ state = "open", label = null, search = null, within = "body", want, limit = 200 }) {
      const args = ["issue", "list", "--repo", repo, "--state", state];
      if (label) args.push("--label", label);
      if (search) args.push("--search", `${search} in:${within}`);
      args.push("--json", want.join(","), "--limit", String(limit));
      return JSON.parse(must(args)).map(toIssue);
    },
    // Change requests whose head (filter --head) or base (--base) is `branch`, in every state: a merged or
    // closed one still anchors a stacked chain, and a draft counts as open. Rows: {id, state: OPEN|MERGED|CLOSED,
    // branch, base}. Runs in cwd's checkout, without --repo, as the frontier always has.
    changesOn(filter, branch) {
      const label = `gh pr list ${filter} ${branch}`;
      const r = gh(["pr", "list", filter, branch, "--state", "all", "--json", "number,state,headRefName,baseRefName"].filter(Boolean));
      if (r.code !== 0) throw new UsageError(`gh pr list ${filter} ${branch} --state all --json number,state,headRefName,baseRefName failed: ${(r.stderr || r.stdout).trim()}`);
      let value;
      try {
        value = JSON.parse(r.stdout);
      } catch {
        throw new UsageError(`${label} output is not valid JSON`);
      }
      if (!Array.isArray(value)) throw new UsageError(`${label} output is not a JSON array`);
      return value.map((row) => {
        const ok = row && typeof row === "object" && !Array.isArray(row);
        const state = ok && ["OPEN", "MERGED", "CLOSED"].includes(row.state) ? row.state : null;
        if (state === null || !Number.isSafeInteger(row.number) || row.number < 1 || typeof row.headRefName !== "string" || row.headRefName === "" || typeof row.baseRefName !== "string" || row.baseRefName === "") {
          throw new UsageError(`${label} output has an invalid PR row`);
        }
        return { pr: row.number, state, branch: row.headRefName, base: row.baseRefName };
      });
    },
    createIssue({ title, bodyFile, label }) {
      return created(gh(["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile, ...(label ? ["--label", label] : [])]));
    },

    // ---- Verbs for skills (gates/forge.mjs). ----

    // The repo as {path: "owner/name", defaultBranch, url}. Without a configured repo, the cwd's checkout.
    repoInfo() {
      const r = JSON.parse(must(["repo", "view", ...(repo ? [repo] : []), "--json", "nameWithOwner,defaultBranchRef,url"]));
      return { path: r.nameWithOwner, defaultBranch: r.defaultBranchRef.name, url: r.url };
    },
    currentUser() {
      const u = JSON.parse(must(["api", "user"]));
      return { login: u.login, name: u.name, bot: u.type === "Bot" };
    },
    // One change in full. GraphQL first; on its rate limit, the REST pull (no review decision or files).
    changeDetail(id) {
      const r = gh(["pr", "view", String(id), "--repo", repo, "--json", DETAIL.join(",")]);
      if (r.code === 0) return toDetail(JSON.parse(r.stdout));
      if (!RATE_LIMITED.test(r.stderr)) throw new UsageError(`gh pr view ${id} failed: ${r.stderr.trim()}`);
      return fromRest(JSON.parse(must(["api", `repos/${repo}/pulls/${id}`])));
    },
    // Changes by head branch, base branch and state (open|closed|merged|all), through REST so it works
    // when GraphQL is exhausted. Without a head or base, every change in that state.
    findChanges({ head = null, base = null, state = "open" } = {}) {
      const q = [`state=${state === "merged" ? "closed" : state}`, "per_page=100"];
      if (head) q.push(`head=${owner}:${head}`);
      if (base) q.push(`base=${base}`);
      const rows = JSON.parse(must(["api", `repos/${repo}/pulls?${q.join("&")}`])).map(fromRest);
      return state === "merged" ? rows.filter((c) => c.state === "merged") : rows;
    },
    // The newest merged changes' titles, for the repo's title conventions.
    recentMerged(limit = 10) {
      return JSON.parse(must(["pr", "list", "--repo", repo, "--state", "merged", "--limit", String(limit), "--json", "number,title,url,mergedAt"])).map((p) => ({ id: p.number, title: p.title, url: p.url, mergedAt: p.mergedAt }));
    },
    // Open a real change, never a draft. `gh pr create` uses GraphQL; on its rate limit, one REST attempt.
    createChange({ head, base, title, bodyFile }) {
      const r = gh(["pr", "create", "--repo", repo, "--head", head, "--base", base, "--title", title, "--body-file", bodyFile]);
      if (r.code === 0) return { ok: true, ...created(r), via: "graphql" };
      if (!RATE_LIMITED.test(r.stderr)) return { ok: false, error: r.stderr.trim() };
      const rest = gh(["api", `repos/${repo}/pulls`, "-f", `title=${title}`, "-f", `head=${head}`, "-f", `base=${base}`, "-F", `body=@${bodyFile}`]);
      if (rest.code !== 0) return { ok: false, error: `GraphQL rate limited; REST failed too: ${rest.stderr.trim()}` };
      const p = JSON.parse(rest.stdout);
      return { ok: true, id: p.number, url: p.html_url, via: "rest" };
    },
    editChange(id, { bodyFile = null, title = null } = {}) {
      const args = ["pr", "edit", String(id), "--repo", repo];
      if (title) args.push("--title", title);
      if (bodyFile) args.push("--body-file", bodyFile);
      return result(gh(args));
    },
    markReady(id) {
      return result(gh(["pr", "ready", String(id), "--repo", repo]));
    },
    commentChange(id, bodyFile) {
      return result(gh(["pr", "comment", String(id), "--repo", repo, "--body-file", bodyFile]));
    },

    // Review threads on a change, resolved or not, each with its comments in order.
    threads(id) {
      const out = JSON.parse(must(["api", "graphql", "-f", `query=${THREADS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${id}`]));
      return out.data.repository.pullRequest.reviewThreads.nodes.map((t) => {
        const comments = t.comments.nodes.map((c) => ({ ...actor(c.author), body: c.body, url: c.url, createdAt: c.createdAt }));
        const first = comments[0] ?? { author: null, bot: false, body: "", url: null };
        return { id: t.id, resolved: t.isResolved, path: t.path, line: t.line, author: first.author, bot: first.bot, body: first.body, url: first.url, comments };
      });
    },
    // Submitted reviews and top-level comments, oldest first. Inline comments live in threads().
    reviews(id) {
      const reviews = JSON.parse(must(["api", `repos/${repo}/pulls/${id}/reviews?per_page=100`])).map((r) => ({
        id: r.id,
        kind: "review",
        state: r.state === "CHANGES_REQUESTED" ? "changes" : lower(r.state),
        ...restUser(r.user),
        body: r.body,
        commit: r.commit_id,
        url: r.html_url,
        createdAt: r.submitted_at,
      }));
      const comments = JSON.parse(must(["api", `repos/${repo}/issues/${id}/comments?per_page=100`])).map((c) => ({ id: c.id, kind: "comment", state: null, ...restUser(c.user), body: c.body, commit: null, url: c.html_url, createdAt: c.created_at }));
      return [...reviews, ...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    // GitHub thread ids are global, so `id` (the change) is unused here; GitLab needs it.
    replyThread(id, threadId, bodyFile) {
      const r = gh(["api", "graphql", "-f", `query=${REPLY_MUTATION}`, "-f", `thread=${threadId}`, "-F", `body=@${bodyFile}`]);
      return r.code === 0 ? { ok: true, url: JSON.parse(r.stdout).data.addPullRequestReviewThreadReply.comment.url } : { ok: false, error: r.stderr.trim() };
    },
    resolveThread(id, threadId) {
      return result(gh(["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `thread=${threadId}`]));
    },

    // One issue with its comments' authors, for a skill to read and save.
    issueDetail(id) {
      const i = JSON.parse(must(["issue", "view", String(id), "--repo", repo, "--json", "number,title,body,state,labels,comments,author,createdAt,url"]));
      return {
        number: i.number,
        title: i.title,
        state: lower(i.state),
        labels: i.labels.map((l) => l.name),
        url: i.url,
        ...actor(i.author),
        body: i.body,
        createdAt: i.createdAt,
        comments: i.comments.map((c) => ({ ...actor(c.author), body: c.body, url: c.url, createdAt: c.createdAt })),
      };
    },
    // Create or update each label. Returns {ok, done: [name], failed: [{name, error}]}.
    ensureLabels(names, color = null, description = null) {
      const done = [];
      const failed = [];
      for (const n of names) {
        // --force updates an existing label, so pass it only with a colour: without one gh picks a random colour
        // and --force would repaint the label on every call. Then an existing label is already ensured.
        const args = ["label", "create", n, "--repo", repo, ...(color ? ["--force", "--color", color] : [])];
        if (description) args.push("--description", description);
        const r = gh(args);
        if (r.code === 0 || (!color && /already exists/i.test(r.stderr))) done.push(n);
        else failed.push({ name: n, error: r.stderr.trim() });
      }
      return { ok: failed.length === 0, done, failed };
    },
    // Required check names on a branch, from rulesets and classic protection. 404 means no protection, and the
    // plan's 403 ("Upgrade to GitHub Pro or make this repository public") means a free private repo has none.
    // Any other 403 (a rate limit, SSO, a token without access) is an error: reading it as "none" would let the
    // merge gate stop waiting for CI.
    requiredChecks(branch) {
      const sources = [
        [`repos/${repo}/rules/branches/${branch}`, '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'],
        [`repos/${repo}/branches/${branch}/protection/required_status_checks`, ".contexts[]?, .checks[]?.context"],
      ];
      const names = new Set();
      for (const [p, jq] of sources) {
        const r = gh(["api", p, "--jq", jq]);
        if (r.code === 0) for (const n of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) names.add(n);
        else if (!/HTTP 404/.test(r.stderr) && !/Upgrade to GitHub Pro|make this repository public/i.test(r.stderr)) throw new UsageError(`gh api ${p} failed: ${r.stderr.trim()}`);
      }
      return [...names].sort();
    },
  };
}
