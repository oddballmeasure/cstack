#!/usr/bin/env node
// Adapted from tstack skills/babysit-pr/scripts/pr-wait @ 92e38e2 (MIT, Theo Browne).
//
// pr-wait: watch one GitHub pull request and print one line per real event.
//
//   node gates/pr-wait.mjs <pr|url> [--repo owner/name] [--until ready|green|any-change] [--store <run store>]
//   While it runs it registers <store>/watchers/<pid> (store from --store, else CSTACK_RUN) for the Stop hook.
//                          [--interval 20] [--state-dir <dir>] [--timeout <s>]
//
// <pr> is a PR number or PR URL. Without --repo, the repo comes from the URL or from the
// current checkout. Stdout carries only events, one line each, so a monitor (the Monitor tool)
// wakes the agent once per real event. Progress and errors that do not end the run go to stderr.
//
// --until
//   green       required checks passed on the current head (every CI check when the base
//               branch requires none)
//   ready       green, a gating review bot (GATING_BOTS) reviewed the current head, and no
//               review thread is unresolved (default)
//   any-change  stop after the first poll that prints an event
//
// Required checks are the union of GitHub rulesets, classic branch protection (403 and 404
// count as "none") and `required_checks` in .cstack/config.json when the cwd sits inside a
// configured checkout of the same repo.
//
// Exit codes
//   0  the --until condition is met, or the PR merged
//   1  the condition cannot be met without action: a required check failed, the branch
//      conflicts with its base, the PR closed, `ready` is blocked by unresolved threads or a
//      BEHIND branch, a non-transient gh error, or GitHub stayed unreachable for 10 polls
//   2  bad arguments, unknown PR, or another pr-wait already watches this PR
//   3  --timeout passed before any of the above (last line `#<pr> timeout: <n>s`). Run it again: the state
//      file keeps what was already reported. For harnesses without a Monitor tool (Codex, ADR-010).
//
// Events
//   - a required check failed (name and link)
//   - all checks finished on the head (one summary line)
//   - a new comment, review, thread, or thread reply from someone other than the PR author or
//     the gh user
//   - a review bot finished on the head, or a gating bot summary changed after that
//   - the base branch moved and the new commits touch files in this PR
//   - merge state became BEHIND or DIRTY
//   - the PR merged or closed
//
// Advisory bots (CodeRabbit) are reported but never waited on. Comment edits are never events,
// and top-level comments from CI and deploy bots are skipped, because checks carry that news.
//
// State lives in ~/.local/state/cstack/pr-wait/ (or --state-dir). A lock file makes a second
// watcher for the same PR exit at once. A state file lets a restarted watcher report what arrived
// while no watcher ran. The first run for a PR records what already exists and reports only what
// comes after. State older than 6 hours is discarded.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, linkSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, loadConfig, run } from "./lib/common.mjs";
import { registerWatcher } from "./lib/workers.mjs";

// Review bots. A gating bot must review the head before `ready`. An advisory bot is reported only.
const GATING_BOTS = ["greptile", "macroscope"];
const ADVISORY_BOTS = ["coderabbit"];
// CI and deploy bots report through checks. Their PR comments are status reports.
const STATUS_BOTS = ["github-actions", "vercel", "netlify", "railway", "cloudflare"];
const STALE_STATE_MS = 6 * 3600 * 1000;
const MAX_FAILED_POLLS = 10;
const GH_ATTEMPTS = 5;
const TRANSIENT =
  /HTTP (5\d\d|429)|rate limit|timed? ?out|connection (reset|refused)|EOF|temporar|could not resolve host|TLS handshake|Something went wrong/i;
const FAILED = ["fail", "cancel"];
// gh pr checks buckets, worst first. Duplicate names (push and pull_request runs of one job)
// collapse to the worst bucket.
const RANK = { fail: 4, cancel: 3, pending: 2, pass: 1, skipping: 0 };
const rank = (b) => RANK[b] ?? 2;

const QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url state headRefOid baseRefName mergeStateStatus
      author { login }
      baseRef { target { oid } }
      comments(last: 100) { nodes { id url body author { login __typename } } }
      reviews(last: 100) {
        nodes { id url state body commit { oid } author { login __typename } }
      }
      reviewThreads(last: 100) {
        nodes {
          isResolved path line
          comments(first: 100) { nodes { id url body author { login __typename } } }
        }
      }
    }
  }
}
`;

class GhError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function log(message) {
  writeSync(2, `pr-wait: ${message}\n`);
}

function out(line) {
  writeSync(1, line + "\n");
}

// Fatal messages go to stdout so a monitor shows the agent why it stopped.
function fail(message, code = 2) {
  out(`pr-wait: ${message}`);
  throw new Exit(code);
}

// Backoff for transient gh failures starts at a tenth of the poll interval (2s at the default).
let backoffMs = 2000;

// Run gh. Retries transient failures (HTTP 5xx or 429, network) with doubling backoff.
async function gh(args, allow = [0]) {
  let delay = backoffMs;
  for (let attempt = 1; ; attempt++) {
    const r = run("gh", args);
    const { code } = r;
    const stderr = r.stderr || "";
    const transient = code !== 0 && TRANSIENT.test(stderr);
    if (!transient && allow.includes(code)) return { code, stdout: r.stdout || "", stderr };
    const lines = stderr.trim().split("\n").filter(Boolean);
    const message = lines.at(-1) || `gh exited ${code}`;
    if (!transient || attempt === GH_ATTEMPTS) throw new GhError(message, transient);
    log(`gh ${args.slice(0, 2).join(" ")}: ${message}; retry in ${delay / 1000}s`);
    await sleep(delay);
    delay *= 2;
  }
}

async function ghLines(args) {
  return (await gh(args)).stdout.split("\n").filter(Boolean);
}

function parseJson(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new GhError(`unreadable ${what} response`, true);
  }
}

// Which review bot a login or check name belongs to, if any.
function botName(text) {
  const lowered = (text || "").toLowerCase();
  return [...GATING_BOTS, ...ADVISORY_BOTS].find((bot) => lowered.includes(bot)) ?? null;
}

function who(node) {
  const author = node.author || {};
  return [author.login || "ghost", author.__typename === "Bot"];
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function plain(body) {
  const noComments = (body || "").replace(/<!--[\s\S]*?-->/g, " ");
  return unescapeHtml(noComments.replace(/<[^>]+>/g, " "));
}

function snippet(body, limit = 100) {
  const text = plain(body).replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : text.slice(0, limit - 3) + "...";
}

// The verdict line of a bot summary, if it has one.
function verdict(body) {
  for (const line of plain(body).split("\n")) {
    if (/verdict|confidence score/i.test(line)) return snippet(line.replaceAll("*", ""), 80);
  }
  return "";
}

function digest(body) {
  return createHash("sha1").update(plain(body).replace(/\s+/g, " ")).digest("hex").slice(0, 12);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function parseTarget(raw, repo) {
  if (raw === undefined || !raw.trim()) {
    fail("missing PR number. Did a variable expand to nothing? Usage: pr-wait <pr> [--repo owner/name]");
  }
  const url = raw.trim().match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/);
  const number = raw.trim().match(/^#?(\d+)$/);
  let pr;
  if (url) {
    repo = repo || url[1];
    pr = Number(url[2]);
  } else if (number) pr = Number(number[1]);
  else fail(`'${raw}' is not a PR number or PR URL`);
  if (pr <= 0) fail(`'${raw}' is not a valid PR number`);
  if (!repo) {
    try {
      repo = (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).stdout.trim();
    } catch (err) {
      fail(`no --repo given and the current directory has no GitHub repo (${err.message})`);
    }
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`'${repo}' is not owner/name`);
  try {
    await gh(["pr", "view", String(pr), "-R", repo, "--json", "number"]);
  } catch (err) {
    // A transient failure is retried by the poll loop.
    if (!err.transient) fail(`cannot read ${repo}#${pr}: ${err.message}`);
  }
  return { repo, pr };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// Exclusive per-PR lock: a file holding the owner's pid, created atomically with link(2).
// A lock whose pid is gone is stale and gets replaced. The lock is removed on exit.
class Lock {
  constructor(file) {
    this.file = file;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, String(process.pid));
    try {
      for (let i = 0; ; i++) {
        try {
          linkSync(tmp, file);
          break;
        } catch (err) {
          if (err.code !== "EEXIST") throw err;
        }
        if (i >= 3) fail(`could not take the lock ${file}; another watcher keeps replacing it`);
        const pid = this.owner();
        if (pid !== null && pid !== process.pid && pidAlive(pid)) {
          fail(
            `pid ${pid} already watches this PR, so this watcher exits to avoid duplicate events. ` +
              `If no events reach you from it, run \`kill ${pid}\` and start again.`,
          );
        }
        log(`replacing stale lock ${file} (pid ${pid ?? "unknown"} is gone)`);
        try {
          unlinkSync(file);
        } catch {
          // Another watcher removed it first. Retry the link.
        }
      }
    } finally {
      unlinkSync(tmp);
    }
  }
  owner() {
    try {
      return Number.parseInt(readFileSync(this.file, "utf8").trim(), 10) || null;
    } catch {
      return null;
    }
  }
  // Two watchers can race to replace one stale lock. The loser notices here and exits.
  verify() {
    const pid = this.owner();
    if (pid !== process.pid) fail(`pid ${pid ?? "unknown"} took over the lock for this PR, so this watcher exits.`);
  }
  release() {
    if (this.owner() === process.pid) unlinkSync(this.file);
  }
}

// Required check names from GitHub: rulesets and classic branch protection. Knowing them up front
// means a required check that has not started yet counts as pending, instead of green by omission.
async function githubRequired(repo, base) {
  const sources = [
    [
      `repos/${repo}/rules/branches/${base}`,
      '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context',
    ],
    [`repos/${repo}/branches/${base}/protection/required_status_checks`, ".contexts[]?, .checks[]?.context"],
  ];
  const names = new Set();
  for (const [p, jq] of sources) {
    try {
      for (const n of await ghLines(["api", p, "--jq", jq])) names.add(n);
    } catch (err) {
      // 404 means no protection. 403 means the plan or token cannot read it (private repos on
      // free plans). Both mean "none".
      if (!/HTTP 40[34]/.test(err.message)) log(`could not read required checks from ${p}: ${err.message}`);
    }
  }
  return names;
}

// required_checks from .cstack/config.json, when the cwd is inside a checkout configured for repo.
function configRequired(repo, cwd = process.cwd()) {
  let found;
  try {
    found = loadConfig(cwd);
  } catch (err) {
    if (!/no \.cstack\/config\.json/.test(err.message)) log(err.message);
    return new Set();
  }
  const { config } = found;
  if (typeof config.repo === "string" && config.repo.toLowerCase() !== repo.toLowerCase()) return new Set();
  return new Set((Array.isArray(config.required_checks) ? config.required_checks : []).filter((x) => typeof x === "string" && x));
}

class Watcher {
  constructor({ repo, pr, until, interval, stateDir, lock, timeout = null }) {
    Object.assign(this, { repo, pr, until, interval, lock, timeout });
    [this.owner, this.name] = repo.split("/");
    this.path = path.join(stateDir, `${repo.replace("/", "__")}__${pr}.json`);
    const state = this.load();
    // First run for this PR: record what exists and report nothing.
    this.baseline = state === null;
    this.state = state || { reported: [], summaries: {}, base_oid: null, merge_state: null };
    this.reported = new Set(this.state.reported);
    this.printed = new Set();
    this.events = 0;
    this.required = null;
    this.prevSnapshot = null;
    this.prFiles = new Map();
  }

  load() {
    try {
      if (Date.now() - statSync(this.path).mtimeMs > STALE_STATE_MS) return null;
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      return s && Array.isArray(s.reported) ? { summaries: {}, base_oid: null, merge_state: null, ...s } : null;
    } catch {
      return null;
    }
  }

  save() {
    this.state.reported = [...this.reported].sort();
    const tmp = this.path.replace(/\.json$/, ".tmp");
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }

  say(line) {
    if (this.printed.has(line)) return;
    this.printed.add(line);
    out(`#${this.pr} ${line}`);
  }

  // Print an event once per PR, across restarts.
  emit(key, line) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (!this.baseline) {
      this.events++;
      this.say(line);
    }
  }

  finish(code, lines = []) {
    for (const line of lines) this.say(line);
    this.save();
    throw new Exit(code);
  }

  async fetchPr() {
    const r = await gh([
      "api", "graphql", "-f", `query=${QUERY}`,
      "-f", `owner=${this.owner}`, "-f", `name=${this.name}`, "-F", `number=${this.pr}`,
    ]);
    const data = parseJson(r.stdout, "graphql")?.data;
    const pr = data?.repository?.pullRequest;
    if (!pr) throw new GhError(`${this.repo}#${this.pr} not found in the GraphQL response`, false);
    pr.viewer = data.viewer?.login;
    return pr;
  }

  async fetchChecks() {
    // gh pr checks exits 8 while checks are pending and 1 when one failed. Those are states,
    // not errors: read the JSON and ignore the exit code.
    const r = await gh(["pr", "checks", String(this.pr), "-R", this.repo, "--json", "name,bucket,link,description"], [0, 1, 8]);
    if (!r.stdout.trim()) {
      if (r.stderr.includes("no checks reported")) return new Map();
      throw new GhError(r.stderr.trim() || `gh pr checks exited ${r.code}`, false);
    }
    const checks = new Map();
    for (const row of parseJson(r.stdout, "gh pr checks")) {
      const current = checks.get(row.name);
      if (!current || rank(row.bucket) > rank(current.bucket)) checks.set(row.name, row);
    }
    return checks;
  }

  // Files this PR touches that the new base commits also touch.
  async baseOverlap(head, old, now) {
    let moved;
    try {
      if (!this.prFiles.has(head)) this.prFiles.set(head, new Set(await ghLines(["pr", "diff", String(this.pr), "-R", this.repo, "--name-only"])));
      moved = await ghLines(["api", `repos/${this.repo}/compare/${old}...${now}`, "--jq", ".files[].filename"]);
    } catch (err) {
      log(`could not compare base commits: ${err.message}`);
      return [];
    }
    const mine = this.prFiles.get(head);
    return [...new Set(moved)].filter((f) => mine.has(f)).sort();
  }

  // How far the head is behind its base, for the green and ready lines.
  async behind(base, baseOid, head) {
    if (!baseOid) return "";
    try {
      const count = (await gh(["api", `repos/${this.repo}/compare/${baseOid}...${head}`, "--jq", ".behind_by"])).stdout.trim();
      return `; ${count} commit${count === "1" ? "" : "s"} behind ${base}`;
    } catch {
      return "";
    }
  }

  async poll() {
    this.lock?.verify();
    const pr = await this.fetchPr();
    if (pr.state === "MERGED") this.finish(0, [`merged: ${pr.url}`]);
    if (pr.state === "CLOSED") this.finish(1, [`closed without merging: ${pr.url}`]);

    const base = pr.baseRefName;
    if (this.required === null) {
      const fromGithub = await githubRequired(this.repo, base);
      const fromConfig = configRequired(this.repo);
      this.required = new Set([...fromGithub, ...fromConfig]);
      const gateText = [...this.required].sort().join(", ") || "none set, so every CI check gates";
      const src = fromConfig.size ? ` (${fromConfig.size} from .cstack/config.json)` : "";
      log(`watching ${this.repo}#${this.pr} until ${this.until}; required checks: ${gateText}${src}`);
    }
    const checks = await this.fetchChecks();
    const head = pr.headRefOid;
    const short = head.slice(0, 7);
    const mine = new Set([who(pr)[0], pr.viewer]);
    const comments = pr.comments?.nodes || [];
    const reviews = pr.reviews?.nodes || [];
    const threads = pr.reviewThreads?.nodes || [];
    this.events = 0;

    // Required checks. With none configured, every CI check gates except the review bots' own.
    const gate = this.required.size ? this.required : new Set([...checks.keys()].filter((n) => !botName(n)));
    const label = this.required.size ? "required check" : "check";
    const bucket = (name) => (checks.has(name) ? checks.get(name).bucket : "pending");

    const failLines = [];
    for (const name of [...gate].sort()) {
      if (FAILED.includes(bucket(name))) {
        const link = checks.get(name).link;
        failLines.push(`${label} failed: ${name} ${link}`);
        this.emit(`fail:${head}:${name}:${link}`, failLines.at(-1));
      }
    }
    const watched = new Map([...checks].filter(([n]) => !ADVISORY_BOTS.includes(botName(n))));
    const gateDone = gate.size > 0 && [...gate].every((n) => bucket(n) !== "pending");
    const allDone = gateDone && [...watched.values()].every((c) => c.bucket !== "pending");
    // Checks appear a few seconds after a push. Two identical polls in a row guard against
    // calling a half-registered set of checks finished.
    const snapshot = JSON.stringify([...watched].map(([n, c]) => [n, c.bucket]).sort());
    const stable = snapshot === this.prevSnapshot;
    this.prevSnapshot = snapshot;
    const green = gateDone && stable && failLines.length === 0;

    // People and bots talking. Edits are never events.
    for (const c of comments) {
      const [login, isBot] = who(c);
      if (mine.has(login) || botName(login) || (isBot && STATUS_BOTS.some((b) => login.includes(b)))) continue;
      this.emit(`c:${c.id}`, `comment from ${login}: ${snippet(c.body)} ${c.url}`);
    }
    for (const r of reviews) {
      const [login, isBot] = who(r);
      if (mine.has(login) || isBot) continue;
      if (["APPROVED", "CHANGES_REQUESTED"].includes(r.state) || (r.body || "").trim()) {
        const st = r.state.toLowerCase().replaceAll("_", " ");
        this.emit(`c:${r.id}`, `review from ${login} (${st}): ${snippet(r.body)} ${r.url}`);
      }
    }
    const unresolved = [];
    for (const t of threads) {
      const nodes = t.comments?.nodes || [];
      if (!t.isResolved && nodes.length) unresolved.push(nodes[0].url);
      const where = t.line ? `${t.path}:${t.line}` : t.path;
      nodes.forEach((c, i) => {
        const [login] = who(c);
        if (mine.has(login)) return;
        const kind = i === 0 ? "new thread" : "thread reply";
        this.emit(`c:${c.id}`, `${kind} from ${login} on ${where}: ${snippet(c.body)} ${c.url}`);
      });
    }

    // Review bots on the current head. A bot with checks is done when they finish. Otherwise it is
    // done once it reviews the head commit or its summary names the head.
    const botStatus = new Map();
    const reviewed = [];
    for (const bot of [...GATING_BOTS, ...ADVISORY_BOTS]) {
      const advisory = ADVISORY_BOTS.includes(bot);
      const ownChecks = [...checks].filter(([n]) => botName(n) === bot);
      const summaries = comments.filter((c) => botName(who(c)[0]) === bot);
      const ownReviews = reviews.filter((r) => botName(who(r)[0]) === bot);
      const onHead = ownReviews.some((r) => r.commit?.oid === head);
      const done = ownChecks.length
        ? ownChecks.every(([, c]) => c.bucket !== "pending")
        : onHead || summaries.some((s) => (s.body || "").includes(short));
      const seen = ownChecks.length || summaries.length || ownReviews.length;
      if (advisory && ownChecks.length) {
        const desc = ownChecks[0][1];
        botStatus.set(bot, `${bot} ${desc.description || desc.bucket} (advisory)`);
      } else if (seen) {
        botStatus.set(bot, `${bot} ${done ? "done" : "pending"}${advisory ? " (advisory)" : ""}`);
      }
      const key = `bot:${bot}:${head}`;
      const wasDone = this.reported.has(key);
      if (done) {
        if (!advisory) reviewed.push(bot);
        const failed = ownChecks.filter(([, c]) => FAILED.includes(c.bucket)).map(([n]) => n);
        const detail = [
          summaries.map((s) => verdict(s.body)).find(Boolean) || "",
          failed.length ? `failed: ${failed.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        const tag = advisory ? " (advisory, not waited on)" : "";
        this.emit(key, `${bot} finished on ${short}${detail ? ": " + detail : ""}${tag}`);
      }
      if (!advisory) {
        for (const s of summaries) {
          const now = digest(s.body);
          const old = this.state.summaries[s.id];
          this.state.summaries[s.id] = now;
          if (wasDone && old && old !== now) {
            const text = verdict(s.body) || snippet(s.body);
            this.emit(`summary:${s.id}:${now}`, `${bot} summary changed on ${short}: ${text} ${s.url}`);
          }
        }
      }
    }

    // Base branch and merge state.
    const baseOid = pr.baseRef?.target?.oid;
    const oldBase = this.state.base_oid;
    if (baseOid && oldBase && baseOid !== oldBase && !this.baseline) {
      const touched = await this.baseOverlap(head, oldBase, baseOid);
      if (touched.length) {
        const more = touched.length > 5 ? ` and ${touched.length - 5} more` : "";
        this.emit(`base:${baseOid}`, `${base} moved to ${baseOid.slice(0, 7)} and touches files in this PR: ${touched.slice(0, 5).join(", ")}${more}`);
      }
    }
    if (baseOid) this.state.base_oid = baseOid;
    const mergeState = pr.mergeStateStatus;
    const dirtyLine = `merge state is DIRTY: the branch conflicts with ${base}, rebase it`;
    const behindLine = `merge state is BEHIND: update the branch from ${base} before merging`;
    if (mergeState !== "UNKNOWN") {
      if (["BEHIND", "DIRTY"].includes(mergeState) && this.state.merge_state !== mergeState) {
        this.emit(`merge:${mergeState}:${head}:${baseOid}`, mergeState === "DIRTY" ? dirtyLine : behindLine);
      }
      this.state.merge_state = mergeState;
    }

    // One summary line per head once all checks finish.
    const counts = {};
    for (const c of watched.values()) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
    const failedNames = [...watched].filter(([, c]) => FAILED.includes(c.bucket)).map(([n]) => n).sort();
    const req = [...this.required];
    const parts = [
      Object.keys(counts).sort().map((b) => `${counts[b]} ${b}`).join(", ") + (failedNames.length ? ` (${failedNames.join(", ")})` : ""),
      req.length ? `required ${req.filter((n) => ["pass", "skipping"].includes(bucket(n))).length}/${req.length} green` : "",
      [...GATING_BOTS, ...ADVISORY_BOTS].filter((b) => botStatus.has(b)).map((b) => botStatus.get(b)).join(", ") ||
        `no ${GATING_BOTS.join(" or ")} review yet`,
      plural(unresolved.length, "unresolved thread"),
      `merge state ${mergeState}`,
    ];
    const summary = parts.filter(Boolean).join("; ");
    const checksKey = `checks:${head}`;

    // Decide whether to stop. A green or ready line carries the same summary as the checks line,
    // so it marks that event as reported.
    if (this.until !== "any-change") {
      if (mergeState === "DIRTY") this.finish(1, [dirtyLine]);
      if (failLines.length) this.finish(1, failLines);
      if (green && this.until === "green") {
        this.reported.add(checksKey);
        this.finish(0, [`green on ${short}: ${summary}${await this.behind(base, baseOid, head)}`]);
      }
      // ready waits for a gating bot, never for an advisory one.
      if (green && reviewed.length) {
        if (unresolved.length) this.finish(1, [`blocked by ${plural(unresolved.length, "unresolved thread")} on ${short}: ${unresolved.join(" ")}`]);
        if (mergeState === "BEHIND") this.finish(1, [behindLine]);
        this.reported.add(checksKey);
        this.finish(0, [`ready on ${short}: ${summary}${await this.behind(base, baseOid, head)}`]);
      }
    }
    if (allDone && (stable || this.baseline)) this.emit(checksKey, `checks finished on ${short}: ${summary}`);
    if (this.until === "any-change" && this.events) this.finish(0);
  }

  async run() {
    let failures = 0;
    const started = Date.now();
    for (;;) {
      try {
        await this.poll();
        failures = 0;
        this.save();
        if (this.baseline) log(`baseline recorded for ${this.repo}#${this.pr}; reporting only new events`);
        this.baseline = false;
      } catch (err) {
        if (!(err instanceof GhError)) throw err;
        if (!err.transient) this.finish(1, [`pr-wait stopped: ${err.message}`]);
        failures++;
        log(`poll failed (${failures}/${MAX_FAILED_POLLS}): ${err.message}`);
        if (failures >= MAX_FAILED_POLLS) this.finish(1, [`pr-wait stopped: GitHub unreachable for ${failures} polls: ${err.message}`]);
      }
      if (this.timeout !== null && Date.now() - started >= this.timeout * 1000) this.finish(3, [`timeout: ${this.timeout}s`]);
      await sleep(this.interval * 1000);
    }
  }
}

// The run store this watcher serves, so the pending-work Stop hook counts it: --store, else the store
// named by CSTACK_RUN under the configured repo the watcher runs in. No store means nothing to register.
function watcherStore(explicit) {
  if (explicit) return path.resolve(explicit);
  if (!process.env.CSTACK_RUN) return null;
  try {
    const store = path.join(loadConfig(process.cwd()).root, ".cstack", "runs", process.env.CSTACK_RUN);
    return existsSync(store) ? store : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, { options: ["repo", "until", "interval", "state-dir", "store", "timeout"] });
  } catch (err) {
    fail(err.message);
  }
  const until = args.until ?? "ready";
  if (!["ready", "green", "any-change"].includes(until)) fail(`--until must be ready, green or any-change, not '${until}'`);
  const rawInterval = args.interval ?? "20";
  if (!/^\d+$/.test(rawInterval)) fail(`--interval must be a whole number of seconds, not '${rawInterval}'`);
  const interval = Math.max(Number(rawInterval), 1);
  backoffMs = interval * 100;
  const timeout = args.timeout === undefined ? null : Number(args.timeout);
  if (timeout !== null && !(timeout > 0)) fail(`--timeout must be a positive number of seconds, not '${args.timeout}'`);
  if (args._.length > 1) fail(`expected one PR, got ${args._.length}: ${args._.join(" ")}`);
  const stateDir = path.resolve(args["state-dir"] || path.join(os.homedir(), ".local", "state", "cstack", "pr-wait"));

  const { repo, pr } = await parseTarget(args._[0], args.repo);
  mkdirSync(stateDir, { recursive: true });
  const lock = new Lock(path.join(stateDir, `${repo.replace("/", "__")}__${pr}.lock`));
  process.on("exit", () => lock.release());
  const store = watcherStore(args.store);
  if (store) registerWatcher(store, "pr-wait");
  await new Watcher({ repo, pr, until, interval, stateDir, lock, timeout }).run();
}

process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
try {
  await main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof Exit)) throw err;
  process.exitCode = err.code;
}
