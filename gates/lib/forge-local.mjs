// The local backend of the forge layer (gates/lib/forge.mjs): plain git with any remote, or none (forge phase F4).
// There is no server, so the forge's records live in the repo's main checkout, shared by all its worktrees:
//   .cstack/forge/issues/<n>.json    {number, title, body, state, labels, comments, author, createdAt}
//   .cstack/forge/changes/<n>.json   {id, title, body, branch, base, state, author, createdAt, mergeSha, mergedAt,
//                                     threads: [{id, resolved, path, line, comments}], comments: [...]}
//   .cstack/forge/checks/<sha>.json  {name, sha, status, conclusion, started_at, finished_at, log}
//   .cstack/forge/next               the last id handed out (issues and changes share one sequence)
// CI is config `ci_command`, run once per SHA in a clean detached worktree. The result is recorded, so every gate
// that asks later reads the same verdict, and a model never reports it. The merge gate's merge is
// `git merge --no-ff` in its own worktree at exactly the judged head, then a push of the base with
// --force-with-lease to the base it judged; without a remote, an atomic update of the local base branch.
// This is weaker than server-side CI: "green" means ci_command passed on this machine (ADR-014).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UsageError, run } from "./common.mjs";

const CHECK = "ci";

export function local(config, cwd) {
  const g = (args, opts = {}) => run("git", ["-C", cwd, ...args], opts);
  const out = (args) => {
    const r = g(args);
    if (r.code !== 0) throw new UsageError(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  // The main checkout holds the store, whichever worktree the gate runs in.
  const common = out(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const top = path.resolve(path.dirname(common));
  const store = path.join(top, ".cstack", "forge");
  const file = (kind, id) => path.join(store, kind, `${id}.json`);
  const read = (kind, id) => {
    const f = file(kind, id);
    if (!existsSync(f)) throw new UsageError(`local ${kind.replace(/s$/, "")} ${id} not found`);
    return JSON.parse(readFileSync(f, "utf8"));
  };
  const write = (kind, id, rec) => {
    mkdirSync(path.join(store, kind), { recursive: true });
    writeFileSync(file(kind, id), `${JSON.stringify(rec, null, 2)}\n`);
    return rec;
  };
  const all = (kind) => (existsSync(path.join(store, kind)) ? readdirSync(path.join(store, kind)).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(store, kind, f), "utf8"))) : []);
  // One id sequence for issues and changes, under a mkdir lock, so two sessions never take the same number.
  const nextId = () => {
    mkdirSync(store, { recursive: true });
    const lock = path.join(store, ".lock");
    for (let i = 0; ; i++) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        if (i > 200) throw new UsageError(`local forge: ${lock} is held; remove it if no cstack session is running`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      const f = path.join(store, "next");
      const n = (existsSync(f) ? Number(readFileSync(f, "utf8")) : 0) + 1;
      writeFileSync(f, `${n}\n`);
      return n;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  };
  const now = () => new Date().toISOString();
  const me = () => g(["config", "user.name"]).stdout.trim() || "local";
  const hasRemote = () => g(["remote"]).stdout.split("\n").includes("origin");
  // A branch's tip: origin's copy when there is a remote (workers push there), else the local branch.
  const tip = (branch) => {
    if (hasRemote()) {
      g(["fetch", "--quiet", "origin", branch]);
      const r = g(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
      if (r.code === 0) return r.stdout.trim();
    }
    const r = g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const textOf = (bodyFile) => readFileSync(bodyFile, "utf8");
  const ok = { ok: true, error: "" };

  const toChange = (c, withFiles = false) => {
    const head = c.state === "merged" ? c.mergedHead : tip(c.branch);
    const baseSha = tip(c.base);
    let merge = "unknown";
    let behind = 0;
    if (c.state === "open" && head && baseSha) {
      // git merge-tree exits 1 on a conflict and writes nothing.
      merge = g(["merge-tree", "--write-tree", baseSha, head]).code === 0 ? "clean" : "conflict";
      behind = Number(g(["rev-list", "--count", `${head}..${baseSha}`]).stdout.trim());
    }
    const files = withFiles && head && baseSha ? g(["diff", "--name-only", `${baseSha}...${head}`]).stdout.split("\n").filter(Boolean) : [];
    return { id: c.id, url: `local:change/${c.id}`, state: c.state, draft: false, head, base: c.base, baseSha: c.state === "merged" ? c.mergedBase : baseSha, merge, mergeRaw: merge, behind, review: "none", reviewRaw: "", files, mergeSha: c.mergeSha ?? null, mergedAt: c.mergedAt ?? null };
  };
  const toDetail = (c) => ({ ...toChange(c, true), title: c.title, branch: c.branch, author: c.author, bot: false, body: c.body, autoMerge: false, headRepo: config.repo ?? null, commits: null, reviewRequired: false });
  const toIssue = (i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels, comments: i.comments.map((c) => c.body), body: i.body, createdAt: i.createdAt });

  // Run ci_command at `sha` in a clean detached worktree and record the verdict. A recorded verdict is final.
  const runCi = (sha) => {
    const cmd = config.ci_command;
    if (!Array.isArray(cmd) || !cmd.length) return null;
    const wt = mkdtempSync(path.join(tmpdir(), "cstack-local-ci-"));
    const started = now();
    let rec;
    const add = g(["worktree", "add", "--detach", "--quiet", wt, sha]);
    if (add.code !== 0) rec = { conclusion: "failure", log: `cannot check out ${sha}: ${add.stderr.trim()}` };
    else {
      const r = run(cmd[0], cmd.slice(1), { cwd: wt });
      rec = { conclusion: r.code === 0 ? "success" : "failure", log: `${r.stdout}${r.stderr}` };
      g(["worktree", "remove", "--force", wt]);
    }
    rmSync(wt, { recursive: true, force: true });
    return write("checks", sha, { name: CHECK, sha, status: "completed", started_at: started, finished_at: now(), ...rec });
  };

  return {
    kind: "local",
    name: "local git",
    repo: config.repo ?? path.basename(top),

    change(id, want = ["files"]) {
      return toChange(read("changes", id), want.includes("files"));
    },
    // The merge gate's merge: a merge commit of exactly `sha` onto the base the gate judged, in a worktree of its own.
    merge(id, sha) {
      const c = read("changes", id);
      if (c.state !== "open") return { ok: false, error: `change ${id} is ${c.state}` };
      const head = tip(c.branch);
      if (head !== sha) return { ok: false, error: `head of ${c.branch} is ${head?.slice(0, 12)}, not ${sha.slice(0, 12)}` };
      const base = tip(c.base);
      const wt = mkdtempSync(path.join(tmpdir(), "cstack-local-merge-"));
      try {
        const w = (args) => run("git", ["-C", wt, ...args]);
        if (g(["worktree", "add", "--detach", "--quiet", wt, base]).code !== 0) return { ok: false, error: `cannot check out ${c.base}` };
        const m = w(["-c", "user.name=cstack", "-c", "user.email=cstack@localhost", "merge", "--no-ff", "--no-edit", "-m", `Merge change !${id}: ${c.title}`, sha]);
        if (m.code !== 0) return { ok: false, error: `merge failed: ${(m.stderr || m.stdout).trim()}` };
        const merged = w(["rev-parse", "HEAD"]).stdout.trim();
        const push = hasRemote() ? w(["push", "--quiet", `--force-with-lease=${c.base}:${base}`, "origin", `HEAD:refs/heads/${c.base}`]) : g(["update-ref", `refs/heads/${c.base}`, merged, base]);
        if (push.code !== 0) return { ok: false, error: `could not move ${c.base} to the merge (did the base move?): ${push.stderr.trim()}` };
        write("changes", id, { ...c, state: "merged", mergeSha: merged, mergedAt: now(), mergedHead: sha, mergedBase: base });
        return ok;
      } finally {
        g(["worktree", "remove", "--force", wt]);
        rmSync(wt, { recursive: true, force: true });
      }
    },

    // The one check: config ci_command at this SHA, run on first ask and recorded.
    checks(sha) {
      const f = file("checks", sha);
      const rec = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : runCi(sha);
      if (!rec) return [];
      return [{ name: rec.name, id: sha, status: rec.status, conclusion: rec.conclusion, started_at: rec.started_at, url: f, details_url: f, output: null, state: rec.conclusion === "success" ? "pass" : "fail" }];
    },
    checkTail(check, lines) {
      const f = file("checks", check.id);
      const log = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).log : "(no log)";
      return (log.trimEnd() || "(no output)").split("\n").slice(-lines).join("\n");
    },
    rerunHandle(check) {
      return check.id ?? null;
    },
    // Forget the recorded verdict and run ci_command again.
    rerun(handle) {
      rmSync(file("checks", handle), { force: true });
      return { ok: runCi(handle) !== null };
    },

    issue(id, want) {
      try {
        const i = read("issues", id);
        return { ok: true, ...toIssue(i) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    relabel(id, { add = [], remove = [] }) {
      try {
        const i = read("issues", id);
        write("issues", id, { ...i, labels: [...new Set([...i.labels.filter((l) => !remove.includes(l)), ...add])] });
        return ok;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    comment(id, bodyFile) {
      try {
        const i = read("issues", id);
        write("issues", id, { ...i, comments: [...i.comments, { author: me(), body: textOf(bodyFile), createdAt: now() }] });
        return ok;
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    issues({ state = "open", label = null, search = null, within = "body", limit = 200 }) {
      return all("issues")
        .filter((i) => state === "all" || i.state === state)
        .filter((i) => !label || i.labels.includes(label))
        .filter((i) => !search || String(within === "title" ? i.title : i.body).includes(search))
        .sort((a, b) => b.number - a.number)
        .slice(0, limit)
        .map(toIssue);
    },
    createIssue({ title, bodyFile, label }) {
      const n = nextId();
      write("issues", n, { number: n, title, body: textOf(bodyFile), state: "open", labels: label ? [label] : [], comments: [], author: me(), createdAt: now() });
      return { ok: true, id: n, url: `local:issue/${n}` };
    },
    changesOn(filter, branch) {
      return all("changes")
        .filter((c) => (filter === "--head" ? c.branch : c.base) === branch)
        .map((c) => ({ pr: c.id, state: c.state.toUpperCase(), branch: c.branch, base: c.base }));
    },

    // ---- Verbs for skills (gates/forge.mjs). ----

    repoInfo() {
      const url = hasRemote() ? g(["remote", "get-url", "origin"]).stdout.trim() : top;
      return { path: config.repo ?? path.basename(top), defaultBranch: config.base_branch ?? (g(["symbolic-ref", "--short", "HEAD"]).stdout.trim() || "main"), url };
    },
    currentUser() {
      return { login: me(), name: me(), bot: false };
    },
    changeDetail(id) {
      return toDetail(read("changes", id));
    },
    findChanges({ head = null, base = null, state = "open" } = {}) {
      return all("changes")
        .filter((c) => (state === "all" || c.state === state) && (!head || c.branch === head) && (!base || c.base === base))
        .sort((a, b) => b.id - a.id)
        .map(toDetail);
    },
    recentMerged(limit = 10) {
      return all("changes")
        .filter((c) => c.state === "merged")
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)))
        .slice(0, limit)
        .map((c) => ({ id: c.id, title: c.title, url: `local:change/${c.id}`, mergedAt: c.mergedAt }));
    },
    createChange({ head, base, title, bodyFile }) {
      if (!tip(head)) return { ok: false, error: `branch ${head} not found${hasRemote() ? " on origin or locally" : ""}; push it first` };
      const open = all("changes").find((c) => c.state === "open" && c.branch === head && c.base === base);
      if (open) return { ok: false, error: `change !${open.id} is already open for ${head}` };
      const n = nextId();
      write("changes", n, { id: n, title, body: textOf(bodyFile), branch: head, base, state: "open", author: me(), createdAt: now(), mergeSha: null, mergedAt: null, threads: [], comments: [] });
      return { ok: true, id: n, url: `local:change/${n}`, via: "local" };
    },
    editChange(id, { bodyFile = null, title = null } = {}) {
      const c = read("changes", id);
      write("changes", id, { ...c, ...(title ? { title } : {}), ...(bodyFile ? { body: textOf(bodyFile) } : {}) });
      return ok;
    },
    markReady() {
      return ok;
    },
    commentChange(id, bodyFile) {
      const c = read("changes", id);
      write("changes", id, { ...c, comments: [...c.comments, { id: `c${c.comments.length + 1}`, author: me(), body: textOf(bodyFile), createdAt: now() }] });
      return ok;
    },
    threads(id) {
      return read("changes", id).threads.map((t) => ({ id: t.id, resolved: t.resolved, path: t.path ?? null, line: t.line ?? null, author: t.comments[0]?.author ?? null, bot: false, body: t.comments[0]?.body ?? "", url: null, comments: t.comments.map((c) => ({ author: c.author, bot: false, body: c.body, url: null, createdAt: c.createdAt })) }));
    },
    reviews(id) {
      return read("changes", id).comments.map((c) => ({ id: c.id, kind: "comment", state: null, author: c.author, bot: false, body: c.body, commit: null, url: null, createdAt: c.createdAt }));
    },
    replyThread(id, threadId, bodyFile) {
      const c = read("changes", id);
      const t = c.threads.find((x) => x.id === threadId);
      if (!t) return { ok: false, error: `thread ${threadId} not found on change ${id}` };
      t.comments.push({ author: me(), body: textOf(bodyFile), createdAt: now() });
      write("changes", id, c);
      return { ok: true, url: null };
    },
    resolveThread(id, threadId) {
      const c = read("changes", id);
      const t = c.threads.find((x) => x.id === threadId);
      if (!t) return { ok: false, error: `thread ${threadId} not found on change ${id}` };
      t.resolved = true;
      write("changes", id, c);
      return ok;
    },
    issueDetail(id) {
      const i = read("issues", id);
      return { number: i.number, title: i.title, state: i.state, labels: i.labels, url: `local:issue/${id}`, author: i.author, bot: false, body: i.body, createdAt: i.createdAt, comments: i.comments.map((c) => ({ author: c.author, bot: false, body: c.body, url: null, createdAt: c.createdAt })) };
    },
    // Labels are free-form strings on local issues: nothing to create.
    ensureLabels(names) {
      return { ok: true, done: [...names], failed: [] };
    },
    requiredChecks() {
      return Array.isArray(config.ci_command) && config.ci_command.length ? [CHECK] : [];
    },
  };
}
