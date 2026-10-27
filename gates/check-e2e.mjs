#!/usr/bin/env node
// Gate: e2e-plan.md follows templates/e2e-plan.md and covers spec.md.
// Usage: node gates/check-e2e.mjs <e2e-plan.md> --spec <spec.md> [--config <path>] [--json]
// Without --config the gate finds .cstack/config.json above the plan.
import path from "node:path";
import { Gate, main, parseArgs, loadConfig, UsageError } from "./lib/common.mjs";
import { readDoc, onePath, parseSpec, parseE2e, hasExactValue, duplicates } from "./lib/docs.mjs";

const KINDS = ["positive", "negative"];
const DRIVERS = ["cli", "http", "browser", "library"];
const EVIDENCE_ROOT = "/tmp/cstack-e2e/";

function config(args, planPath) {
  if (!args.config) return loadConfig(path.dirname(planPath)).config;
  const text = readDoc(args.config, "config");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${args.config} does not parse: ${err.message}`);
  }
}

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["spec", "config"] });
  const planPath = onePath(args, "check-e2e.mjs <e2e-plan.md> --spec <spec.md> [--config <path>] [--json]");
  const plan = parseE2e(readDoc(planPath, "e2e plan"));
  const spec = parseSpec(readDoc(args.spec, "spec (--spec)"));
  const cfg = config(args, planPath);
  const g = new Gate("check-e2e", { json: args.json });

  const missing = ["Lanes", "Red check", "Mutation spot-check"].filter((s) => !plan.sections.has(s));
  g.check(!missing.length, "sections", "Lanes, Red check and Mutation spot-check present", `missing: ${missing.join(", ")}`);
  for (const p of plan.problems) g.fail("format", p);
  g.check(plan.lanes.length > 0, "lanes", `${plan.lanes.length} lanes`, "no lanes");
  const ids = plan.lanes.map((l) => l.id);
  const dup = duplicates(ids);
  g.check(!dup.length, "lanes-unique", "lane ids unique", `repeated: ${dup.join(", ")}`);

  const eById = new Map(spec.e2e.map((e) => [e.id, e]));
  for (const l of plan.lanes) {
    const f = l.fields;
    const bad = [];
    if (!KINDS.includes(l.kind)) bad.push(`Kind must be ${KINDS.join("|")}`);
    if (!l.covers.length) bad.push("Covers is empty");
    if (!DRIVERS.includes(f.Driver?.value)) bad.push(`Driver must be ${DRIVERS.join("|")}`);
    if (!(f.Script?.items ?? []).some((s) => /^\d+\.\s+\S/.test(s))) bad.push("Script needs numbered steps");
    const ev = f.Evidence?.value ?? "";
    if (!ev.startsWith(EVIDENCE_ROOT) || ev.split("/").includes("..")) bad.push(`Evidence must be a path under ${EVIDENCE_ROOT}`);
    if (!hasExactValue(f["Pass when"]?.value ?? "")) bad.push("Pass when needs a predicate with a number or `exact value`");
    g.check(!bad.length, `lane ${l.id}`, "fields complete", bad.join("; "));

    const e = eById.get(l.e);
    const outside = l.covers.filter((r) => !(e?.covers ?? []).includes(r));
    g.check(
      e && !outside.length,
      `lane ${l.id} matches`,
      `covers a subset of ${l.e}`,
      e ? `${l.e} does not cover ${outside.join(", ")}` : `${l.e} is not in the spec`,
    );
  }

  const laned = new Set(plan.lanes.map((l) => l.e));
  const noLane = spec.e2e.map((e) => e.id).filter((id) => !laned.has(id));
  g.check(!noLane.length, "e-coverage", "every E has a lane", `no lane for ${noLane.join(", ")}`);
  const negative = new Set(plan.lanes.filter((l) => l.kind === "negative").flatMap((l) => l.covers));
  const noNeg = spec.requirements.map((r) => r.id).filter((id) => !negative.has(id));
  g.check(!noNeg.length, "negative-coverage", "every R has a negative lane", `no negative lane for ${noNeg.join(", ")}`);

  // Red check: every lane ran on the base and failed for the right reason.
  if (plan.red.problem) g.fail("red-check", plan.red.problem);
  for (const r of plan.red.rows) {
    const verdict = {
      FAIL: r.reason ? null : "FAIL without a reason",
      PASS: "already passing: the requirement is met or the test is wrong",
      ERROR: "broken test: it errored instead of failing on missing behaviour",
    };
    const problem = ids.includes(r.lane) ? (Object.hasOwn(verdict, r.result) ? verdict[r.result] : `result must be FAIL, PASS or ERROR, got "${r.result}"`) : "not a lane in this plan";
    g.check(!problem, `red-check ${r.lane}`, "fails on base", problem);
  }
  const unrun = ids.filter((id) => !plan.red.rows.some((r) => r.lane === id));
  g.check(!unrun.length, "red-check-complete", "every lane in the red-check table", `missing: ${unrun.join(", ")}`);

  // Mutation spot-check: enough distinct lanes, each caught a deliberate break.
  if (plan.mutation.problem) g.fail("mutation", plan.mutation.problem);
  const need = Math.max(2, Math.ceil(ids.length * 0.2));
  const spot = new Set(plan.mutation.rows.map((r) => r.lane).filter((id) => ids.includes(id)));
  g.check(spot.size >= need, "mutation-count", `${spot.size} lanes spot-checked`, `${spot.size} distinct plan lanes spot-checked, need ${need}`);
  for (const r of plan.mutation.rows) {
    const problem = !ids.includes(r.lane) ? "not a lane in this plan" : !r.break ? "Break is empty" : r.caught.toLowerCase() !== "yes" ? "the lane did not catch the break" : null;
    g.check(!problem, `mutation ${r.lane}`, "caught", problem);
  }

  const cmd = cfg.e2e_command;
  g.check(
    (typeof cmd === "string" || Array.isArray(cmd)) && cmd.length > 0,
    "e2e-command",
    "config e2e_command is set",
    "config e2e_command is null or empty",
  );
  return g.finish();
});
