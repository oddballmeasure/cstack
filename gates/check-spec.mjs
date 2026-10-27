#!/usr/bin/env node
// Gate: spec.md follows templates/spec.md.
// Usage: node gates/check-spec.mjs <spec.md> [--json]
import { Gate, main, parseArgs } from "./lib/common.mjs";
import { readDoc, onePath, parseSpec, SPEC_SECTIONS, nonBlank, duplicates, gapProblem, hasExactValue, stripComments } from "./lib/docs.mjs";

main((argv) => {
  const args = parseArgs(argv, { flags: ["json"] });
  const text = readDoc(onePath(args, "check-spec.mjs <spec.md> [--json]"), "spec");
  const g = new Gate("check-spec", { json: args.json });
  const spec = parseSpec(text);

  const empty = SPEC_SECTIONS.filter((s) => !nonBlank(spec.sections.get(s)?.body ?? []).length);
  g.check(!empty.length, "sections", `all ${SPEC_SECTIONS.length} sections present`, `missing or empty: ${empty.join(", ")}`);
  for (const p of spec.problems) g.fail("format", p);

  const rIds = spec.requirements.map((r) => r.id);
  const eIds = spec.e2e.map((e) => e.id);
  for (const [prefix, ids, name] of [
    ["R", rIds, "requirements"],
    ["E", eIds, "e2e-requirements"],
  ]) {
    const dup = duplicates(ids);
    const gap = gapProblem(ids, prefix);
    g.check(ids.length > 0, name, `${ids.length} found`, `no ${prefix}<n> items`);
    g.check(!dup.length, `${name}-unique`, "ids unique", `repeated: ${dup.join(", ")}`);
    g.check(!gap, `${name}-contiguous`, `${prefix}1..${prefix}${ids.length}`, gap);
  }

  const covered = new Set(spec.e2e.flatMap((e) => e.covers ?? []));
  const uncovered = rIds.filter((r) => !covered.has(r));
  g.check(!uncovered.length, "coverage", "every R covered by an E", `not covered by any E: ${uncovered.join(", ")}`);
  const unknown = spec.e2e.flatMap((e) => (e.covers ?? []).filter((r) => !rIds.includes(r)).map((r) => `${e.id} covers ${r}`));
  g.check(!unknown.length, "covers-exist", "every Covers id is a requirement", `unknown requirement: ${unknown.join("; ")}`);

  const done = nonBlank(spec.sections.get("Done predicate")?.body ?? [])
    .map((l) => l.text)
    .join(" ");
  g.check(
    hasExactValue(done) && /\b(pass|passes|when)\b/i.test(done),
    "done-predicate",
    "names an exact value and a pass condition",
    'must contain a number or `exact value` and the word "pass" or "when"',
  );

  const open = stripComments(text)
    .split("\n")
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /\b(TBD|TODO)\b/.test(l))
    .map(([, n]) => `line ${n}`);
  g.check(!open.length, "no-placeholders", "no TBD or TODO", `TBD/TODO left at ${open.join(", ")}`);
  return g.finish();
});
