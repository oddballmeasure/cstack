#!/usr/bin/env node
// Gate: judge every check on each merge commit a cstack run made, once the checks finish.
// Adapted from Cardinal src/cardinal/daemon/post_merge.py (oddballmeasure/cardinal, same owner).
// Usage: post-merge.mjs --store <dir> [--repo-dir <d>] [--lines 80] [--wait [--timeout <s>]] [--json]
//
// Merges come from units.tsv: units in state merged or done with a PR. GitHub's merge commit and
// merge time are the truth; the units.tsv sha column is informational. Per merge:
//   - older than 6h with no verdict: expired
//   - no checks listed: waiting for 10 minutes, then no_checks
//   - any check still running, or a re-run not yet replacing its failed check: waiting
//   - all checks passed (success, skipped, neutral): passed
//   - failures, first time: re-run each failed Actions run once (`gh run rerun <id> --failed`): rerun
//   - failures again (or nothing could be re-run): file one issue
//     "CI failed on <base> after #<pr>: <checks>" with log tails, labelled <prefix>:ready, or
//     <prefix>:needs-human when the merged unit's issue was itself such a follow-up.
// post-merge.tsv (append-only, latest row per PR wins) records each verdict. The `filing` row is
// written BEFORE the issue is created and `filed` after, so a crash in between never files twice:
// an interrupted filing stays a finding for a human.
// --wait judges again every CSTACK_POST_MERGE_POLL_MS (default 60000) until nothing is waiting. With --timeout it
// stops after that many seconds with merges still waiting and exits 3, so a session without a Monitor tool can re-run it.
// Exit 0 when nothing is red, 1 when a merge is filed, filing, expired or failed to file, 2 on usage errors.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerWatcher } from "./lib/workers.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";
import { openStore } from "./lib/store.mjs";
import { gh, latestChecks, checkTail } from "./lib/checks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GIVE_UP_MS = 6 * 3600 * 1000;
const LISTING_GRACE_MS = 10 * 60 * 1000;
const PASSED = new Set(["success", "skipped", "neutral"]);
const TERMINAL = new Set(["passed", "no_checks", "expired", "filing", "filed"]);
const HEADER = "ts\tunit\tpr\tmerge_sha\tstate\tdetail";
const ACTIONS_RUN = /\/actions\/runs\/(\d+)\//;

function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((l) => {
      const [ts, unit, pr, merge_sha, state, detail] = l.split("\t");
      return { ts, unit, pr, merge_sha, state, detail };
    });
}

function appendRow(file, row) {
  if (!existsSync(file)) writeFileSync(file, `${HEADER}\n`);
  const cells = [new Date().toISOString(), row.unit, row.pr, row.merge_sha, row.state, row.detail];
  appendFileSync(file, `${cells.map((c) => String(c).replace(/[\t\r\n]+/g, " ")).join("\t")}\n`);
}

const names = (list) => list.map((n) => `\`${n}\``).join(", ");

function judge(ctx, unit, rows) {
  const { repo, dir, file } = ctx;
  const last = rows.findLast((r) => r.pr === unit.pr);
  const record = (state, detail, sha) => {
    appendRow(file, { unit: unit.id, pr: unit.pr, merge_sha: sha, state, detail });
    return { state, detail };
  };
  if (last && TERMINAL.has(last.state)) return { state: last.state, detail: last.detail, sha: last.merge_sha, cached: true };

  const pr = JSON.parse(gh(["pr", "view", unit.pr, "--repo", repo, "--json", "state,mergeCommit,mergedAt"], dir));
  if (pr.state !== "MERGED") return { state: "not-merged", detail: `PR is ${pr.state}`, sha: unit.sha };
  const sha = pr.mergeCommit.oid;
  const age = Date.now() - Date.parse(pr.mergedAt);
  const out = (state, detail) => ({ ...record(state, detail, sha), sha });
  if (age > GIVE_UP_MS) return out("expired", "no verdict 6h after the merge");

  const checks = latestChecks(repo, sha, dir);
  if (checks.length === 0) {
    if (age > LISTING_GRACE_MS) return out("no_checks", "no checks listed 10 minutes after the merge");
    return { state: "waiting", detail: "no checks listed yet", sha };
  }
  // A failed filing keeps the earlier re-run, so the retry files instead of re-running CI again.
  const rerunRow = rows.findLast((r) => r.pr === unit.pr && r.state === "rerun");
  const rerun = rerunRow ? parseRerun(rerunRow.detail) : null;
  const running = checks.filter((c) => c.status !== "completed" || rerun?.ids.includes(String(c.id)));
  if (running.length) return { state: "waiting", detail: `running: ${running.map((c) => c.name).join(", ")}`, sha };
  const failed = checks.filter((c) => !PASSED.has(c.conclusion));
  if (!failed.length) return out("passed", `${checks.length} checks passed`);

  const actions = new Map(failed.filter((c) => ACTIONS_RUN.test(String(c.details_url))).map((c) => [c.name, String(c.details_url).match(ACTIONS_RUN)[1]]));
  if (!rerun && actions.size) {
    const ok = new Set();
    for (const id of new Set(actions.values())) {
      if (run("gh", ["run", "rerun", id, "--failed", "--repo", repo], { cwd: dir }).code === 0) ok.add(id);
    }
    if (ok.size) {
      const ids = failed.filter((c) => ok.has(actions.get(c.name))).map((c) => c.id);
      const notRerun = [...actions.keys()].filter((n) => !ok.has(actions.get(n)));
      return out("rerun", `ids=${ids.join(",")};not_rerun=${notRerun.join(",")}`);
    }
  }
  const repeated = rerun ? failed.filter((c) => actions.has(c.name) && !rerun.notRerun.includes(c.name)).map((c) => c.name) : [];
  return fileFollowUp(ctx, unit, rows, failed, repeated, sha, record);
}

function parseRerun(detail) {
  const [, ids, notRerun] = detail.match(/^ids=([^;]*);not_rerun=(.*)$/);
  const list = (s) => (s ? s.split(",") : []);
  return { ids: list(ids), notRerun: list(notRerun) };
}

function isFollowUp(ctx, unit, rows) {
  if (!unit.issue) return false;
  if (rows.some((r) => r.state === "filed" && r.detail === `#${unit.issue}`)) return true;
  const view = run("gh", ["issue", "view", unit.issue, "--repo", ctx.repo, "--json", "title"], { cwd: ctx.dir });
  return view.code === 0 && JSON.parse(view.stdout).title.startsWith(`CI failed on ${ctx.base} after #`);
}

function fileFollowUp(ctx, unit, rows, failed, repeated, sha, record) {
  const { repo, base, prefix, dir, store, lines } = ctx;
  const looping = isFollowUp(ctx, unit, rows);
  const label = `${prefix}:${looping ? "needs-human" : "ready"}`;
  const failedNames = failed.map((c) => c.name);
  const title = `CI failed on ${base} after #${unit.pr}: ${failedNames.join(", ")}`;
  const once = failedNames.filter((n) => !repeated.includes(n));
  const parts = [];
  if (repeated.length) parts.push(`these checks failed on \`${base}\` at that commit, and again when re-run: ${names(repeated)}.`);
  if (once.length) parts.push(`${repeated.length ? "These checks failed and were not re-run" : `these checks failed on \`${base}\` at that commit`}: ${names(once)}.`);
  const tails = failed.map((c) => `Check \`${c.name}\` concluded ${c.conclusion} on ${sha.slice(0, 12)}. Log tail:\n${checkTail(repo, c, lines, dir)}`);
  const footer = readFileSync(path.join(HERE, "..", "templates", "footer.md"), "utf8").trim();
  const body = [
    `cstack merged #${unit.pr}${unit.issue ? ` (for #${unit.issue})` : ""} as \`${sha}\`. Afterwards ${parts.join(" ")}`,
    ...(looping ? [`#${unit.issue} was itself filed for a post-merge CI failure, so this needs a person.`] : []),
    "```\n" + tails.join("\n\n").replaceAll("```", "'''") + "\n```",
    footer,
  ].join("\n\n");
  const bodyFile = path.join(store, `post-merge-${sha.slice(0, 12)}.md`);
  writeFileSync(bodyFile, `${body}\n`);
  record("filing", title, sha);
  const created = run("gh", ["issue", "create", "--repo", repo, "--title", title, "--body-file", bodyFile, "--label", label], { cwd: dir });
  if (created.code !== 0) return { ...record("file-error", created.stderr.trim(), sha), sha };
  const number = created.stdout.trim().split("/").pop();
  return { ...record("filed", `#${number}`, sha), sha, label };
}

const RED = new Set(["expired", "filing", "filed", "file-error"]);

function round(ctx, json) {
  const s = openStore(ctx.store);
  let units;
  try {
    units = s.units.list().filter((u) => ["merged", "done"].includes(u.state) && u.pr);
  } finally {
    s.close();
  }
  const gate = new Gate("post-merge", { json });
  const merges = [];
  for (const unit of units) {
    const r = judge(ctx, unit, readRows(ctx.file));
    merges.push({ unit: unit.id, pr: Number(unit.pr), merge_sha: r.sha, state: r.state, detail: r.detail });
    const line = `${r.state} (${r.detail})${r.cached ? ", recorded earlier" : ""}`;
    if (r.state === "filing") gate.fail(`#${unit.pr}`, `${line}: interrupted while filing; look for that issue before filing by hand`);
    else if (RED.has(r.state)) gate.fail(`#${unit.pr}`, `${line}${r.label ? `, labelled ${r.label}` : ""}`);
    else gate.pass(`#${unit.pr}`, line);
  }
  const pending = merges.filter((m) => ["waiting", "rerun"].includes(m.state)).length;
  gate.pass("pending", `${pending} of ${merges.length} merges still waiting`);
  return { gate, merges, pending };
}

main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "wait"], options: ["store", "repo-dir", "lines", "timeout"] });
  const lines = Number(args.lines ?? 80);
  const timeout = args.timeout === undefined ? null : Number(args.timeout);
  if (args._.length || !args.store || !Number.isInteger(lines) || lines < 1 || (timeout !== null && (!(timeout > 0) || !args.wait))) {
    throw new UsageError("usage: post-merge.mjs --store <dir> [--repo-dir <d>] [--lines n] [--wait [--timeout <s>]] [--json]");
  }
  const started = Date.now();
  const store = path.resolve(args.store);
  const dir = path.resolve(args["repo-dir"] || store);
  const { config } = loadConfig(dir);
  const ctx = { repo: config.repo, base: config.base_branch, prefix: config.label_prefix, dir, store, file: path.join(store, "post-merge.tsv"), lines };
  const poll = Number(process.env.CSTACK_POST_MERGE_POLL_MS || 60000);
  if (args.wait) registerWatcher(store, "post-merge");
  for (;;) {
    const r = round(ctx, args.json);
    if (!args.wait || r.pending === 0) return r.gate.finish({ merges: r.merges, pending: r.pending });
    if (timeout !== null && Date.now() - started >= timeout * 1000) {
      r.gate.finish({ merges: r.merges, pending: r.pending, timeout });
      return 3;
    }
    await new Promise((res) => setTimeout(res, poll));
  }
});
