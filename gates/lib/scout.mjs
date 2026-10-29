// Scout rules shared by scout-check.mjs and scout-gate.mjs. Models find and argue; this code decides.
// Adapted from Cardinal src/cardinal/scout/{checks,gate,outcomes,render}.py (oddballmeasure/cardinal, same owner).
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { gitOut, matchesAny } from "./common.mjs";

export const CATEGORIES = ["bug", "regression", "docs", "enhancement", "feature"];
// Wrong behaviour a test can show failing on the base branch.
export const REPRO_CATEGORIES = new Set(["bug", "regression"]);
export const VERDICTS = ["confirmed", "wrong", "product_decision", "too_big", "duplicate"];
export const WINDOW_DAYS = 60; // how far back rejections are remembered and track records are counted
const DAY_MS = 86400 * 1000;

// Cardinal's live [scout] values. config `scout` overrides any of them.
export const SCOUT_DEFAULTS = {
  autonomy: "propose",
  categories: [...CATEGORIES],
  areas_per_pass: 2,
  cooldown_days: 7,
  max_proposals_per_pass: 3,
  max_files: 3,
  repro: true,
  auto_min_decided: 10,
  auto_min_approval: 0.8,
  auto_min_done: 0.7,
};

export const scoutSettings = (config) => ({ ...SCOUT_DEFAULTS, ...(config.scout ?? {}) });

// A criterion is observable when it names an exact value: a number, a quoted literal or a JSON literal.
const OBSERVABLE = /\d|`[^`]+`|"[^"]+"|\[\]|\{\}|\b(?:null|true|false)\b/;
const MAX_SPAN = 40;
const DRIFT = 10; // models miscount lines; a quote found this close to its cited range is the same evidence
const SIMILAR = 0.6;
const DOCS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

export const normalise = (text) => String(text).split(/\s+/).filter(Boolean).join(" ");
const blocked = (rel, config) => matchesAny(rel, [...config.paths_off_limits, ...config.paths_hidden]);

// Tracked files agents may see: git's index minus the hidden suite.
export function trackedFiles(root, config) {
  const out = gitOut(root, ["ls-files"]);
  return new Set(out.split("\n").filter((f) => f && !matchesAny(f, config.paths_hidden)));
}

// Every occurrence of the quote as [start, end] lines, preferring one near the citation or the only one.
export function locate(lines, item) {
  const quote = normalise(item.quote);
  let text = "";
  const lineOf = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/\S+/g)) {
      if (text) {
        text += " ";
        lineOf.push(i + 1);
      }
      text += m[0];
      for (let k = 0; k < m[0].length; k++) lineOf.push(i + 1);
    }
  });
  const found = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push([lineOf[at], lineOf[at + quote.length - 1]]);
  const distance = ([s, e]) => Math.max(item.line_start - e, s - item.line_end, 0);
  const near = found.filter((f) => distance(f) <= DRIFT);
  if (near.length) return near.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return found.length === 1 ? found[0] : null;
}

// Checks every quote; where a model miscounted lines, corrects the cited range in place.
export function evidenceProblem(root, items, tracked, config) {
  for (const item of items) {
    const where = `${item.path}:${item.line_start}-${item.line_end}`;
    const file = path.join(root, item.path);
    let stat = null;
    try {
      stat = lstatSync(file);
    } catch {}
    if (!tracked.has(item.path) || !stat?.isFile()) return `evidence ${item.path} is not a tracked file`;
    if (blocked(item.path, config)) return `evidence ${item.path} is off limits`;
    const span = item.line_end - item.line_start;
    if (span < 0 || span >= MAX_SPAN) return `evidence ${where} is not a range of 1-${MAX_SPAN} lines`;
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const found = locate(lines, item);
    if (!found) {
      if (item.line_start > lines.length) return `evidence ${where} is past the end of the file (${lines.length} lines)`;
      return `evidence ${where} does not contain the quoted text, nor do the ${DRIFT} lines around it`;
    }
    if (found[0] !== item.line_start || found[1] !== item.line_end) {
      item.corrected_from ??= [item.line_start, item.line_end];
      [item.line_start, item.line_end] = found;
    }
  }
  return null;
}

// A fix that only changes prose: no test can fail on it, so there is nothing to reproduce.
export const docsOnly = (files) => files.every((f) => DOCS.has(path.extname(f).toLowerCase()));

const isText = (v, min, max = Infinity) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;
const isLine = (v) => Number.isInteger(v) && v >= 1;
const listOf = (v, min, max, ok) => Array.isArray(v) && v.length >= min && v.length <= max && v.every(ok);

// The proposal's shape (Cardinal's contracts/scout.py Proposal model).
export function shapeProblem(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "proposal is not a JSON object";
  if (!CATEGORIES.includes(p.category)) return `category must be one of ${CATEGORIES.join(", ")}`;
  if (!isText(p.title, 8, 100)) return "title must be 8-100 characters";
  if (!isText(p.problem, 40)) return "problem must be at least 40 characters, with exact values";
  const evidenceOk = (e) => e && typeof e.path === "string" && isLine(e.line_start) && isLine(e.line_end) && normalise(e.quote ?? "").length >= 8;
  if (!listOf(p.evidence, 1, 5, evidenceOk)) return "evidence must be 1-5 items, each with path, line_start, line_end and a quote of 8 or more characters";
  if (!isText(p.expected, 10)) return "expected must be at least 10 characters";
  if (!listOf(p.acceptance, 1, 6, (a) => isText(a, 1))) return "acceptance must be 1-6 non-empty strings";
  if (!listOf(p.files, 1, Infinity, (f) => isText(f, 1))) return "files must name at least one file";
  return null;
}

export function proposalProblem(root, p, tracked, config, settings) {
  const shape = shapeProblem(p);
  if (shape) return shape;
  if (!settings.categories.includes(p.category)) return `category ${p.category} is not enabled`;
  if (p.category === "docs" && !docsOnly(p.files)) return "a docs proposal may change only documentation files";
  const files = [...new Set(p.files)];
  if (files.length > settings.max_files) return `a fix would change ${files.length} files; the limit is ${settings.max_files}`;
  for (const f of files) {
    if (!tracked.has(f)) return `file to change ${f} is not a tracked file`;
    if (blocked(f, config)) return `file to change ${f} is off limits`;
  }
  const vague = p.acceptance.find((a) => !OBSERVABLE.test(a));
  if (vague) return `acceptance criterion names no exact value: ${JSON.stringify(vague)}`;
  return evidenceProblem(root, p.evidence, tracked, config);
}

export const words = (title) => new Set([...String(title).toLowerCase().matchAll(/[a-z0-9]+/g)].map((m) => m[0]).filter((w) => w.length > 2));

// Jaccard overlap of title words. Two titles with no words give 0 / 0, which is NaN and never similar.
export function similar(left, right) {
  const a = words(left);
  const b = words(right);
  const both = [...a].filter((w) => b.has(w)).length;
  return both / new Set([...a, ...b]).size >= SIMILAR;
}

export function fingerprint(p) {
  const paths = [...new Set(p.evidence.map((e) => e.path))].sort();
  const key = [p.category, ...paths, [...words(p.title)].sort().join(" ")].join("\0");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// The scout's marker lines in a filed issue body.
export function markers(body) {
  const get = (re) => String(body).match(re)?.[1] ?? null;
  return {
    fingerprint: get(/^Cstack-Scout: ([0-9a-f]{16})$/m),
    category: get(/^Category: (\S+)$/m),
    mode: get(/^Cstack-Scout-Mode: (\S+)$/m),
  };
}

// What became of one filed issue: done, error, approved, rejected, or null (undecided).
// An auto-filed issue starts ready. That is the scout's own decision, not a person's approval.
export function outcome(issue, prefix) {
  const labels = new Set(issue.labels);
  const mode = markers(issue.body).mode;
  if (labels.has(`${prefix}:done`)) return "done";
  if (labels.has(`${prefix}:error`)) return "error";
  if (mode !== "auto" && (labels.has(`${prefix}:ready`) || labels.has(`${prefix}:in-progress`))) return "approved";
  if (issue.state === "closed") return "rejected";
  return null;
}

// Per category over the window: approval is approved / decided, done-rate is done / landed.
// Product decisions stay out. An auto-filed issue never counts as approved: it counts as rejected when a
// person closes it, and its landing (done or error) counts toward the done-rate only.
export function trackRecord(issues, prefix, now = Date.now()) {
  const record = {};
  const since = now - WINDOW_DAYS * DAY_MS;
  for (const issue of issues) {
    const m = markers(issue.body);
    if (!m.fingerprint || !m.category || m.mode === "needs_human" || Date.parse(issue.createdAt) < since) continue;
    const result = outcome(issue, prefix);
    if (!result) continue;
    const c = (record[m.category] ??= { decided: 0, approved: 0, rejected: 0, done: 0, error: 0 });
    if (result === "done" || result === "error") c[result] += 1;
    if (result === "rejected") {
      c.decided += 1;
      c.rejected += 1;
    } else if (m.mode !== "auto") {
      c.decided += 1;
      c.approved += 1;
    }
  }
  for (const c of Object.values(record)) {
    const landed = c.done + c.error;
    c.approval = c.decided ? Math.round((c.approved / c.decided) * 1000) / 1000 : 0;
    c.done_rate = landed ? Math.round((c.done / landed) * 1000) / 1000 : null;
  }
  return record;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// ["auto" | "proposed", why]. A bug or regression also needs a test that failed on the base branch.
export function decide(settings, record, category, reproOk) {
  if (settings.autonomy === "propose") return ["proposed", "autonomy is propose"];
  const c = record[category] ?? { decided: 0, approval: 0, done_rate: null };
  const problems = [];
  if (c.decided < settings.auto_min_decided) problems.push(`${c.decided} decided ${category} proposals in ${WINDOW_DAYS} days, under ${settings.auto_min_decided}`);
  if (c.approval < settings.auto_min_approval) problems.push(`approval ${pct(c.approval)} is under ${pct(settings.auto_min_approval)}`);
  if ((c.done_rate ?? 0) < settings.auto_min_done) {
    problems.push(`${c.done_rate === null ? "no landed issues" : `done-rate ${pct(c.done_rate)}`}, under ${pct(settings.auto_min_done)}`);
  }
  const needsRepro = REPRO_CATEGORIES.has(category);
  if (needsRepro && !reproOk) problems.push("no test that fails on the base branch");
  if (problems.length) return ["proposed", `not auto: ${problems.join("; ")}`];
  const landed = c.done_rate === null ? "no landed issues" : `${pct(c.done_rate)} of landed ones done`;
  return ["auto", `${c.decided} decided ${category} proposals in ${WINDOW_DAYS} days, ${pct(c.approval)} approved, ${landed}${needsRepro ? ", and a test that fails on the base branch" : ""}`];
}

const FOOTERS = {
  proposed: (l) => `Proposed by cstack's scout. Approve by swapping \`${l.proposed}\` for \`${l.ready}\`; reject by closing with a comment saying why. The scout reads both.`,
  auto: (l, why) => `Filed ready by cstack's scout: ${why}.`,
  needs_human: (l) => `cstack's scout found a product decision, not work it may file on its own. Swap \`${l.needs_human}\` for \`${l.ready}\` to have cstack do it, or close it with a comment.`,
};

export function fence(text, language = "") {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${language}\n${text.trimEnd()}\n${ticks}`;
}

// The issue body, written by code from the checked proposal, so every filed issue has the same shape.
export function render({ proposal, review, mode, why, prefix, key, testDiff, badge }) {
  const labels = { proposed: `${prefix}:proposed`, ready: `${prefix}:ready`, needs_human: `${prefix}:needs-human` };
  const parts = ["## Problem", proposal.problem.trim(), "", "## Evidence"];
  for (const e of proposal.evidence) {
    const range = (s, t) => `${s}${t !== s ? `-${t}` : ""}`;
    let citation = `\`${e.path}:${range(e.line_start, e.line_end)}\``;
    if (e.corrected_from) citation += ` (lines corrected from ${range(...e.corrected_from)})`;
    parts.push(citation, fence(e.quote), "");
  }
  parts.push("## Expected", proposal.expected.trim(), "", "## Acceptance", ...proposal.acceptance.map((a) => `- [ ] ${a}`), "", "## Files", ...proposal.files.map((f) => `- \`${f}\``));
  if (testDiff) parts.push("", "## Suggested test", "This test fails on the base branch and states the acceptance criteria.", fence(testDiff, "diff"));
  parts.push("", "---", FOOTERS[mode](labels, why), `Reviewer: ${review.reason.trim()}`, `Category: ${proposal.category}`, `Cstack-Scout: ${key}`, `Cstack-Scout-Mode: ${mode}`, "", badge);
  return parts.join("\n");
}
