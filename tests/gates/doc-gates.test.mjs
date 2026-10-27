// Tests for the document gates: check-spec, check-e2e, check-intake, check-plan.
// Fixtures are the templates with one targeted edit each, so every failing case breaks one rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tpl = (f) => readFileSync(path.join(ROOT, "templates", f), "utf8");
const SPEC = tpl("spec.md");
const E2E = tpl("e2e-plan.md");
const UNITS = tpl("units.tsv");
const PLAN = tpl("plan.md");
const INTAKE = JSON.parse(tpl("intake.json"));
const CONFIG = { e2e_command: ["node", "--test", "tests/acceptance/"] };

// Replace one exact substring; fail loudly if the fixture edit no longer applies.
function edit(text, from, to) {
  assert.ok(text.includes(from), `fixture edit target not found: ${from}`);
  return text.replace(from, to);
}

// Write a run directory: <dir>/.cstack/config.json and the documents.
function docs({ spec = SPEC, e2e = E2E, units = UNITS, plan = PLAN, config = CONFIG } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-docs-"));
  const files = { "spec.md": spec, "e2e-plan.md": e2e, "units.tsv": units, "plan.md": plan };
  if (config !== null) files[".cstack/config.json"] = typeof config === "string" ? config : JSON.stringify(config);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const p = (f) => path.join(dir, f);
  return { dir, spec: p("spec.md"), e2e: p("e2e-plan.md"), units: p("units.tsv"), plan: p("plan.md"), config: p(".cstack/config.json") };
}

function gate(name, args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "gates", name), ...args], { encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json, fails: (json?.findings ?? []).map((f) => f.check) };
}

const spec = (text, extra = []) => gate("check-spec.mjs", [docs({ spec: text }).spec, "--json", ...extra]);
const e2e = (opts = {}) => {
  const d = docs(opts);
  return gate("check-e2e.mjs", [d.e2e, "--spec", d.spec, "--json"]);
};
const plan = (opts = {}, { withPlan = true } = {}) => {
  const d = docs(opts);
  return gate("check-plan.mjs", ["--units", d.units, "--spec", d.spec, "--e2e", d.e2e, ...(withPlan ? ["--plan", d.plan] : []), "--json"]);
};

function rejects(res, ...checks) {
  assert.equal(res.code, 1, res.out + res.err);
  assert.equal(res.json.approved, false);
  for (const c of checks) assert.ok(res.fails.includes(c), `expected finding ${c}, got ${res.fails.join(", ")}`);
}
function approves(res) {
  assert.equal(res.code, 0, res.out + res.err);
}
function usage(res, re) {
  assert.equal(res.code, 2, res.out + res.err);
  assert.match(res.err, re);
}

// A git repo with the files the intake template targets.
function repo(files = ["src/store.mjs", "bin/notes.mjs"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-intake-"));
  spawnSync("git", ["init", "-q", dir]);
  for (const f of files) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), "x\n");
  }
  spawnSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}
const REPO = repo();
function intake(change = (d) => d, { raw, repoDir = REPO } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-intake-doc-"));
  const file = path.join(dir, "intake.json");
  writeFileSync(file, raw ?? JSON.stringify(change(structuredClone(INTAKE))));
  return gate("check-intake.mjs", [file, "--repo", repoDir, "--json"]);
}

// ---------- templates together ----------

test("the templates pass all four gates together", () => {
  const d = docs();
  const s = gate("check-spec.mjs", [d.spec]);
  assert.equal(s.code, 0, s.out);
  assert.match(s.out, /^PASS sections: /m);
  assert.match(s.out, /gate check-spec: approved\n$/);
  approves(gate("check-e2e.mjs", [d.e2e, "--spec", d.spec, "--json"]));
  approves(gate("check-plan.mjs", ["--units", d.units, "--spec", d.spec, "--e2e", d.e2e, "--plan", d.plan, "--json"]));
  approves(intake());
});

// ---------- check-spec ----------

test("spec: text output lists findings and the rejected line", () => {
  const r = gate("check-spec.mjs", [docs({ spec: edit(SPEC, "Sync between", "TODO sync between") }).spec]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL no-placeholders: TBD\/TODO left at line \d+$/m);
  assert.match(r.out, /gate check-spec: rejected \(1 findings\)\n$/);
});

test("spec: usage errors exit 2", () => {
  usage(gate("check-spec.mjs", []), /usage: check-spec/);
  usage(gate("check-spec.mjs", ["/nonexistent/spec.md"]), /spec not found/);
  usage(gate("check-spec.mjs", ["a.md", "--bogus"]), /unknown option --bogus/);
});

test("spec: every section must be present and non-empty", () => {
  rejects(spec(edit(SPEC, "## Constraints", "## Limits")), "sections");
  rejects(spec(edit(SPEC, "- A developer who works in a terminal all day.", "")), "sections");
  rejects(spec(edit(SPEC, "## Requirements", "## Needs")), "sections", "requirements", "covers-exist");
  rejects(spec(edit(SPEC, "## Done predicate", "## Done")), "sections", "done-predicate");
});

test("spec: requirement and e2e lines must match the format", () => {
  rejects(spec(edit(SPEC, "- R3: `notes rm", "- R3 `notes rm")), "format");
  rejects(spec(edit(SPEC, "  Covers: R1, R2", "  Covers: R1, R2\n  Covers: R3")), "format");
  rejects(spec(edit(SPEC, "## E2E requirements\n", "## E2E requirements\n\n  Covers: R1\n")), "format");
  const noCovers = spec(edit(SPEC, "  Covers: R2, R3\n", ""));
  rejects(noCovers, "format", "coverage");
  assert.ok(noCovers.json.findings.some((f) => /E2 has no Covers line/.test(f.detail)));
});

test("spec: ids are unique, contiguous from 1 and present", () => {
  rejects(spec(edit(SPEC, "- R3:", "- R2:")), "requirements-unique");
  rejects(spec(edit(SPEC, "- R3:", "- R4:")), "requirements-contiguous");
  rejects(spec(edit(SPEC, "- E2:", "- E3:")), "e2e-requirements-contiguous");
  rejects(spec(edit(SPEC, "- E2:", "- E1:")), "e2e-requirements-unique");
  const noR = SPEC.replace(/^- R\d: .*\n/gm, "");
  rejects(spec(noR), "requirements", "sections");
});

test("spec: every R is covered and every Covers id exists", () => {
  rejects(spec(edit(SPEC, "Covers: R2, R3", "Covers: R2")), "coverage");
  rejects(spec(edit(SPEC, "Covers: R2, R3", "Covers: R2, R3, R9")), "covers-exist");
});

test("spec: the done predicate is measurable", () => {
  const body = "Done when all 5 lanes in e2e-plan.md pass at the base branch head through `e2e_command`, and `npm test` exits 0.";
  rejects(spec(edit(SPEC, body, "Done when the feature works well.")), "done-predicate");
  rejects(spec(edit(SPEC, body, "All 5 lanes are green.")), "done-predicate");
  approves(spec(edit(SPEC, body, "The suite passes with exit code 0.")));
});

test("spec: no TBD or TODO outside comments", () => {
  rejects(spec(edit(SPEC, "- Node 22", "- TBD Node 22")), "no-placeholders");
  approves(spec(edit(SPEC, "## Problem", "<!-- TBD: polish -->\n## Problem")));
});

// ---------- check-e2e ----------

test("e2e: usage and config errors exit 2", () => {
  const d = docs();
  usage(gate("check-e2e.mjs", ["--spec", d.spec]), /usage: check-e2e/);
  usage(gate("check-e2e.mjs", [d.e2e]), /missing spec \(--spec\) path/);
  usage(gate("check-e2e.mjs", [d.e2e, "--spec", d.spec, "--config", path.join(d.dir, "nope.json")]), /config not found/);
  const bad = path.join(d.dir, "bad.json");
  writeFileSync(bad, "{");
  usage(gate("check-e2e.mjs", [d.e2e, "--spec", d.spec, "--config", bad]), /bad\.json does not parse/);
  const lone = docs({ config: null });
  usage(gate("check-e2e.mjs", [lone.e2e, "--spec", lone.spec]), /no \.cstack\/config\.json/);
});

test("e2e: config e2e_command must be set; --config overrides the found config", () => {
  rejects(e2e({ config: { e2e_command: null } }), "e2e-command");
  rejects(e2e({ config: { e2e_command: [] } }), "e2e-command");
  approves(e2e({ config: { e2e_command: "npm run e2e" } }));
  const d = docs({ config: { e2e_command: null } });
  const good = path.join(d.dir, "good.json");
  writeFileSync(good, JSON.stringify(CONFIG));
  approves(gate("check-e2e.mjs", [d.e2e, "--spec", d.spec, "--config", good, "--json"]));
});

test("e2e: required sections and lane headings", () => {
  const r = e2e({ e2e: edit(E2E, "## Mutation spot-check", "## Mutations") });
  rejects(r, "sections", "mutation", "mutation-count");
  rejects(e2e({ e2e: edit(E2E, "### E1.3 List with no notes", "### List with no notes") }), "format");
  rejects(e2e({ e2e: edit(E2E, "### E1.3 List", "### E1.2 List") }), "lanes-unique");
  const noLanes = E2E.replace(/## Lanes[\s\S]*?## Red check/, "## Lanes\n\n## Red check");
  rejects(e2e({ e2e: noLanes }), "lanes", "e-coverage");
  // A lane-like heading outside "## Lanes" is not a lane.
  approves(e2e({ e2e: edit(E2E, "## Lanes", "### E9.9 stray note\n\n## Lanes") }));
});

test("e2e: each lane has complete, valid fields", () => {
  const lane = (from, to) => e2e({ e2e: edit(E2E, from, to) });
  rejects(lane("Kind: negative\nCovers: R2\n", "Kind: sideways\nCovers: R2\n"), "lane E1.3");
  rejects(lane("Covers: R3\nDriver: cli\nScript:\n1. Run `notes rm 7`", "Covers:\nDriver: cli\nScript:\n1. Run `notes rm 7`"), "lane E2.2");
  rejects(lane("Covers: R1\nDriver: cli", "Covers: R1\nDriver: desktop"), "lane E1.2");
  rejects(lane('Script:\n1. Run `notes add ""`.', 'Script:\nRun `notes add ""`.'), "lane E1.2");
  rejects(lane("Evidence: /tmp/cstack-e2e/<run>/E1.2.log", "Evidence: /tmp/other/E1.2.log"), "lane E1.2");
  rejects(lane("Evidence: /tmp/cstack-e2e/<run>/E1.2.log", "Evidence: /tmp/cstack-e2e/../etc/E1.2.log"), "lane E1.2");
  rejects(lane("Pass when: the command exits 2 and stderr is `note text is empty`.", "Pass when: it fails nicely."), "lane E1.2");
  const bare = E2E.replace(/(### E1\.2 Add an empty note\n)[\s\S]*?(### E1\.3)/, "$1\n$2");
  const r = e2e({ e2e: bare });
  rejects(r, "lane E1.2");
  assert.match(r.json.findings.find((f) => f.check === "lane E1.2").detail, /Kind must be.*Covers is empty.*Driver must be.*Script needs.*Evidence must.*Pass when/);
});

test("e2e: lane ids match an E in the spec and stay inside its Covers", () => {
  const r = e2e({ e2e: edit(E2E, "### E2.2 Remove", "### E3.1 Remove").replace("| E2.2 | FAIL", "| E3.1 | FAIL").replace("| E2.2 | `rm`", "| E3.1 | `rm`") });
  rejects(r, "lane E3.1 matches");
  assert.match(r.json.findings.find((f) => f.check === "lane E3.1 matches").detail, /E3 is not in the spec/);
  const out = e2e({ e2e: edit(E2E, "Kind: negative\nCovers: R1\n", "Kind: negative\nCovers: R1, R3\n") });
  rejects(out, "lane E1.2 matches");
  assert.match(out.json.findings.find((f) => f.check === "lane E1.2 matches").detail, /E1 does not cover R3/);
});

test("e2e: every E has a lane and every R has a negative lane", () => {
  const spec2 = edit(SPEC, "## Constraints", "- E3: A user exports notes.\n  Covers: R1\n\n## Constraints");
  rejects(e2e({ spec: spec2 }), "e-coverage");
  rejects(e2e({ e2e: edit(E2E, "Kind: negative\nCovers: R2\n", "Kind: positive\nCovers: R2\n") }), "negative-coverage");
});

test("e2e: the red check records a FAIL with a reason for every lane", () => {
  const red = (from, to) => e2e({ e2e: edit(E2E, from, to) });
  const pass = red("| E1.1 | FAIL | `notes: command not found` |", "| E1.1 | PASS | ok |");
  rejects(pass, "red-check E1.1");
  assert.match(pass.json.findings.find((f) => f.check === "red-check E1.1").detail, /already passing/);
  const err = red("| E1.2 | FAIL | `notes: command not found` |", "| E1.2 | ERROR | fixture missing |");
  assert.match(err.json.findings.find((f) => f.check === "red-check E1.2").detail, /broken test/);
  rejects(red("| E1.3 | FAIL | `notes: command not found` |", "| E1.3 | FAIL | |"), "red-check E1.3");
  rejects(red("| E1.3 | FAIL | `notes: command not found` |", "| E1.3 | FAIL |"), "red-check E1.3");
  rejects(red("| E2.1 | FAIL |", "| E2.1 | SKIP |"), "red-check E2.1");
  rejects(red("| E2.2 | FAIL | `notes: command not found` |\n", "| E2.2 | FAIL | x |\n| E7.7 | FAIL | x |\n"), "red-check E7.7");
  rejects(red("| E2.2 | FAIL | `notes: command not found` |\n", ""), "red-check-complete");
  rejects(red("| Lane | Result | Reason |", "| Lane | Outcome | Reason |"), "red-check", "red-check-complete");
  rejects(red("## Red check", "## Red run"), "sections", "red-check", "red-check-complete");
});

test("e2e: the mutation spot-check covers enough lanes and catches every break", () => {
  const mut = (from, to) => e2e({ e2e: edit(E2E, from, to) });
  rejects(mut("| E2.2 | `rm` of an unknown id exits 0 | yes |\n", ""), "mutation-count");
  rejects(mut("| E2.2 | `rm` of an unknown id exits 0 | yes |", "| E1.1 | `rm` exits 0 | yes |"), "mutation-count");
  rejects(mut("exits 0 | yes |", "exits 0 | no |"), "mutation E2.2");
  rejects(mut("| E2.2 | `rm` of an unknown id exits 0 | yes |", "| E2.2 |  | yes |"), "mutation E2.2");
  rejects(mut("| E2.2 | `rm` of an unknown id exits 0 | yes |", "| E2.2 | x | yes |\n| E8.1 | x | yes |"), "mutation E8.1");
  // 11 lanes need ceil(20%) = 3 spot-checked lanes.
  let big = E2E;
  for (let m = 4; m <= 9; m++) {
    big = edit(big, "## Red check", `### E1.${m} Extra\n\nKind: positive\nCovers: R1\nDriver: cli\nScript:\n1. Run it.\nEvidence: /tmp/cstack-e2e/r/E1.${m}.log\nPass when: exits 0.\n\n## Red check`);
    big = edit(big, "\n## Mutation", `| E1.${m} | FAIL | missing |\n\n## Mutation`);
  }
  rejects(e2e({ e2e: big }), "mutation-count");
  approves(e2e({ e2e: big.trimEnd() + "\n| E1.4 | add drops text | YES |\n" }));
});

// ---------- check-intake ----------

test("intake: usage errors exit 2", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-intake-u-"));
  const file = path.join(dir, "intake.json");
  writeFileSync(file, JSON.stringify(INTAKE));
  usage(gate("check-intake.mjs", ["--repo", REPO]), /usage: check-intake/);
  usage(gate("check-intake.mjs", [path.join(dir, "none.json"), "--repo", REPO]), /intake not found/);
  usage(gate("check-intake.mjs", [file]), /--repo <dir> is required/);
  usage(gate("check-intake.mjs", [file, "--repo", dir]), /git ls-files failed/);
});

test("intake: the JSON must parse and have the right shape", () => {
  rejects(intake(undefined, { raw: "{ nope" }), "json");
  rejects(intake(undefined, { raw: "[]" }), "shape");
  rejects(intake((d) => ({ ...d, issue: 0 })), "shape");
  rejects(intake((d) => ({ ...d, issue: "42" })), "shape");
  rejects(intake((d) => ({ ...d, classification: "epic" })), "shape");
  rejects(intake((d) => ({ ...d, summary: " " })), "shape");
  rejects(intake((d) => ({ ...d, question: 3 })), "shape");
  rejects(intake((d) => ({ ...d, requirements: {} })), "shape");
  rejects(intake((d) => ({ ...d, tickets: ["T1"] })), "shape");
  const r = intake((d) => {
    delete d.tickets[0].target_files;
    d.requirements[1].text = "";
    return d;
  });
  rejects(r, "shape");
  assert.match(r.json.findings[0].detail, /requirements\[1\]: bad or missing text; tickets\[0\]: bad or missing target_files/);
});

test("intake: requirement ids are unique", () => {
  rejects(
    intake((d) => {
      d.requirements[1].id = "R1";
      return d;
    }),
    "requirements-unique",
  );
});

test("intake: question, needs_human and reject carry no tickets; questions need a question", () => {
  const nonWork = (classification, extra = {}) => intake((d) => ({ ...d, classification, requirements: [], tickets: [], ...extra }));
  approves(nonWork("question", { question: "Should --json include timestamps?" }));
  approves(nonWork("needs_human", { question: "Which store format wins?" }));
  approves(nonWork("reject", { summary: "Duplicate of #41." }));
  rejects(nonWork("question"), "question");
  rejects(nonWork("needs_human", { question: "  " }), "question");
  rejects(intake((d) => ({ ...d, classification: "reject" })), "no-tickets");
});

test("intake: workable decisions need requirements and 1-4 unique tickets", () => {
  rejects(intake((d) => ({ ...d, requirements: [] })), "requirements", "coverage");
  rejects(intake((d) => ({ ...d, classification: "bug", tickets: [] })), "ticket-count");
  const five = intake((d) => {
    for (let i = 3; i <= 5; i++) d.tickets.push({ id: `T${i}`, title: "more", requirements: [], depends_on: [], target_files: ["src/store.mjs"] });
    return d;
  });
  rejects(five, "ticket-count");
  rejects(
    intake((d) => {
      d.tickets[1].id = "T1";
      d.tickets[1].depends_on = [];
      return d;
    }),
    "tickets-unique",
  );
});

test("intake: every requirement is covered by exactly one ticket", () => {
  const twice = intake((d) => {
    d.tickets[1].requirements = ["R1", "R2"];
    return d;
  });
  rejects(twice, "coverage");
  assert.match(twice.json.findings[0].detail, /R1 covered 2 times/);
  const none = intake((d) => {
    d.tickets[1].requirements = ["R9"];
    return d;
  });
  assert.match(none.json.findings[0].detail, /R2 covered 0 times; R9 is not a requirement/);
});

test("intake: dependencies exist and have no cycles", () => {
  rejects(
    intake((d) => {
      d.tickets[1].depends_on = ["T7"];
      return d;
    }),
    "depends T2",
  );
  rejects(
    intake((d) => {
      d.tickets[0].depends_on = ["T1"];
      return d;
    }),
    "depends T1",
  );
  const cyc = intake((d) => {
    d.tickets[0].depends_on = ["T2"];
    return d;
  });
  rejects(cyc, "acyclic");
  assert.match(cyc.json.findings.find((f) => f.check === "acyclic").detail, /T1 -> T2 -> T1/);
});

test("intake: target files are tracked, or marked new: and absent", () => {
  rejects(
    intake((d) => {
      d.tickets[1].target_files = ["bin/missing.mjs"];
      return d;
    }),
    "files T2",
  );
  const fresh = intake((d) => {
    d.tickets[1].target_files = ["new:bin/notes.mjs"];
    return d;
  });
  rejects(fresh, "files T2");
  assert.match(fresh.json.findings[0].detail, /already exists/);
  const empty = intake((d) => {
    d.tickets[1].target_files = [];
    return d;
  });
  assert.match(empty.json.findings[0].detail, /target_files is empty/);
});

// ---------- check-plan ----------

test("plan: usage errors exit 2", () => {
  const d = docs();
  usage(gate("check-plan.mjs", [d.units, "--spec", d.spec, "--e2e", d.e2e]), /usage: check-plan/);
  usage(gate("check-plan.mjs", ["--spec", d.spec, "--e2e", d.e2e]), /missing units \(--units\) path/);
  usage(gate("check-plan.mjs", ["--units", d.units, "--spec", d.spec, "--e2e", d.e2e, "--plan", path.join(d.dir, "x.md")]), /plan \(--plan\) not found/);
});

test("plan: plan.md is optional", () => {
  approves(plan({ plan: "# nothing\n" }, { withPlan: false }));
});

test("plan: units.tsv has the fixed header and column count", () => {
  rejects(plan({ units: edit(UNITS, "depends_on\tlanes", "deps\tlanes") }), "format");
  rejects(plan({ units: edit(UNITS, "\tunits/U2.md", "\tunits/U2.md\textra") }), "format");
  rejects(plan({ units: "" }), "format", "units");
});

test("plan: the E2E row of PR #0 is skipped", () => {
  approves(plan({ units: UNITS + "E2E\te2e\tmerged\tcstack/1-e2e\t2\tabc\t1\t\t\t\n" }));
});

test("plan: unit ids match U<n> and are unique", () => {
  rejects(plan({ units: edit(UNITS, "U2\tcore", "Unit2\tcore") }), "unit-ids");
  rejects(plan({ units: edit(UNITS, "U2\tcore", "U1\tcore") }), "units-unique");
});

test("plan: dependencies exist and have no cycles", () => {
  rejects(plan({ units: edit(UNITS, "\tU1\t", "\tU9\t") }), "depends U2");
  rejects(plan({ units: edit(UNITS, "\tU1\t", "\tU2\t") }), "depends U2");
  const cyc = plan({ units: edit(UNITS, "planned\t\t\t\t\t\tE1.1", "planned\t\t\t\t\tU2\tE1.1") });
  rejects(cyc, "acyclic");
  assert.match(cyc.json.findings.find((f) => f.check === "acyclic").detail, /U1 -> U2 -> U1/);
  // A unit listed before its dependency, and a diamond, are both fine.
  const row = (id, deps, lanes) => `${id}\tcore\tplanned\t\t\t\t\t${deps}\t${lanes}\tunits/${id}.md\n`;
  const head = UNITS.split("\n")[0] + "\n";
  approves(plan({ units: head + row("U1", "U3", "E1.1,E1.2,E1.3") + row("U2", "U1", "E2.1,E2.2") + row("U3", "", "E1.1") }, { withPlan: false }));
  approves(plan({ units: head + row("U1", "", "E1.1,E1.2,E1.3") + row("U2", "U1", "E2.1,E2.2") + row("U3", "U1,U2", "E1.1") }, { withPlan: false }));
});

test("plan: every unit has known lanes and every lane has a unit", () => {
  rejects(plan({ units: edit(UNITS, "\tE2.1,E2.2\t", "\t\t") }), "lanes U2", "lane-assignment", "requirement-coverage");
  rejects(plan({ units: edit(UNITS, "\tE2.1,E2.2\t", "\tE2.1,E2.2,E5.1\t") }), "lanes U2");
});

test("plan: every requirement is covered through a unit's lanes", () => {
  const spec2 = edit(SPEC, "- R3:", "- R4: `notes edit` works.\n- R3:");
  rejects(plan({ spec: spec2 }), "requirement-coverage");
});

test("plan: plan.md has a complete section for every unit and no others", () => {
  rejects(plan({ plan: edit(PLAN, "## U2 Remove notes", "## Removal") }), "plan U2");
  rejects(plan({ plan: edit(PLAN, "Files: src/store.mjs, bin/notes.mjs, test/rm.test.mjs", "Files:") }), "plan U2");
  rejects(plan({ plan: edit(PLAN, "Verify:\n1. `npm test`\n2. Lanes E2.1 and E2.2 through `run-e2e.mjs`.\n", "Verify:\n") }), "plan U2");
  rejects(plan({ plan: edit(PLAN, "Size: S\n", "Size: XL\n") }), "plan U2");
  rejects(plan({ plan: PLAN + "\n## U3 Extra\n\nFiles: a\nVerify: b\nSize: S\n" }), "plan-units");
});
