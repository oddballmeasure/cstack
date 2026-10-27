// Parsers for the documents cstack agents write: spec.md, e2e-plan.md, plan.md, units.tsv.
// Formats are defined by the files in templates/. Parsers never throw on bad content;
// they return what they could read plus a `problems` list the gate reports.
import { readFileSync, existsSync } from "node:fs";
import { UsageError } from "./common.mjs";

export function readDoc(file, what) {
  if (!file) throw new UsageError(`missing ${what} path`);
  if (!existsSync(file)) throw new UsageError(`${what} not found: ${file}`);
  return readFileSync(file, "utf8");
}

// Exactly one positional argument, the document path.
export function onePath(args, usage) {
  if (args._.length !== 1) throw new UsageError(`usage: ${usage}`);
  return args._[0];
}

// HTML comments hold template guidance. Blank them out but keep line numbers.
export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ""));
}

// Split a document into heading blocks. Each block holds its heading and the lines
// up to the next heading of any level. Lines carry 1-based line numbers.
export function blocks(text) {
  const out = [{ level: 0, title: "", line: 0, body: [] }];
  stripComments(text)
    .split("\n")
    .forEach((raw, i) => {
      const m = raw.match(/^(#{1,6})\s+(.*?)\s*$/);
      if (m) out.push({ level: m[1].length, title: m[2], line: i + 1, body: [] });
      else out.at(-1).body.push({ text: raw.trimEnd(), line: i + 1 });
    });
  return out;
}

// Level-2 sections by exact title. A level-3 block belongs to the level-2 block above it.
export function sections(text) {
  const map = new Map();
  let cur = { children: [] };
  for (const b of blocks(text)) {
    if (b.level === 2) {
      cur = { title: b.title, line: b.line, body: [...b.body], children: [] };
      map.set(b.title, cur);
    } else if (b.level > 2) cur.children.push(b);
  }
  return map;
}

export const nonBlank = (lines) => lines.filter((l) => l.text.trim() !== "");

export function idList(s) {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// A measurable predicate names a number or an exact `quoted` value.
export const hasExactValue = (s) => /\d/.test(s) || /`[^`]+`/.test(s);

// `Name: value` fields. Lines after a field that are not themselves fields are its items.
export function fields(lines, names) {
  const re = new RegExp(`^(${names.join("|")}):\\s*(.*)$`);
  const out = {};
  let cur = null;
  for (const l of nonBlank(lines)) {
    const m = l.text.trim().match(re);
    if (m) {
      cur = { value: m[2].trim(), items: [], line: l.line };
      out[m[1]] = cur;
    } else if (cur) cur.items.push(l.text.trim());
  }
  return out;
}

// Pipe table. Returns rows keyed by lower-cased header names, or a problem string.
export function table(lines, columns) {
  const rows = nonBlank(lines)
    .filter((l) => l.text.trim().startsWith("|"))
    .map((l) =>
      l.text
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );
  const want = columns.map((c) => c.toLowerCase());
  const head = (rows[0] || []).map((c) => c.toLowerCase());
  if (head.join("|") !== want.join("|")) return { rows: [], problem: `expected a table with header | ${columns.join(" | ")} |` };
  const body = rows.slice(1).filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
  return { rows: body.map((r) => Object.fromEntries(want.map((k, i) => [k, r[i] ?? ""]))), problem: null };
}

// Ids that appear more than once.
export function duplicates(ids) {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

// Problem text when ids (all `<prefix><n>`) do not run prefix1..prefixN, else null.
export function gapProblem(ids, prefix) {
  const nums = [...new Set(ids)].map((id) => Number(id.slice(prefix.length))).sort((a, b) => a - b);
  if (nums.every((n, i) => n === i + 1)) return null;
  return `${prefix} ids must run ${prefix}1..${prefix}${nums.length} with no gaps; found ${nums.map((n) => prefix + n).join(", ")}`;
}

// First dependency cycle in graph (Map id -> [dep ids]) as an id path, or null.
// Unknown deps are ignored; report those separately.
export function findCycle(graph) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of graph.get(id).filter((x) => graph.has(x))) {
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) {
        const c = visit(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of graph.keys()) {
    if (!state.has(id)) {
      const c = visit(id);
      if (c) return c;
    }
  }
  return null;
}

export const SPEC_SECTIONS = ["Problem", "Users", "Goals", "Non-goals", "Requirements", "E2E requirements", "Constraints", "Done predicate"];

// spec.md: fixed level-2 sections. Requirements are `- R<n>: text`.
// E2E requirements are `- E<n>: text` followed by an indented `Covers: R1, R3` line.
export function parseSpec(text) {
  const secs = sections(text);
  const problems = [];
  const requirements = [];
  const e2e = [];
  const body = (name) => nonBlank(secs.get(name)?.body ?? []);
  for (const l of body("Requirements")) {
    const m = l.text.match(/^- (R\d+): (\S.*)$/);
    if (m) requirements.push({ id: m[1], text: m[2] });
    else problems.push(`line ${l.line}: expected "- R<n>: <text>" in Requirements, got "${l.text.trim()}"`);
  }
  for (const l of body("E2E requirements")) {
    const m = l.text.match(/^- (E\d+): (\S.*)$/);
    const c = l.text.match(/^\s+Covers:\s*(.*)$/);
    if (m) e2e.push({ id: m[1], text: m[2], covers: null, line: l.line });
    else if (c && e2e.length && e2e.at(-1).covers === null) e2e.at(-1).covers = idList(c[1]);
    else problems.push(`line ${l.line}: expected "- E<n>: <text>" then an indented "Covers: R.." line, got "${l.text.trim()}"`);
  }
  for (const e of e2e) if (e.covers === null) problems.push(`line ${e.line}: ${e.id} has no Covers line`);
  return { sections: secs, requirements, e2e, problems };
}

export const LANE_FIELDS = ["Kind", "Covers", "Driver", "Script", "Evidence", "Pass when"];

// e2e-plan.md: `## Lanes` holds `### E<n>.<m> <title>` blocks with LANE_FIELDS.
// `## Red check` and `## Mutation spot-check` hold pipe tables.
export function parseE2e(text) {
  const secs = sections(text);
  const problems = [];
  const lanes = [];
  for (const b of secs.get("Lanes")?.children ?? []) {
    const m = b.title.match(/^(E\d+)\.(\d+)\s+\S/);
    if (!m) {
      problems.push(`line ${b.line}: lane heading must be "### E<n>.<m> <title>", got "${b.title}"`);
      continue;
    }
    const f = fields(b.body, LANE_FIELDS);
    lanes.push({
      id: `${m[1]}.${m[2]}`,
      e: m[1],
      line: b.line,
      fields: f,
      kind: f.Kind?.value,
      covers: idList(f.Covers?.value ?? ""),
    });
  }
  const red = table(secs.get("Red check")?.body ?? [], ["Lane", "Result", "Reason"]);
  const mutation = table(secs.get("Mutation spot-check")?.body ?? [], ["Lane", "Break", "Caught"]);
  return { sections: secs, lanes, red, mutation, problems };
}

export const UNIT_COLUMNS = ["id", "track", "state", "branch", "pr", "sha", "issue", "depends_on", "lanes", "brief"];

// units.tsv: tab-separated, header row UNIT_COLUMNS. depends_on and lanes are comma lists.
export function parseUnits(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const problems = [];
  const header = (lines[0] ?? "").split("\t");
  if (header.join("\t") !== UNIT_COLUMNS.join("\t")) problems.push(`header must be: ${UNIT_COLUMNS.join(" ")}`);
  const units = [];
  lines.slice(1).forEach((l, i) => {
    const cols = l.split("\t");
    if (cols.length !== UNIT_COLUMNS.length) {
      problems.push(`row ${i + 2}: ${cols.length} columns, expected ${UNIT_COLUMNS.length}`);
      return;
    }
    const u = Object.fromEntries(UNIT_COLUMNS.map((k, j) => [k, cols[j]]));
    units.push({ ...u, depends_on: idList(u.depends_on), lanes: idList(u.lanes) });
  });
  return { units, problems };
}

export const PLAN_FIELDS = ["Files", "Verify", "Size"];

// plan.md: one `## U<n> <title>` section per unit with Files, Verify and Size fields.
export function parsePlan(text) {
  const units = new Map();
  for (const [title, s] of sections(text)) {
    const m = title.match(/^(U\d+)\b/);
    if (m) units.set(m[1], { line: s.line, fields: fields(s.body, PLAN_FIELDS) });
  }
  return { units };
}

// A field is filled when it has an inline value or at least one item line.
export const filled = (f) => Boolean(f && (f.value || f.items.length));
