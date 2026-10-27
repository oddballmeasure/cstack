#!/usr/bin/env node
// Gate: units.tsv (and plan.md when given) cover spec.md through the lanes of e2e-plan.md.
// A unit covers requirement R when one of its lanes lists R in Covers. plan.md has no
// Requirements line: the e2e plan is the one place requirements meet lanes.
// Usage: node gates/check-plan.mjs --units <units.tsv> --spec <spec.md> --e2e <e2e-plan.md> [--plan <plan.md>] [--json]
import { Gate, main, parseArgs, UsageError } from "./lib/common.mjs";
import { readDoc, parseSpec, parseE2e, parseUnits, parsePlan, duplicates, findCycle, filled } from "./lib/docs.mjs";

const SIZES = ["S", "M", "L"];

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"], options: ["units", "spec", "e2e", "plan"] });
  if (args._.length) throw new UsageError("usage: check-plan.mjs --units <units.tsv> --spec <spec.md> --e2e <e2e-plan.md> [--plan <plan.md>] [--json]");
  const { units, problems } = parseUnits(readDoc(args.units, "units (--units)"));
  const spec = parseSpec(readDoc(args.spec, "spec (--spec)"));
  const e2e = parseE2e(readDoc(args.e2e, "e2e plan (--e2e)"));
  const plan = args.plan ? parsePlan(readDoc(args.plan, "plan (--plan)")) : null;
  const g = new Gate("check-plan", { json: args.json });

  for (const p of problems) g.fail("format", p);
  g.check(units.length > 0, "units", `${units.length} units`, "no unit rows");
  const ids = units.map((u) => u.id);
  const badIds = ids.filter((id) => !/^U\d+$/.test(id));
  g.check(!badIds.length, "unit-ids", "ids match U<n>", `not U<n>: ${badIds.join(", ")}`);
  const dup = duplicates(ids);
  g.check(!dup.length, "units-unique", "unit ids unique", `repeated: ${dup.join(", ")}`);

  const lanes = new Map(e2e.lanes.map((l) => [l.id, l]));
  for (const u of units) {
    const deps = u.depends_on.filter((d) => d === u.id || !ids.includes(d));
    g.check(!deps.length, `depends ${u.id}`, "dependencies exist", `unknown or self dependency: ${deps.join(", ")}`);
    const unknown = u.lanes.filter((l) => !lanes.has(l));
    g.check(
      u.lanes.length > 0 && !unknown.length,
      `lanes ${u.id}`,
      `${u.lanes.length} lanes`,
      u.lanes.length ? `not in the e2e plan: ${unknown.join(", ")}` : "lists no e2e lane",
    );
  }
  const cycle = findCycle(new Map(units.map((u) => [u.id, u.depends_on])));
  g.check(!cycle, "acyclic", "no dependency cycles", `cycle: ${cycle?.join(" -> ")}`);

  const assigned = new Set(units.flatMap((u) => u.lanes));
  const orphan = [...lanes.keys()].filter((l) => !assigned.has(l));
  g.check(!orphan.length, "lane-assignment", "every e2e lane assigned to a unit", `unassigned lanes: ${orphan.join(", ")}`);
  const covered = new Set([...assigned].filter((l) => lanes.has(l)).flatMap((l) => lanes.get(l).covers));
  const uncovered = spec.requirements.map((r) => r.id).filter((r) => !covered.has(r));
  g.check(!uncovered.length, "requirement-coverage", "every R covered by a unit's lanes", `no unit covers ${uncovered.join(", ")}`);

  if (plan) {
    for (const u of units) {
      const s = plan.units.get(u.id);
      const f = s?.fields ?? {};
      const bad = [];
      if (!s) bad.push(`no "## ${u.id}" section`);
      if (!filled(f.Files)) bad.push("Files is empty");
      if (!filled(f.Verify)) bad.push("Verify is empty");
      if (!SIZES.includes(f.Size?.value)) bad.push(`Size must be ${SIZES.join("|")}`);
      g.check(!bad.length, `plan ${u.id}`, "Files, Verify and Size set", bad.join("; "));
    }
    const extra = [...plan.units.keys()].filter((id) => !ids.includes(id));
    g.check(!extra.length, "plan-units", "every plan section is a unit", `sections with no unit row: ${extra.join(", ")}`);
  }
  return g.finish();
});
