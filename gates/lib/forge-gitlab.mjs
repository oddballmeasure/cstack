// The gitlab backend of the forge layer (gates/lib/forge.mjs): GitLab's REST API v4 through `glab api`, so auth stays
// in glab's own config. Measured against gitlab.com in ADR-013. The records are the forge layer's normalised ones.
// GitLab differences the mapping absorbs:
//   - a change is a merge request, addressed by its project-scoped iid
//   - "behind its base" is not a merge state (a merge commit merges it), so it never blocks; diverged commits are
//     counted separately (`behind`)
//   - checks are the jobs of the newest pipeline for a SHA, mapped to GitHub's status and conclusion words, which
//     the gates already read; an allowed failure counts as neutral
//   - the exact-SHA merge is `PUT …/merge` with `sha`, which answers HTTP 409 when the head moved
import { readFileSync } from "node:fs";
import { UsageError, run } from "./common.mjs";

// detailed_merge_status → the forge layer's merge state. Anything not listed blocks: it names a rule that stops a merge.
const MERGE = {
  mergeable: "clean",
  conflict: "conflict",
  need_rebase: "behind",
  checking: "unknown",
  unchecked: "unknown",
  preparing: "unknown",
  approvals_syncing: "unknown",
  not_open: "unknown",
};
const STATE = { opened: "open", merged: "merged", closed: "closed", locked: "closed" };
// A GitLab job status → GitHub's check status and conclusion.
function jobCheck(j) {
  if (j.status === "success") return { status: "completed", conclusion: "success" };
  if (j.status === "failed") return { status: "completed", conclusion: j.allow_failure ? "neutral" : "failure" };
  if (j.status === "canceled") return { status: "completed", conclusion: "cancelled" };
  if (j.status === "skipped" || j.status === "manual") return { status: "completed", conclusion: "skipped" };
  return { status: "in_progress", conclusion: null };
}
const stateOf = (c) => (c.status !== "completed" ? "pending" : c.conclusion === "skipped" ? "skipped" : ["success", "neutral"].includes(c.conclusion) ? "pass" : "fail");
// Job traces carry ANSI colours and GitLab's collapsible-section markers.
const cleanTrace = (t) =>
  t
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/section_(?:start|end):\d+:[^\r\n]*\r?/g, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .join("\n");

export function gitlab(repo, cwd, host = null) {
  const project = `projects/${encodeURIComponent(repo)}`;
  const glab = (method, path, fields = {}, extra = []) => {
    const args = ["api", ...(host ? ["--hostname", host] : []), "-X", method, path, ...extra];
    for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
    return run("glab", args, { cwd });
  };
  const must = (method, path, fields, extra) => {
    const r = glab(method, path, fields, extra);
    if (r.code !== 0) throw new UsageError(`glab api ${method} ${path} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };
  const json = (method, path, fields, extra) => JSON.parse(must(method, path, fields, extra));
  const result = (r) => ({ ok: r.code === 0, error: r.stderr.trim() });
  const toIssue = (i, notes = []) => ({
    number: i.iid,
    title: i.title,
    state: i.state === "opened" ? "open" : "closed",
    labels: i.labels ?? [],
    comments: notes,
    body: i.description ?? "",
    createdAt: i.created_at,
  });

  const user = (u) => ({ author: u?.username ?? "ghost", bot: u?.bot === true });
  const toChange = (m, files = []) => ({
    id: m.iid,
    url: m.web_url,
    state: STATE[m.state] ?? m.state,
    draft: Boolean(m.draft),
    head: m.sha,
    base: m.target_branch,
    baseSha: m.diff_refs?.base_sha ?? null,
    merge: MERGE[m.detailed_merge_status] ?? "blocked",
    mergeRaw: m.detailed_merge_status,
    behind: m.diverged_commits_count ?? 0,
    review: m.detailed_merge_status === "requested_changes" ? "changes" : "none",
    reviewRaw: m.detailed_merge_status === "requested_changes" ? "REQUESTED_CHANGES" : "",
    files,
    mergeSha: m.merge_commit_sha ?? null,
    mergedAt: m.merged_at ?? null,
  });
  // A list row or a full MR, with the fields skills read beyond the gates' change record.
  const toDetail = (m, files = [], extra = {}) => ({
    ...toChange(m, files),
    title: m.title,
    branch: m.source_branch,
    ...user(m.author),
    body: m.description ?? "",
    autoMerge: Boolean(m.merge_when_pipeline_succeeds || m.auto_merge_enabled),
    headRepo: m.source_project_id === m.target_project_id ? repo : null,
    commits: null,
    reviewRequired: false,
    ...extra,
  });
  const note = (n, url) => ({ ...user(n.author), body: n.body, url: url ? `${url}#note_${n.id}` : null, createdAt: n.created_at });

  return {
    kind: "gitlab",
    name: "GitLab",
    repo,

    change(id, want = ["files"]) {
      const m = json("GET", `${project}/merge_requests/${id}?include_diverged_commits_count=true`);
      const files = want.includes("files") ? json("GET", `${project}/merge_requests/${id}/changes`).changes.map((c) => c.new_path) : [];
      return toChange(m, files);
    },
    // A merge commit at exactly `sha`. GitLab refuses a moved head with HTTP 409.
    merge(id, sha) {
      return result(glab("PUT", `${project}/merge_requests/${id}/merge`, { sha }));
    },

    // The jobs of the newest pipeline for `sha`, the newest run of each name, sorted by name.
    checks(sha) {
      const pipelines = json("GET", `${project}/pipelines?sha=${sha}&per_page=20`);
      const newest = pipelines.reduce((a, p) => (!a || p.id > a.id ? p : a), null);
      if (!newest) return [];
      const jobs = json("GET", `${project}/pipelines/${newest.id}/jobs?per_page=100`);
      const latest = new Map();
      for (const j of jobs) {
        const prev = latest.get(j.name);
        if (!prev || j.id > prev.id) latest.set(j.name, j);
      }
      return [...latest.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((j) => {
          const c = { name: j.name, id: j.id, started_at: j.started_at ?? null, url: j.web_url, details_url: j.web_url, output: null, ...jobCheck(j) };
          return { ...c, state: stateOf(c) };
        });
    },
    checkTail(check, lines) {
      const r = glab("GET", `${project}/jobs/${check.id}/trace`);
      const tail = r.code === 0 ? cleanTrace(r.stdout) : `(job log unavailable: ${r.stderr.trim()})`;
      return tail.trimEnd().split("\n").slice(-lines).join("\n");
    },
    rerunHandle(check) {
      return Number.isInteger(check.id) ? String(check.id) : null;
    },
    rerun(handle) {
      return { ok: glab("POST", `${project}/jobs/${handle}/retry`).code === 0 };
    },

    issue(id, want) {
      const r = glab("GET", `${project}/issues/${id}`);
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
      let notes = [];
      if (want.includes("comments")) {
        const n = glab("GET", `${project}/issues/${id}/notes?sort=asc&per_page=100`);
        if (n.code !== 0) return { ok: false, error: n.stderr.trim() };
        notes = JSON.parse(n.stdout).filter((x) => !x.system).map((x) => x.body);
      }
      return { ok: true, ...toIssue(JSON.parse(r.stdout), notes) };
    },
    relabel(id, { add = [], remove = [] }) {
      const fields = {};
      if (add.length) fields.add_labels = add.join(",");
      if (remove.length) fields.remove_labels = remove.join(",");
      return result(glab("PUT", `${project}/issues/${id}`, fields));
    },
    comment(id, bodyFile) {
      return result(glab("POST", `${project}/issues/${id}/notes`, { body: readFileSync(bodyFile, "utf8") }));
    },
    issues({ state = "open", label = null, search = null, within = "body", limit = 200 }) {
      const q = [`state=${state === "open" ? "opened" : "all"}`, "per_page=100", "order_by=created_at", "sort=desc"];
      if (label) q.push(`labels=${encodeURIComponent(label)}`);
      if (search) q.push(`search=${encodeURIComponent(search)}`, `in=${within === "title" ? "title" : "description"}`);
      return json("GET", `${project}/issues?${q.join("&")}`, {}, ["--paginate"]).slice(0, limit).map((i) => toIssue(i));
    },
    createIssue({ title, bodyFile, label }) {
      const r = glab("POST", `${project}/issues`, { title, description: readFileSync(bodyFile, "utf8"), labels: label });
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
      const i = JSON.parse(r.stdout);
      return { ok: true, id: i.iid, url: i.web_url };
    },
    // Merge requests whose source (--head) or target (--base) is `branch`, in every state.
    changesOn(filter, branch) {
      const key = filter === "--head" ? "source_branch" : "target_branch";
      const rows = json("GET", `${project}/merge_requests?${key}=${encodeURIComponent(branch)}&state=all&per_page=100`);
      return rows.map((m) => ({ pr: m.iid, state: (STATE[m.state] ?? "closed").toUpperCase(), branch: m.source_branch, base: m.target_branch }));
    },

    // ---- Verbs for skills (gates/forge.mjs). ----

    repoInfo() {
      const p = json("GET", project);
      return { path: p.path_with_namespace, defaultBranch: p.default_branch, url: p.web_url };
    },
    currentUser() {
      const u = json("GET", "user");
      return { login: u.username, name: u.name, bot: u.bot === true };
    },
    // One MR in full: its files, its commit count, and whether approvals are still required.
    changeDetail(id) {
      const m = json("GET", `${project}/merge_requests/${id}?include_diverged_commits_count=true`);
      const files = json("GET", `${project}/merge_requests/${id}/changes`).changes.map((c) => c.new_path);
      const commits = json("GET", `${project}/merge_requests/${id}/commits?per_page=100`).length;
      const a = json("GET", `${project}/merge_requests/${id}/approvals`);
      return toDetail(m, files, { commits, reviewRequired: (a.approvals_left ?? 0) > 0, review: a.approved && a.approvals_required > 0 ? "approved" : toChange(m).review });
    },
    // MRs by source branch, target branch and state (open|closed|merged|all).
    findChanges({ head = null, base = null, state = "open" } = {}) {
      const q = [`state=${state === "open" ? "opened" : state}`, "per_page=100"];
      if (head) q.push(`source_branch=${encodeURIComponent(head)}`);
      if (base) q.push(`target_branch=${encodeURIComponent(base)}`);
      return json("GET", `${project}/merge_requests?${q.join("&")}`).map((m) => toDetail(m));
    },
    recentMerged(limit = 10) {
      return json("GET", `${project}/merge_requests?state=merged&order_by=merged_at&sort=desc&per_page=${limit}`).map((m) => ({ id: m.iid, title: m.title, url: m.web_url, mergedAt: m.merged_at }));
    },
    // Open a real MR, never a draft. GitLab has one REST API, so there is no fallback to report.
    createChange({ head, base, title, bodyFile }) {
      const r = glab("POST", `${project}/merge_requests`, { source_branch: head, target_branch: base, title, description: readFileSync(bodyFile, "utf8") });
      if (r.code !== 0) return { ok: false, error: r.stderr.trim() };
      const m = JSON.parse(r.stdout);
      return { ok: true, id: m.iid, url: m.web_url, via: "rest" };
    },
    editChange(id, { bodyFile = null, title = null } = {}) {
      const fields = {};
      if (title) fields.title = title;
      if (bodyFile) fields.description = readFileSync(bodyFile, "utf8");
      return result(glab("PUT", `${project}/merge_requests/${id}`, fields));
    },
    // GitLab marks a draft by a title prefix; ready means the prefix is gone.
    markReady(id) {
      const m = json("GET", `${project}/merge_requests/${id}`);
      const title = m.title.replace(/^\s*(?:draft:|\[draft\]|\(draft\))\s*/i, "");
      return title === m.title ? { ok: true, error: "" } : result(glab("PUT", `${project}/merge_requests/${id}`, { title }));
    },
    commentChange(id, bodyFile) {
      return result(glab("POST", `${project}/merge_requests/${id}/notes`, { body: readFileSync(bodyFile, "utf8") }));
    },
    // Resolvable discussions only: those are GitLab's review threads. Discussion ids belong to one MR.
    threads(id) {
      const url = json("GET", `${project}/merge_requests/${id}`).web_url;
      return json("GET", `${project}/merge_requests/${id}/discussions?per_page=100`)
        .filter((d) => d.notes?.[0]?.resolvable)
        .map((d) => {
          const comments = d.notes.filter((n) => !n.system).map((n) => note(n, url));
          const first = comments[0] ?? { author: null, bot: false, body: "", url: null };
          const pos = d.notes[0].position ?? {};
          return { id: d.id, resolved: d.notes.every((n) => !n.resolvable || n.resolved), path: pos.new_path ?? null, line: pos.new_line ?? null, author: first.author, bot: first.bot, body: first.body, url: first.url, comments };
        });
    },
    // Approvals and top-level comments, oldest first. GitLab has no review objects: an approval is the review.
    reviews(id) {
      const url = json("GET", `${project}/merge_requests/${id}`).web_url;
      const approvals = (json("GET", `${project}/merge_requests/${id}/approvals`).approved_by ?? []).map((a, i) => ({ id: `approval-${i}`, kind: "review", state: "approved", ...user(a.user), body: "", commit: null, url, createdAt: null }));
      const comments = json("GET", `${project}/merge_requests/${id}/discussions?per_page=100`)
        .filter((d) => !d.notes?.[0]?.resolvable)
        .flatMap((d) => d.notes.filter((n) => !n.system))
        .map((n) => ({ id: n.id, kind: "comment", state: null, ...note(n, url), commit: null }));
      return [...approvals, ...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    replyThread(id, threadId, bodyFile) {
      const r = glab("POST", `${project}/merge_requests/${id}/discussions/${threadId}/notes`, { body: readFileSync(bodyFile, "utf8") });
      return r.code === 0 ? { ok: true, url: null } : { ok: false, error: r.stderr.trim() };
    },
    resolveThread(id, threadId) {
      return result(glab("PUT", `${project}/merge_requests/${id}/discussions/${threadId}`, { resolved: "true" }));
    },
    issueDetail(id) {
      const i = json("GET", `${project}/issues/${id}`);
      const notes = json("GET", `${project}/issues/${id}/notes?sort=asc&per_page=100`).filter((n) => !n.system);
      return { number: i.iid, title: i.title, state: i.state === "opened" ? "open" : "closed", labels: i.labels ?? [], url: i.web_url, ...user(i.author), body: i.description ?? "", createdAt: i.created_at, comments: notes.map((n) => note(n, i.web_url)) };
    },
    // Create each label, or update an existing one when a colour is given. GitLab requires a colour on create.
    ensureLabels(names, color = null, description = null) {
      const done = [];
      const failed = [];
      for (const n of names) {
        const fields = { name: n, color: `#${(color ?? "5319e7").replace(/^#/, "")}`, ...(description ? { description } : {}) };
        const r = glab("POST", `${project}/labels`, fields);
        let ok = r.code === 0;
        if (!ok && /already exists/i.test(r.stderr + r.stdout)) ok = !color || glab("PUT", `${project}/labels/${encodeURIComponent(n)}`, { new_name: n, color: fields.color, ...(description ? { description } : {}) }).code === 0;
        if (ok) done.push(n);
        else failed.push({ name: n, error: r.stderr.trim() });
      }
      return { ok: failed.length === 0, done, failed };
    },
    // GitLab has no server-side list of required jobs on the free tier (ADR-013): every job of the branch's newest
    // pipeline that may not fail is required.
    requiredChecks(branch) {
      const p = json("GET", `${project}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`)[0];
      if (!p) return [];
      return [...new Set(json("GET", `${project}/pipelines/${p.id}/jobs?per_page=100`).filter((j) => !j.allow_failure).map((j) => j.name))].sort();
    },
  };
}
