// change-watch: pr-wait's watcher for every forge but GitHub, built only on forge-layer verbs (ADR-013).
// gates/pr-wait.mjs runs it when forgeKind(config) is not github, and keeps its flags, exit codes, lock, state
// file and Stop-hook registration; pr-wait passes those in as `io`. Semantics:
//   green  every required check passes on the head. Required: config required_checks, else
//          forge.requiredChecks(base), else every check (bar review bots' own)
//   ready  green, every config review_bots bot finished on the head (none listed: none waited on), and no
//          unresolved thread; a forge merge state of behind blocks it too
// Events: a failed check (exit 1 when required), all checks finished (one summary line), a new thread or reply
// from anyone but the current user, a review bot finished, merge state conflict (exit 1) or behind, merged
// (exit 0), closed (exit 1). Commits behind the base are info on the green and ready lines: with merge commits
// GitLab does not block on them.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openForge } from "./forge.mjs";

const STALE_STATE_MS = 6 * 3600 * 1000;
const MAX_FAILED_POLLS = 10;
const ATTEMPTS = 5;
// glab prints "(HTTP 502)" or "502 Bad Gateway"; network failures come from Go's net stack.
const TRANSIENT = /HTTP (5\d\d|429)|\b(5\d\d|429) [A-Z]|rate limit|timed? ?out|connection (reset|refused)|EOF|temporar|could not resolve host|TLS handshake/i;

class ForgeError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const strings = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === "string" && s) : []);
function snippet(body, limit = 100) {
  const text = String(body).replace(/\s+/g, " ").trim();
  return text.length <= limit ? text : text.slice(0, limit - 3) + "...";
}

// <n>, #<n>, !<n> or a merge request URL. The repo: --repo, else the URL's, else config repo.
function parseTarget(raw, explicit, configured, fail) {
  if (raw === undefined || !raw.trim()) fail("missing change number. Did a variable expand to nothing? Usage: pr-wait <n> [--repo group/project]");
  const url = raw.trim().match(/^https?:\/\/[^/\s]+\/(\S+?)\/-\/merge_requests\/(\d+)(?:[/?#]\S*)?$/);
  const number = raw.trim().match(/^[#!]?(\d+)$/);
  if (!url && !number) fail(`'${raw}' is not a change number or merge request URL`);
  const id = Number(url ? url[2] : number[1]);
  if (id <= 0) fail(`'${raw}' is not a valid change number`);
  const repo = explicit || url?.[1] || configured;
  if (!repo) fail("no --repo given and no repo in .cstack/config.json");
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(repo)) fail(`'${repo}' is not group/project`);
  return { repo, id };
}

export class ChangeWatcher {
  constructor({ forge, config, id, until, interval, stateDir, lock, timeout, io }) {
    Object.assign(this, { forge, id, until, interval, lock, timeout, io });
    this.requiredFromConfig = strings(config.required_checks);
    this.bots = strings(config.review_bots).map((b) => b.toLowerCase());
    this.path = path.join(stateDir, `${forge.kind}__${forge.repo.replaceAll("/", "__")}__${id}.json`);
    const state = this.load();
    // First run for this change: record what exists and report nothing.
    this.baseline = state === null;
    this.reported = new Set(state?.reported);
    this.printed = new Set();
    this.events = 0;
    this.required = null;
    this.me = null;
    this.prevSnapshot = null;
  }

  load() {
    try {
      if (Date.now() - statSync(this.path).mtimeMs > STALE_STATE_MS) return null;
      const s = JSON.parse(readFileSync(this.path, "utf8"));
      return Array.isArray(s?.reported) ? s : null;
    } catch {
      return null;
    }
  }

  save() {
    const tmp = this.path.replace(/\.json$/, ".tmp");
    writeFileSync(tmp, JSON.stringify({ reported: [...this.reported].sort() }));
    renameSync(tmp, this.path);
  }

  say(line) {
    if (this.printed.has(line)) return;
    this.printed.add(line);
    this.io.out(`#${this.id} ${line}`);
  }

  // Print an event once per change, across restarts.
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
    this.io.exit(code);
  }

  // One forge verb. Transient failures retry with doubling backoff, from a tenth of the interval; an
  // unreadable response fails the poll at once, as pr-wait does on GitHub.
  async call(fn, attempt = 1, delay = this.interval * 100) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SyntaxError) throw new ForgeError(`unreadable response from ${this.forge.name}`, true);
      const transient = TRANSIENT.test(err.message);
      if (!transient || attempt === ATTEMPTS) throw new ForgeError(err.message, transient);
      this.io.log(`${this.forge.name}: ${err.message}; retry in ${delay / 1000}s`);
      await sleep(delay);
      return this.call(fn, attempt + 1, delay * 2);
    }
  }

  // The change exists. A transient failure is left to the poll loop.
  async probe() {
    try {
      await this.call(() => this.forge.change(this.id, []));
    } catch (err) {
      if (!err.transient) this.io.fail(`cannot read ${this.forge.repo}#${this.id}: ${err.message}`);
    }
  }

  botOf(name) {
    return this.bots.find((b) => name.toLowerCase().includes(b)) ?? null;
  }

  async poll() {
    this.lock.verify();
    const f = this.forge;
    const c = await this.call(() => f.change(this.id, []));
    if (c.state === "merged") this.finish(0, [`merged: ${c.url}`]);
    if (c.state === "closed") this.finish(1, [`closed without merging: ${c.url}`]);

    if (this.required === null) {
      const fromConfig = this.requiredFromConfig;
      const names = fromConfig.length ? fromConfig : await this.call(() => f.requiredChecks(c.base));
      this.me = (await this.call(() => f.currentUser())).login;
      this.required = new Set(names);
      const gateText = [...this.required].sort().join(", ") || "none set, so every check gates";
      this.io.log(`watching ${f.repo}#${this.id} on ${f.name} until ${this.until}; required checks: ${gateText}${fromConfig.length ? " (from .cstack/config.json)" : ""}`);
    }
    const head = c.head;
    const short = head.slice(0, 7);
    const checks = new Map((await this.call(() => f.checks(head))).map((k) => [k.name, k]));
    const threads = await this.call(() => f.threads(this.id));
    const reviews = this.bots.length ? await this.call(() => f.reviews(this.id)) : [];
    this.events = 0;

    // Checks. With none required, every check gates except the review bots' own.
    const gate = this.required.size ? this.required : new Set([...checks.keys()].filter((n) => !this.botOf(n)));
    const label = this.required.size ? "required check" : "check";
    const state = (name) => checks.get(name)?.state ?? "pending";
    const failLines = [];
    for (const name of [...gate].sort()) {
      if (state(name) !== "fail") continue;
      const k = checks.get(name);
      failLines.push(`${label} failed: ${name} ${k.url}`);
      this.emit(`fail:${head}:${name}:${k.id}`, failLines.at(-1));
    }
    for (const [name, k] of checks) {
      if (!gate.has(name) && !this.botOf(name) && k.state === "fail") this.emit(`fail:${head}:${name}:${k.id}`, `check failed (not required): ${name} ${k.url}`);
    }
    const gateDone = gate.size > 0 && [...gate].every((n) => state(n) !== "pending");
    const allDone = gateDone && [...checks.values()].every((k) => k.state !== "pending");
    // Jobs appear a few seconds after a push: two identical polls in a row before calling them finished.
    const snapshot = JSON.stringify([...checks].map(([n, k]) => [n, k.state]).sort());
    const stable = snapshot === this.prevSnapshot;
    this.prevSnapshot = snapshot;
    const green = gateDone && stable && failLines.length === 0;

    // Threads. Edits are never events.
    const unresolved = [];
    for (const t of threads) {
      if (!t.resolved) unresolved.push(t.url || t.id);
      const where = t.path ? ` on ${t.line ? `${t.path}:${t.line}` : t.path}` : "";
      t.comments.forEach((cm, i) => {
        if (cm.author === this.me) return;
        const kind = i === 0 ? "new thread" : "thread reply";
        this.emit(`c:${cm.url || `${t.id}:${i}`}`, `${kind} from ${cm.author}${where}: ${snippet(cm.body)}${cm.url ? ` ${cm.url}` : ""}`);
      });
    }

    // Review bots from config: a bot with checks is done when they finish, else once it reviewed the head
    // or a comment of its names the head.
    const botStatus = [];
    let reviewed = 0;
    for (const bot of this.bots) {
      const own = [...checks.values()].filter((k) => this.botOf(k.name) === bot);
      const done = own.length
        ? own.every((k) => k.state !== "pending")
        : reviews.some((r) => r.author.toLowerCase().includes(bot) && (r.commit === head || String(r.body).includes(short)));
      botStatus.push(`${bot} ${done ? "done" : "pending"}`);
      if (done) {
        reviewed++;
        this.emit(`bot:${bot}:${head}`, `${bot} finished on ${short}`);
      }
    }

    // Merge state. Commits behind the base are info only.
    const conflictLine = `merge state is conflict: the branch conflicts with ${c.base}, rebase it`;
    const behindLine = `merge state is behind: update the branch from ${c.base} before merging`;
    if (c.merge === "conflict") this.emit(`merge:conflict:${head}:${c.baseSha}`, conflictLine);
    if (c.merge === "behind") this.emit(`merge:behind:${head}:${c.baseSha}`, behindLine);
    const behind = c.behind > 0 ? `; ${plural(c.behind, "commit")} behind ${c.base}` : "";

    const counts = {};
    for (const k of checks.values()) counts[k.state] = (counts[k.state] || 0) + 1;
    const failedNames = [...checks.values()].filter((k) => k.state === "fail").map((k) => k.name).sort();
    const req = [...this.required];
    const summary = [
      Object.keys(counts).sort().map((s) => `${counts[s]} ${s}`).join(", ") + (failedNames.length ? ` (${failedNames.join(", ")})` : ""),
      req.length ? `required ${req.filter((n) => ["pass", "skipped"].includes(state(n))).length}/${req.length} green` : "",
      botStatus.join(", "),
      plural(unresolved.length, "unresolved thread"),
      `merge state ${c.mergeRaw}`,
    ].filter(Boolean).join("; ");
    const checksKey = `checks:${head}`;

    // A green or ready line carries the checks summary, so it marks that event as reported.
    if (this.until !== "any-change") {
      if (c.merge === "conflict") this.finish(1, [conflictLine]);
      if (failLines.length) this.finish(1, failLines);
      if (green && this.until === "green") {
        this.reported.add(checksKey);
        this.finish(0, [`green on ${short}: ${summary}${behind}`]);
      }
      if (green && reviewed === this.bots.length) {
        if (unresolved.length) this.finish(1, [`blocked by ${plural(unresolved.length, "unresolved thread")} on ${short}: ${unresolved.join(" ")}`]);
        if (c.merge === "behind") this.finish(1, [behindLine]);
        this.reported.add(checksKey);
        this.finish(0, [`ready on ${short}: ${summary}${behind}`]);
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
        if (this.baseline) this.io.log(`baseline recorded for ${this.forge.repo}#${this.id}; reporting only new events`);
        this.baseline = false;
      } catch (err) {
        if (!(err instanceof ForgeError)) throw err;
        if (!err.transient) this.finish(1, [`pr-wait stopped: ${err.message}`]);
        failures++;
        this.io.log(`poll failed (${failures}/${MAX_FAILED_POLLS}): ${err.message}`);
        if (failures >= MAX_FAILED_POLLS) this.finish(1, [`pr-wait stopped: ${this.forge.name} unreachable for ${failures} polls: ${err.message}`]);
      }
      if (this.timeout !== null && Date.now() - started >= this.timeout * 1000) this.finish(3, [`timeout: ${this.timeout}s`]);
      await sleep(this.interval * 1000);
    }
  }
}

// pr-wait's entry for a non-GitHub forge. io: {out, log, fail(message), exit(code), lock(file), register()};
// fail and exit throw, so this never returns.
export async function watchChange({ target, repo, config, cwd, until, interval, timeout, stateDir, io }) {
  const t = parseTarget(target, repo, config.repo, io.fail);
  // Config required checks and review bots belong to the configured repo only.
  const own = !config.repo || config.repo.toLowerCase() === t.repo.toLowerCase();
  let forge;
  try {
    forge = openForge({ ...config, repo: t.repo }, { cwd });
  } catch (err) {
    io.fail(err.message);
  }
  const watcher = new ChangeWatcher({ forge, config: own ? config : {}, id: t.id, until, interval, timeout, stateDir, io, lock: null });
  await watcher.probe();
  mkdirSync(stateDir, { recursive: true });
  watcher.lock = io.lock(watcher.path.replace(/\.json$/, ".lock"));
  io.register();
  return watcher.run();
}
