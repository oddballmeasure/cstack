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

  return {
    kind: "gitlab",
    name: "GitLab",
    repo,

    change(id, want = ["files"]) {
      const m = json("GET", `${project}/merge_requests/${id}?include_diverged_commits_count=true`);
      const files = want.includes("files") ? json("GET", `${project}/merge_requests/${id}/changes`).changes.map((c) => c.new_path) : [];
      return {
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
      };
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
    issues({ state = "open", label = null, search = null, limit = 200 }) {
      const q = [`state=${state === "open" ? "opened" : "all"}`, "per_page=100", "order_by=created_at", "sort=desc"];
      if (label) q.push(`labels=${encodeURIComponent(label)}`);
      if (search) q.push(`search=${encodeURIComponent(search)}`, "in=description");
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
  };
}
