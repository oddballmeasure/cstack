#!/usr/bin/env node
// Gate: the scout's bookkeeping, its per-category autonomy gate, and the only path that files its issues.
// Adapted from Cardinal src/cardinal/scout/{once,gate,outcomes,render}.py (oddballmeasure/cardinal, same owner).
// Usage:
//   scout-gate.mjs record [--repo-dir <d>] [--json]
//       Track record per category over 60 days, read from GitHub (issues whose body carries the
//       Cstack-Scout marker), and whether each category may file ready on its own now.
//   scout-gate.mjs choose <plan.json> --store <dir> [--json]
//       The areas to survey this pass: not surveyed within scout.cooldown_days, never-surveyed first,
//       then the longest ago, at most scout.areas_per_pass.
//   scout-gate.mjs mark <plan.json> --store <dir> --area <name>
//       Record that an area was surveyed now (<store>/areas.tsv).
//   scout-gate.mjs file <bundle.json> --store <dir> --pass <id> [--dry-run] [--json]
//       bundle: {"proposal": {...}, "review": {"verdict", "reason", "category"?, "evidence"?}, "repro_diff"?: <path>}
//       Drops anything the reviewer did not confirm (product_decision files as needs-human), re-runs the code
//       checks on the reviewer's evidence, drops duplicates (same fingerprint still open, approved or errored,
//       or rejected within 60 days; or an open issue with a similar title), holds the proposal for the next
//       pass when this pass already filed scout.max_proposals_per_pass, then files one issue with the body
//       written here and the label the gate decides: <prefix>:ready only under scout.autonomy auto with the
//       category's track record over every bar, else <prefix>:proposed.
// Approval counts only a person's decision: swapping proposed for ready (or the issue landing). An auto-filed
// issue never counts as approved; a person closing it counts as rejected.
// <store>/ledger.tsv records every decision; the `filing` row is written before the issue is created, so a
// crash in between never files twice. Exit 0 approved (filed), 1 rejected (dropped, duplicate, held,
// filing failed), 2 usage error.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Gate, main, parseArgs, UsageError, loadConfig, run } from "./lib/common.mjs";
import { gh } from "./lib/checks.mjs";
import { isTest } from "./lib/repo.mjs";
import {
  VERDICTS,
  WINDOW_DAYS,
  decide,
  fingerprint,
  outcome,
  proposalProblem,
  render,
  scoutSettings,
  shapeProblem,
  similar,
  trackRecord,
  trackedFiles,
} from "./lib/scout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86400 * 1000;
const LEDGER_HEADER = "ts\tpass\tfingerprint\taction\tcategory\tissue\ttitle\treason";
const USAGE = "usage: scout-gate.mjs record [--repo-dir d] | choose <plan.json> --store <dir> | mark <plan.json> --store <dir> --area <name> | file <bundle.json> --store <dir> --pass <id> [--dry-run]  [--json]";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${file}: ${err.message}`);
  }
}

function scoutIssues(ctx) {
  const out = gh(["issue", "list", "--repo", ctx.repo, "--state", "all", "--search", "Cstack-Scout in:body", "--json", "number,title,state,labels,body,createdAt", "--limit", "1000"], ctx.root);
  return JSON.parse(out);
}

function record(gate, ctx) {
  const issues = scoutIssues(ctx);
  const rec = trackRecord(issues, ctx.prefix);
  const categories = {};
  for (const category of ctx.settings.categories) {
    // A repro is judged per proposal, so assume one could succeed only when repro is enabled.
    const [mode, why] = decide(ctx.settings, rec, category, ctx.settings.repro);
    const c = rec[category] ?? { decided: 0, approved: 0, rejected: 0, done: 0, error: 0, approval: 0, done_rate: null };
    categories[category] = { ...c, gate: mode, why };
    gate.pass(category, `${c.decided} decided, ${c.approved} approved, ${c.rejected} rejected, ${c.done} done, ${c.error} error: ${mode} (${why})`);
  }
  const since = Date.now() - WINDOW_DAYS * DAY_MS;
  const rejected = issues
    .filter((i) => outcome(i, ctx.prefix) === "rejected" && Date.parse(i.createdAt) >= since)
    .map((i) => ({ number: i.number, title: i.title }));
  return gate.finish({ autonomy: ctx.settings.autonomy, window_days: WINDOW_DAYS, categories, rejected });
}

const areaKey = (area) => [...new Set((area.paths ?? []).map((p) => String(p).replace(/^\/+|\/+$/g, "")))].sort().join(",");

function surveyedAt(store) {
  const file = path.join(store, "areas.tsv");
  const last = {};
  if (!existsSync(file)) return last;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const [key, ts] = line.split("\t");
    last[key] = ts;
  }
  return last;
}

function planAreas(file) {
  const areas = readJson(file)?.areas;
  if (!Array.isArray(areas)) throw new UsageError(`${file}: expected {"areas": [...]}`);
  return areas;
}

function choose(gate, ctx, file) {
  const areas = planAreas(file);
  const last = surveyedAt(ctx.store);
  const cutoff = new Date(Date.now() - ctx.settings.cooldown_days * DAY_MS).toISOString();
  const seen = new Set();
  const fresh = [];
  for (const a of areas) {
    const key = areaKey(a);
    if (seen.has(key)) continue;
    seen.add(key);
    if ((last[key] ?? "") <= cutoff) fresh.push(a);
    else gate.pass(`skip ${a.name}`, `surveyed ${last[key]}, within ${ctx.settings.cooldown_days} days`);
  }
  const chosen = fresh.sort((a, b) => (last[areaKey(a)] ?? "").localeCompare(last[areaKey(b)] ?? "")).slice(0, ctx.settings.areas_per_pass);
  for (const a of chosen) gate.pass(`survey ${a.name}`, last[areaKey(a)] ? `last surveyed ${last[areaKey(a)]}` : "never surveyed");
  return gate.finish({ areas: chosen });
}

function mark(gate, ctx, file, name) {
  const area = planAreas(file).find((a) => a.name === name);
  if (!area) throw new UsageError(`no area named ${JSON.stringify(name)} in ${file}`);
  mkdirSync(ctx.store, { recursive: true });
  const ts = new Date().toISOString();
  appendFileSync(path.join(ctx.store, "areas.tsv"), `${areaKey(area)}\t${ts}\n`);
  gate.pass(`marked ${name}`, ts);
  return gate.finish();
}

function ledgerRows(store) {
  const file = path.join(store, "ledger.tsv");
  if (!existsSync(file)) return [];
  const [head, ...lines] = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const cols = head.split("\t");
  return lines.map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v])));
}

function ledger(ctx, row) {
  const file = path.join(ctx.store, "ledger.tsv");
  mkdirSync(ctx.store, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, `${LEDGER_HEADER}\n`);
  const clean = (v) => String(v ?? "").replace(/[\t\n]/g, " ");
  const cells = [new Date().toISOString(), ctx.pass, row.key, row.action, row.category, row.issue, row.title, row.reason].map(clean);
  appendFileSync(file, `${cells.join("\t")}\n`);
}

function duplicateOf(ctx, issues, key, title) {
  const since = Date.now() - WINDOW_DAYS * DAY_MS;
  for (const issue of issues) {
    if (!issue.body.includes(`Cstack-Scout: ${key}`)) continue;
    const result = outcome(issue, ctx.prefix);
    if ([null, "approved", "error"].includes(result) || (result === "rejected" && Date.parse(issue.createdAt) >= since)) {
      return `already filed as #${issue.number} (${result ?? "undecided"})`;
    }
  }
  const open = JSON.parse(gh(["issue", "list", "--repo", ctx.repo, "--state", "open", "--json", "number,title", "--limit", "1000"], ctx.root));
  const like = open.find((i) => similar(i.title, title));
  return like ? `duplicates open issue #${like.number}: ${like.title}` : null;
}

function reproDiff(file) {
  if (!file) return null;
  const text = readFileSync(path.resolve(file), "utf8");
  const files = [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  return { text, files, ok: files.length > 0 && files.every(isTest) };
}

function file(gate, ctx, bundleFile, dryRun) {
  const bundle = readJson(bundleFile);
  const { proposal, review } = bundle ?? {};
  const shape = shapeProblem(proposal);
  if (shape) throw new UsageError(`${bundleFile}: ${shape}`);
  if (!VERDICTS.includes(review?.verdict) || typeof review.reason !== "string" || !review.reason.trim()) {
    throw new UsageError(`${bundleFile}: review needs a verdict (${VERDICTS.join(", ")}) and a reason`);
  }
  const key = /^[0-9a-f]{16}$/.test(proposal.fingerprint ?? "") ? proposal.fingerprint : fingerprint(proposal);
  const base = { key, category: proposal.category, title: proposal.title };
  const stop = (action, reason) => {
    ledger(ctx, { ...base, action, category: proposal.category, reason });
    gate.fail(action, reason);
    return gate.finish({ action, fingerprint: key });
  };
  if (!["confirmed", "product_decision"].includes(review.verdict)) return stop("dropped", `reviewer: ${review.verdict}: ${review.reason.trim()}`);
  if (review.category && review.category !== proposal.category && ctx.settings.categories.includes(review.category)) {
    gate.pass("category", `reviewer recategorised ${proposal.category} as ${review.category}`);
    proposal.category = review.category;
  }
  if (review.verdict === "confirmed" && Array.isArray(review.evidence) && review.evidence.length) proposal.evidence = review.evidence;
  const problem = proposalProblem(ctx.root, proposal, trackedFiles(ctx.root, ctx.config), ctx.config, ctx.settings);
  if (problem) return stop("dropped", `after review: ${problem}`);
  gate.pass("checks", "shape, files, acceptance and evidence hold after review");
  const repro = reproDiff(bundle.repro_diff);
  if (repro && !repro.ok) return stop("dropped", `the repro diff changes files that are not tests: ${repro.files.join(", ") || "none"}`);
  const prior = ledgerRows(ctx.store).filter((r) => r.fingerprint === key).at(-1);
  if (prior?.action === "filing") return stop("filing", "an earlier filing of this proposal was interrupted; look for that issue before filing by hand");
  const issues = scoutIssues(ctx);
  const dup = duplicateOf(ctx, issues, key, proposal.title);
  if (dup) return stop("duplicate", dup);
  const filed = ledgerRows(ctx.store).filter((r) => r.pass === ctx.pass && r.action === "filed").length;
  if (filed >= ctx.settings.max_proposals_per_pass) {
    mkdirSync(path.join(ctx.store, "held"), { recursive: true });
    writeFileSync(path.join(ctx.store, "held", `${key}.json`), `${JSON.stringify(bundle, null, 2)}\n`);
    return stop("held", `this pass already filed ${filed}; held in held/${key}.json for the next pass`);
  }
  const [mode, why] = review.verdict === "product_decision" ? ["needs_human", ""] : decide(ctx.settings, trackRecord(issues, ctx.prefix), proposal.category, ctx.settings.repro && Boolean(repro));
  const label = `${ctx.prefix}:${{ proposed: "proposed", auto: "ready", needs_human: "needs-human" }[mode]}`;
  gate.pass("autonomy", `${mode}${why ? ` (${why})` : ""}, label ${label}`);
  const badge = readFileSync(path.join(HERE, "..", "templates", "footer.md"), "utf8").trim();
  const body = render({ proposal, review, mode, why, prefix: ctx.prefix, key, testDiff: repro?.text, badge });
  if (dryRun) return gate.finish({ action: "dry-run", fingerprint: key, label, title: proposal.title, body });
  const bodyFile = path.join(ctx.store, `issue-${key}.md`);
  mkdirSync(ctx.store, { recursive: true });
  writeFileSync(bodyFile, `${body}\n`);
  ledger(ctx, { ...base, action: "filing", reason: label });
  const created = run("gh", ["issue", "create", "--repo", ctx.repo, "--title", proposal.title, "--body-file", bodyFile, "--label", label], { cwd: ctx.root });
  if (created.code !== 0) return stop("file-error", `gh issue create failed: ${created.stderr.trim()}`);
  const issue = Number(created.stdout.trim().split("/").pop());
  ledger(ctx, { ...base, action: "filed", issue, reason: label });
  rmSync(path.join(ctx.store, "held", `${key}.json`), { force: true });
  gate.pass("filed", `#${issue} ${label}`);
  return gate.finish({ action: "filed", fingerprint: key, issue, label, mode });
}

await main(async (argv) => {
  const args = parseArgs(argv, { flags: ["json", "dry-run"], options: ["repo-dir", "store", "area", "pass"] });
  const [command, target] = args._;
  const arity = command === "record" ? 1 : 2;
  if (!["record", "choose", "mark", "file"].includes(command) || args._.length !== arity) throw new UsageError(USAGE);
  if (command !== "record" && !args.store) throw new UsageError(`${command} needs --store`);
  if (command === "mark" && !args.area) throw new UsageError("mark needs --area");
  if (command === "file" && !/^[\w.-]+$/.test(args.pass ?? "")) throw new UsageError("file needs --pass <id> (letters, digits, dot, dash, underscore)");
  const store = args.store && path.resolve(args.store);
  const { root, config } = loadConfig(args["repo-dir"] || store || process.cwd());
  const ctx = { root, config, store, pass: args.pass, repo: config.repo, prefix: config.label_prefix, settings: scoutSettings(config) };
  const gate = new Gate(`scout-gate ${command}`, { json: args.json });
  if (command === "record") return record(gate, ctx);
  if (command === "choose") return choose(gate, ctx, path.resolve(target));
  if (command === "mark") return mark(gate, ctx, path.resolve(target), args.area);
  return file(gate, ctx, path.resolve(target), args["dry-run"]);
});
