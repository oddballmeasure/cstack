// The forge layer: every gate reaches the code host (issues, labels, change requests, checks, merges) through
// one object from openForge(config, {cwd}), never through a forge CLI directly (ADR-013). Backends:
//   github  the gh CLI; the reference backend, with the exact calls cstack made before the layer existed
//   gitlab  glab api (phase F3)
//   local   plain git with any remote or none (phase F4)
// Records are normalised so a gate reads the same fields on every forge:
//   change  {id, url, state: open|merged|closed, draft, head, base, baseSha, merge: clean|behind|conflict|blocked|unknown,
//            mergeRaw, review: approved|changes|none, reviewRaw, files: [path], mergeSha, mergedAt}
//   check   {name, state: pass|fail|pending|skipped, status, conclusion, id, started_at, url, output}
//   issue   {number, title, state: open|closed, labels: [name], comments: [body], body, createdAt}
// Errors: methods that a gate can survive return {ok:false, error}; methods whose failure ends the gate throw a
// UsageError naming the forge command, as the gates did before.
import { UsageError, run } from "./common.mjs";

export const FORGES = ["github", "gitlab", "local"];

// A check conclusion that counts as passed, and one that counts as failed. Anything else is still running.
const PASSED = new Set(["success", "skipped", "neutral"]);
export const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

export function forgeKind(config = {}) {
  const k = process.env.CSTACK_FORGE || config.forge || "auto";
  if (k === "auto") return "github";
  if (!FORGES.includes(k)) throw new UsageError(`unknown forge '${k}' (use github, gitlab, local or auto)`);
  return k;
}

export function openForge(config, { cwd } = {}) {
  const kind = forgeKind(config);
  if (kind === "github") return github(config.repo, cwd);
  throw new UsageError(`forge '${kind}' is not implemented yet`);
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
    // Issues by state (open|all), optionally one label or a body search, newest first as the forge lists them.
    issues({ state = "open", label = null, search = null, want, limit = 200 }) {
      const args = ["issue", "list", "--repo", repo, "--state", state];
      if (label) args.push("--label", label);
      if (search) args.push("--search", `${search} in:body`);
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
      return created(gh(["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile, "--label", label]));
    },
  };
}
