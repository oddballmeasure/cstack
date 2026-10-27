#!/usr/bin/env node
// Gate: an intake decision (templates/intake.json) is well formed and workable.
// Rules follow Cardinal's IntakeDecision and orchestrator.ordered/validate.
// Usage: node gates/check-intake.mjs <intake.json> --repo <dir> [--json]
import { Gate, main, parseArgs, gitOut, UsageError } from "./lib/common.mjs";
import { readDoc, onePath, duplicates, findCycle } from "./lib/docs.mjs";

const WORKABLE = ["feature", "bug", "chore"];
const KINDS = [...WORKABLE, "question", "reject", "needs_human"];
const NEW = "new:";

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTextList = (v) => Array.isArray(v) && v.every(isText);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

// Shape problems. Later checks assume the shape is right, so the gate stops here on any.
function shape(d) {
  if (!isObject(d)) return ["top level must be a JSON object"];
  const out = [];
  if (!Number.isInteger(d.issue) || d.issue < 1) out.push("issue must be a positive integer");
  if (!KINDS.includes(d.classification)) out.push(`classification must be one of ${KINDS.join("|")}`);
  if (!isText(d.summary)) out.push("summary must be non-empty text (for reject it is the reason)");
  if (d.question !== undefined && typeof d.question !== "string") out.push("question must be text");
  for (const [key, spec] of [
    ["requirements", { id: isText, text: isText }],
    ["tickets", { id: isText, title: isText, requirements: isTextList, depends_on: isTextList, target_files: isTextList }],
  ]) {
    if (!Array.isArray(d[key])) {
      out.push(`${key} must be an array`);
      continue;
    }
    d[key].forEach((item, i) => {
      const bad = Object.keys(spec).filter((k) => !isObject(item) || !spec[k](item[k]));
      if (bad.length) out.push(`${key}[${i}]: bad or missing ${bad.join(", ")}`);
    });
  }
  return out;
}

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["repo"] });
  const text = readDoc(onePath(args, "check-intake.mjs <intake.json> --repo <dir> [--json]"), "intake");
  if (!args.repo) throw new UsageError("--repo <dir> is required");
  const tracked = new Set(gitOut(args.repo, ["ls-files"]).split("\n"));
  const g = new Gate("check-intake", { json: args.json });

  let d;
  try {
    d = JSON.parse(text);
  } catch (err) {
    g.fail("json", `does not parse: ${err.message}`);
    return g.finish();
  }
  const bad = shape(d);
  g.check(!bad.length, "shape", "fields and types valid", bad.join("; "));
  if (bad.length) return g.finish();

  const rIds = d.requirements.map((r) => r.id);
  const rDup = duplicates(rIds);
  g.check(!rDup.length, "requirements-unique", "requirement ids unique", `repeated: ${rDup.join(", ")}`);

  if (!WORKABLE.includes(d.classification)) {
    g.check(!d.tickets.length, "no-tickets", `${d.classification} carries no tickets`, `a ${d.classification} decision must not carry tickets`);
    if (["question", "needs_human"].includes(d.classification)) {
      g.check(isText(d.question), "question", "question for a person is set", `a ${d.classification} decision needs a non-empty question`);
    }
    return g.finish();
  }

  g.check(rIds.length > 0, "requirements", `${rIds.length} requirements`, `a ${d.classification} decision needs requirements`);
  const n = d.tickets.length;
  g.check(n >= 1 && n <= 4, "ticket-count", `${n} tickets`, `needs 1-4 tickets, got ${n}`);
  const tIds = d.tickets.map((t) => t.id);
  const tDup = duplicates(tIds);
  g.check(!tDup.length, "tickets-unique", "ticket ids unique", `repeated: ${tDup.join(", ")}`);

  const covered = d.tickets.flatMap((t) => t.requirements);
  const wrong = rIds.map((r) => [r, covered.filter((c) => c === r).length]).filter(([, k]) => k !== 1);
  const unknownR = [...new Set(covered.filter((c) => !rIds.includes(c)))];
  g.check(
    !wrong.length && !unknownR.length,
    "coverage",
    "every requirement covered by exactly one ticket",
    [...wrong.map(([r, k]) => `${r} covered ${k} times`), ...unknownR.map((r) => `${r} is not a requirement`)].join("; "),
  );

  for (const t of d.tickets) {
    const deps = t.depends_on.filter((x) => x === t.id || !tIds.includes(x));
    g.check(!deps.length, `depends ${t.id}`, "dependencies exist", `unknown or self dependency: ${deps.join(", ")}`);
    const absent = t.target_files.filter((f) => !f.startsWith(NEW) && !tracked.has(f));
    const fresh = t.target_files.filter((f) => f.startsWith(NEW) && tracked.has(f.slice(NEW.length)));
    g.check(
      t.target_files.length > 0 && !absent.length && !fresh.length,
      `files ${t.id}`,
      "target files exist (or are marked new:)",
      t.target_files.length
        ? [...absent.map((f) => `${f} is not tracked (prefix new: for a file the ticket creates)`), ...fresh.map((f) => `${f} already exists`)].join("; ")
        : "target_files is empty",
    );
  }

  const cycle = findCycle(new Map(d.tickets.map((t) => [t.id, t.depends_on])));
  g.check(!cycle, "acyclic", "no dependency cycles", `cycle: ${cycle?.join(" -> ")}`);
  return g.finish();
});
