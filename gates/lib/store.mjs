// Plain-file run store for cstack: units, verification ledger, inbox, gates, frontier, standing orders.
// Adapted from pstack skills/poteto-mode/scripts/orch @ 519d36a (MIT, Lauren Tan).
//
// Layout of a store directory (one writer per file, readers aggregate at read time):
//   units.tsv       id track state branch pr sha issue depends_on lanes brief
//   ledger.tsv      unit pr sha verdict evidence verifier ts   (append-only; latest row per (unit, sha) wins)
//   inbox/          <ts>-<pid>-<rand>.tsv, one line: agent unit status report
//   gates.md        parked human decisions
//   frontier.json   PR base chain snapshot
//   preferences.md  numbered standing orders
//   status.md       derived; rendered by `status`
//   .orch.lock      pid of the process holding the write lock
// The API is synchronous: every caller is a short-lived CLI or gate process.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { UsageError, run } from "./common.mjs";

export { UsageError };

export const UNIT_COLUMNS = ["id", "track", "state", "branch", "pr", "sha", "issue", "depends_on", "lanes", "brief"];
export const LEDGER_COLUMNS = ["unit", "pr", "sha", "verdict", "evidence", "verifier", "ts"];
const UNIT_HEADER = UNIT_COLUMNS.join("\t");
const LEDGER_HEADER = LEDGER_COLUMNS.join("\t");
const LOCK_FILE = ".orch.lock";

export const UNIT_STATES = ["planned", "ready", "in-progress", "verifying", "pr-open", "merged", "done", "error", "needs-human"];
export const VERDICTS = ["approved", "rejected", "live-ui-verified", "unit-test-verified", "type-check-only", "verifier-blocked", "verifier-failed"];
// Verdicts that let the merge gate through.
export const PASSING_VERDICTS = ["approved", "live-ui-verified", "unit-test-verified"];
// A dependency is satisfied once its unit reaches one of these states.
const SATISFIED_STATES = ["merged", "done"];
// Units in these states are still moving; while any exists, `ready` never overrides dependencies.
const IN_FLIGHT_STATES = ["in-progress", "verifying", "pr-open"];

// Exit 2 like any usage error, but callers can tell "missing" apart.
export class NotFoundError extends UsageError {}

export function parseState(value) {
  if (!UNIT_STATES.includes(value)) throw new UsageError(`state must be one of: ${UNIT_STATES.join(", ")}`);
  return value;
}

export function parseVerdict(value) {
  if (!VERDICTS.includes(value)) throw new UsageError(`verdict must be one of: ${VERDICTS.join(", ")}`);
  return value;
}

export function isPassing(verdict) {
  return PASSING_VERDICTS.includes(verdict);
}

export function splitList(cell) {
  return cell === "" ? [] : cell.split(",");
}

// Natural id order, so u2 sorts before u10.
export function compareIds(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

function cleanCell(value) {
  const cleaned = String(value).replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

function requiredCell(value, label) {
  const cleaned = cleanCell(value ?? "");
  if (cleaned.trim() === "") throw new UsageError(`${label} must not be empty`);
  return cleaned;
}

function requiredLine(value, label) {
  const cleaned = String(value ?? "").replace(/[\n\r]/g, " ").trim();
  if (cleaned === "") throw new UsageError(`${label} must not be empty`);
  return cleaned;
}

export function positiveInteger(value, label) {
  const s = String(value);
  if (!/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s))) throw new UsageError(`${label} must be a positive integer`);
  return Number(s);
}

// Comma list of ids: trimmed, no empties, no duplicates. "" clears.
function idList(value, label) {
  if (String(value).trim() === "") return "";
  const parts = String(value).split(",").map((p) => p.trim());
  if (parts.some((p) => p === "")) throw new UsageError(`${label} must be a comma-separated list`);
  if (new Set(parts).size !== parts.length) throw new UsageError(`${label} must not contain duplicates`);
  return parts.map((p) => cleanCell(p)).join(",");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWrite(file, contents) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, contents, { flag: "wx" });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function writeIfMissing(file, contents) {
  if (!existsSync(file)) atomicWrite(file, contents);
}

function notInitialized(dir) {
  return new UsageError(`store is not initialized at ${dir}; run orch init`);
}

function requiredFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") throw notInitialized(path.dirname(file));
    throw err;
  }
}

export function holderIsDead(holder) {
  const pid = Number.parseInt(holder, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== holder) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

function readHolder(file) {
  try {
    return readFileSync(file, "utf8").trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// Take the pid lock. A dead holder is replaced. A live holder is waited on for up to waitMs, then
// stolen with force or reported. Returns the release function.
function acquireLock(dir, { force = false, waitMs = 10000, onStaleLock, onLockStolen } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const pid = String(process.pid);
  const create = () => {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, `${pid}\n`);
    } finally {
      closeSync(fd);
    }
  };
  const takeOver = () => {
    rmSync(file, { force: true });
    try {
      create();
    } catch (err) {
      if (err.code === "EEXIST") throw new UsageError(`store lock held by pid ${readHolder(file)}`);
      throw err;
    }
  };
  const deadline = Date.now() + waitMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      create();
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const holder = readHolder(file);
    if (holderIsDead(holder)) {
      onStaleLock?.(holder);
      takeOver();
      break;
    }
    if (Date.now() < deadline) {
      sleepMs(delay);
      continue;
    }
    if (force) {
      onLockStolen?.(holder);
      takeOver();
      break;
    }
    throw new UsageError(`store lock held by pid ${holder}`);
  }
  return () => {
    if (readHolder(file) === pid) rmSync(file, { force: true });
  };
}

function readTsv(file, header, width) {
  const lines = requiredFile(file).replace(/\r/g, "").split("\n");
  if (lines.shift() !== header) throw new UsageError(`${path.basename(file)} has an invalid header`);
  return lines
    .filter((l) => l.length > 0)
    .map((l) => {
      const cells = l.split("\t");
      if (cells.length !== width) throw new UsageError(`${path.basename(file)} has a malformed row`);
      return cells;
    });
}

function writeTsv(file, header, rows) {
  const body = rows.map((r) => r.map(cleanCell).join("\t")).join("\n");
  atomicWrite(file, `${header}\n${body}${body ? "\n" : ""}`);
}

const zip = (cols, cells) => Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
const cellsOf = (cols, row) => cols.map((c) => row[c]);
export const unitCells = (u) => cellsOf(UNIT_COLUMNS, u);
export const ledgerCells = (r) => cellsOf(LEDGER_COLUMNS, r);

function readUnits(dir) {
  return readTsv(path.join(dir, "units.tsv"), UNIT_HEADER, UNIT_COLUMNS.length).map((cells) => {
    const unit = zip(UNIT_COLUMNS, cells);
    if (!UNIT_STATES.includes(unit.state)) throw new UsageError(`units.tsv has invalid state ${unit.state}`);
    return unit;
  });
}

function saveUnits(dir, rows) {
  writeTsv(path.join(dir, "units.tsv"), UNIT_HEADER, rows.map(unitCells));
}

function readLedger(dir) {
  return readTsv(path.join(dir, "ledger.tsv"), LEDGER_HEADER, LEDGER_COLUMNS.length).map((cells) => {
    const row = zip(LEDGER_COLUMNS, cells);
    if (!VERDICTS.includes(row.verdict)) throw new UsageError(`ledger.tsv has invalid verdict ${row.verdict}`);
    return row;
  });
}

// Latest row per (unit, sha), in first-seen key order.
function latestLedger(rows) {
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.unit}\0${r.sha}`, r);
  return [...byKey.values()];
}

const INBOX_NAME = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-\d+-[\w-]+\.tsv$/;

function readPointers(dir) {
  const inbox = path.join(dir, "inbox");
  let names;
  try {
    names = readdirSync(inbox, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") throw notInitialized(dir);
    throw err;
  }
  const files = names
    .filter((e) => e.isFile() && e.name.endsWith(".tsv"))
    .map((e) => e.name)
    .sort();
  return files.map((name) => {
    const raw = readFileSync(path.join(inbox, name), "utf8").replace(/\r?\n$/, "");
    const cells = raw.split("\t");
    const m = INBOX_NAME.exec(name);
    if (!m || /[\r\n]/.test(raw) || cells.length !== 4) throw new UsageError(`inbox pointer ${name} is malformed`);
    const [agent, unit, status, report] = cells;
    return { ts: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, agent, unit, status, report, file: name };
  });
}

function renderGates(rows) {
  if (rows.length === 0) return "";
  const blocks = rows.map((g) => {
    const answer = g.kind === "resolved" ? `\n- Answer: ${g.answer}` : "";
    return `## ${g.id}\n\n- Status: ${g.kind}\n- Question: ${g.question}\n- Options: ${g.options}\n- Default: ${g.defaultAnswer}${answer}`;
  });
  return `# Gates\n\n${blocks.join("\n\n")}\n`;
}

function readGates(dir) {
  const raw = requiredFile(path.join(dir, "gates.md")).replace(/\r/g, "").trim();
  if (raw === "") return [];
  const prefix = "# Gates\n\n## ";
  if (!raw.startsWith(prefix)) throw new UsageError("gates.md has an invalid heading");
  const result = [];
  for (const block of raw.slice(prefix.length).split("\n\n## ")) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const id = lines.shift();
    const fields = new Map();
    for (const l of lines) {
      const m = /^- ([^:]+): (.*)$/.exec(l);
      if (!m) throw new UsageError(`gates.md has a malformed gate ${id}`);
      fields.set(m[1], m[2]);
    }
    const [status, question, options, defaultAnswer] = ["Status", "Question", "Options", "Default"].map((k) => fields.get(k));
    if (question === undefined || options === undefined || defaultAnswer === undefined) {
      throw new UsageError(`gates.md has a malformed gate ${id}`);
    }
    if (status === "open") result.push({ kind: "open", id, question, options, defaultAnswer });
    else if (status === "resolved" && fields.has("Answer")) {
      result.push({ kind: "resolved", id, question, options, defaultAnswer, answer: fields.get("Answer") });
    } else throw new UsageError(`gates.md has invalid status ${status ?? ""}`);
  }
  if (new Set(result.map((g) => g.id)).size !== result.length) throw new UsageError("gates.md has duplicate gate ids");
  return result;
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const FRONTIER_STATES = ["OPEN", "MERGED", "CLOSED"];

function parseFrontier(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageError("frontier.json is not valid JSON");
  }
  if (!isRecord(value)) throw new UsageError("frontier.json must contain an object");
  if (Object.keys(value).length === 0) return { generation: 0, prs: [], lowestUnmerged: null };
  if (
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Array.isArray(value.prs) ||
    !(value.lowestUnmerged === null || Number.isSafeInteger(value.lowestUnmerged))
  ) {
    throw new UsageError("frontier.json has an invalid shape");
  }
  for (const row of value.prs) {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.pr) ||
      row.pr < 1 ||
      typeof row.branches !== "string" ||
      row.branches === "" ||
      typeof row.sha !== "string" ||
      !FRONTIER_STATES.includes(row.state)
    ) {
      throw new UsageError("frontier.json has an invalid PR row");
    }
  }
  return {
    generation: value.generation,
    prs: value.prs.map(({ pr, branches, sha, state }) => ({ pr, branches, sha, state })),
    lowestUnmerged: value.lowestUnmerged,
  };
}

function readStanding(dir) {
  const raw = requiredFile(path.join(dir, "preferences.md")).replace(/\r/g, "");
  const result = [];
  for (const l of raw.split("\n").filter((x) => x.length > 0)) {
    const m = /^([1-9]\d*)\. (.+)$/.exec(l);
    if (!m || Number(m[1]) !== result.length + 1) throw new UsageError("preferences.md has malformed numbering");
    result.push({ number: Number(m[1]), line: m[2] });
  }
  return result;
}

export function countValues(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function countLine(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? "none" : entries.map(([k, n]) => `${k}=${n}`).join(", ");
}

function summarize(units, ledger, frontier, gates) {
  return {
    unitStates: countValues(units.map((u) => u.state)),
    ledgerVerdicts: countValues(latestLedger(ledger).map((r) => r.verdict)),
    frontierGeneration: frontier.generation,
    openGateIds: gates
      .filter((g) => g.kind === "open")
      .map((g) => g.id)
      .sort(),
  };
}

function countRecord(value) {
  if (!isRecord(value)) return null;
  for (const n of Object.values(value)) if (!Number.isSafeInteger(n) || n < 0) return null;
  return value;
}

function previousSummary(raw) {
  const m = /<!-- orch-summary (.+) -->/.exec(raw);
  if (!m) return null;
  let v;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!isRecord(v) || typeof v.frontierGeneration !== "number" || !Array.isArray(v.openGateIds)) return null;
  const unitStates = countRecord(v.unitStates);
  const ledgerVerdicts = countRecord(v.ledgerVerdicts);
  if (!unitStates || !ledgerVerdicts || !v.openGateIds.every((x) => typeof x === "string")) return null;
  return { unitStates, ledgerVerdicts, frontierGeneration: v.frontierGeneration, openGateIds: v.openGateIds };
}

function changed(before, after) {
  if (before === null) return "first render";
  const out = [];
  for (const [label, a, b] of [
    ["units", before.unitStates, after.unitStates],
    ["ledger", before.ledgerVerdicts, after.ledgerVerdicts],
  ]) {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const x = a[k] ?? 0;
      const y = b[k] ?? 0;
      if (x !== y) out.push(`${label} ${k} ${x}->${y}`);
    }
  }
  if (before.frontierGeneration !== after.frontierGeneration) {
    out.push(`frontier generation ${before.frontierGeneration}->${after.frontierGeneration}`);
  }
  if (before.openGateIds.join("\0") !== after.openGateIds.join("\0")) {
    out.push(`open gates ${before.openGateIds.length}->${after.openGateIds.length}`);
  }
  return out.length === 0 ? "no derived changes" : out.join("; ");
}

const md = (v) => v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");

function table(headers, rows) {
  if (rows.length === 0) return "(none)";
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(md).join(" | ")} |`)].join("\n");
}

function statusMarkdown(units, ledger, frontier, gates, summary) {
  return `# cstack run status

Generated: ${new Date().toISOString()}

## Units

States: ${countLine(summary.unitStates)}

${table(["ID", "Track", "State", "Branch", "PR", "SHA", "Issue", "Depends on", "Lanes", "Brief"], units.map(unitCells))}

## Verification ledger

Verdicts (latest per unit and SHA): ${countLine(summary.ledgerVerdicts)}

${table(["Unit", "PR", "SHA", "Verdict", "Evidence", "Verifier", "Timestamp"], ledger.map(ledgerCells))}

## Frontier

Generation: ${frontier.generation}
Lowest unmerged: ${frontier.lowestUnmerged ?? "none"}

${table(
  ["Branch", "PR", "SHA", "State"],
  frontier.prs.map((r) => [r.branches, String(r.pr), r.sha, r.state]),
)}

## Gates

${table(
  ["ID", "Status", "Question", "Options", "Default", "Answer"],
  gates.map((g) => [g.id, g.kind, g.question, g.options, g.defaultAnswer, g.kind === "resolved" ? g.answer : ""]),
)}

<!-- orch-summary ${JSON.stringify(summary)} -->
`;
}

// ---- Frontier: walk the PR base chain through gh ----

function tool(command, args, repo) {
  const r = run(command, args, { cwd: repo, env: process.env });
  if (r.code !== 0) throw new UsageError(`${command} ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

const GH_STATES = new Map([
  ["OPEN", "OPEN"],
  ["MERGED", "MERGED"],
  ["CLOSED", "CLOSED"],
]);

function listPullRequests(filter, branch, repo) {
  const label = `gh pr list ${filter} ${branch}`;
  // Every state is fetched: a merged or closed PR still anchors the chain, and a draft counts as OPEN.
  const raw = tool("gh", ["pr", "list", filter, branch, "--state", "all", "--json", "number,state,headRefName,baseRefName"], repo);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UsageError(`${label} output is not valid JSON`);
  }
  if (!Array.isArray(value)) throw new UsageError(`${label} output is not a JSON array`);
  return value.map((row) => {
    const state = isRecord(row) ? (GH_STATES.get(row.state) ?? null) : null;
    if (
      state === null ||
      !Number.isSafeInteger(row.number) ||
      row.number < 1 ||
      typeof row.headRefName !== "string" ||
      row.headRefName === "" ||
      typeof row.baseRefName !== "string" ||
      row.baseRefName === ""
    ) {
      throw new UsageError(`${label} output has an invalid PR row`);
    }
    return { pr: row.number, state, branch: row.headRefName, base: row.baseRefName };
  });
}

function branchPullRequest(branch, repo) {
  const rows = listPullRequests("--head", branch, repo);
  // A branch may carry closed or merged PRs from earlier surgery. Prefer its one open PR.
  const open = rows.filter((r) => r.state === "OPEN");
  const candidates = open.length > 0 ? open : rows;
  if (candidates.length === 0) {
    throw new UsageError(`branch ${branch} has no pull request; open one with gh pr create, or set the frontier from a branch whose chain is fully submitted`);
  }
  if (candidates.length > 1) {
    throw new UsageError(`branch ${branch} has multiple pull requests (${candidates.map((r) => `#${r.pr}`).join(", ")}); close the stale ones first`);
  }
  return candidates[0];
}

function trunkBranch(repo) {
  const r = run("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  // Local fixtures and init-plus-fetch checkouts lack origin/HEAD.
  return r.code === 0 ? r.stdout.trim().replace(/^origin\//, "") : "main";
}

function resolveFrontier(repo) {
  const trunk = trunkBranch(repo);
  const current = tool("git", ["symbolic-ref", "--short", "HEAD"], repo).trim();
  if (current === trunk) return [];
  const seen = new Set([current]);
  let bottom = branchPullRequest(current, repo);
  const chain = [bottom];
  while (bottom.base !== trunk) {
    if (seen.has(bottom.base)) throw new UsageError(`pull request base chain loops at branch ${bottom.base}`);
    seen.add(bottom.base);
    bottom = branchPullRequest(bottom.base, repo);
    chain.unshift(bottom);
  }
  for (let tip = current; ; ) {
    const children = listPullRequests("--base", tip, repo).filter((r) => r.state === "OPEN");
    if (children.length === 0) break;
    if (children.length > 1) throw new UsageError(`stack is not linear: branches ${children.map((r) => r.branch).join(", ")} all target ${tip}`);
    const child = children[0];
    if (seen.has(child.branch)) throw new UsageError(`pull request base chain loops at branch ${child.branch}`);
    seen.add(child.branch);
    chain.push(child);
    tip = child.branch;
  }
  if (new Set(chain.map((r) => r.pr)).size !== chain.length) throw new UsageError("pull request base chain contains duplicate pull requests");
  return chain.map((r) => ({ pr: r.pr, branches: r.branch, sha: tool("git", ["rev-parse", r.branch], repo).trim(), state: r.state }));
}

function validatePin(actual, expected) {
  if (actual.length === expected.length && actual.every((pr, i) => pr === expected[i])) return;
  const a = new Set(actual);
  const e = new Set(expected);
  const missing = expected.filter((pr) => !a.has(pr));
  const extra = actual.filter((pr) => !e.has(pr));
  const drift = [];
  if (missing.length) drift.push(`missing from resolved chain: ${missing.join(",")}`);
  if (extra.length) drift.push(`extra in resolved chain: ${extra.join(",")}`);
  if (drift.length === 0) drift.push(`order differs: expected ${expected.join(",")}; resolved ${actual.join(",")}`);
  throw new UsageError(`frontier pin mismatch: ${drift.join("; ")}`);
}

// ---- Store ----

export function openStore(directory, options = {}) {
  const dir = path.resolve(directory);
  let closed = false;
  let release = null;

  const ensureOpen = () => {
    if (closed) throw new UsageError("store is closed");
  };
  const ensureLock = () => {
    ensureOpen();
    if (!release) release = acquireLock(dir, options);
  };
  const beginWrite = () => {
    ensureOpen();
    if (!existsSync(dir)) throw notInitialized(dir);
    ensureLock();
  };
  const findUnit = (rows, id) => {
    const i = rows.findIndex((u) => u.id === id);
    if (i < 0) throw new NotFoundError(`unit ${id} not found`);
    return i;
  };
  const unitId = (id) => {
    const clean = requiredCell(id, "unit id");
    if (clean.includes(",")) throw new UsageError("unit id must not contain a comma");
    return clean;
  };

  const units = {
    add(p) {
      beginWrite();
      const row = {
        id: unitId(p.id),
        track: requiredCell(p.track, "track"),
        state: p.state === undefined ? "planned" : parseState(p.state),
        branch: "",
        pr: "",
        sha: "",
        issue: p.issue === undefined ? "" : String(positiveInteger(p.issue, "issue")),
        depends_on: p.dependsOn === undefined ? "" : idList(p.dependsOn, "depends_on"),
        lanes: p.lanes === undefined ? "" : idList(p.lanes, "lanes"),
        brief: p.brief === undefined ? "" : requiredCell(p.brief, "brief"),
      };
      if (splitList(row.depends_on).includes(row.id)) throw new UsageError(`unit ${row.id} cannot depend on itself`);
      const rows = readUnits(dir);
      if (rows.some((u) => u.id === row.id)) throw new UsageError(`unit ${row.id} already exists`);
      rows.push(row);
      saveUnits(dir, rows);
      return row;
    },
    set(p) {
      beginWrite();
      const id = unitId(p.id);
      const patch = {};
      if (p.state !== undefined) patch.state = parseState(p.state);
      if (p.track !== undefined) patch.track = requiredCell(p.track, "track");
      if (p.branch !== undefined) patch.branch = requiredCell(p.branch, "branch");
      if (p.pr !== undefined) patch.pr = String(positiveInteger(p.pr, "PR"));
      if (p.sha !== undefined) patch.sha = requiredCell(p.sha, "SHA");
      if (p.issue !== undefined) patch.issue = String(positiveInteger(p.issue, "issue"));
      if (p.dependsOn !== undefined) patch.depends_on = idList(p.dependsOn, "depends_on");
      if (p.lanes !== undefined) patch.lanes = idList(p.lanes, "lanes");
      if (p.brief !== undefined) patch.brief = requiredCell(p.brief, "brief");
      if (Object.keys(patch).length === 0) throw new UsageError("unit set needs at least one field to change");
      if (splitList(patch.depends_on ?? "").includes(id)) throw new UsageError(`unit ${id} cannot depend on itself`);
      const rows = readUnits(dir);
      const i = findUnit(rows, id);
      rows[i] = { ...rows[i], ...patch };
      saveUnits(dir, rows);
      return rows[i];
    },
    get(id) {
      ensureOpen();
      const rows = readUnits(dir);
      return rows[findUnit(rows, requiredCell(id, "unit id"))];
    },
    list(p = {}) {
      ensureOpen();
      const state = p.state === undefined ? undefined : parseState(p.state);
      const track = p.track === undefined ? undefined : requiredCell(p.track, "track");
      return readUnits(dir).filter((u) => (state === undefined || u.state === state) && (track === undefined || u.track === track));
    },
    counts() {
      ensureOpen();
      return countValues(readUnits(dir).map((u) => u.state));
    },
    // Units whose dependencies are all merged or done, in id order. When nothing is in flight and nothing
    // qualifies but planned units remain, the lowest-id planned unit is returned with override: true
    // (Cardinal's cycle-breaking rule).
    ready() {
      ensureOpen();
      const rows = readUnits(dir).sort((a, b) => compareIds(a.id, b.id));
      const state = new Map(rows.map((u) => [u.id, u.state]));
      const open = rows.filter((u) => u.state === "planned" || u.state === "ready");
      const ready = open.filter((u) => splitList(u.depends_on).every((d) => SATISFIED_STATES.includes(state.get(d))));
      if (ready.length > 0) return ready.map((u) => ({ ...u, override: false }));
      if (rows.some((u) => IN_FLIGHT_STATES.includes(u.state))) return [];
      const planned = open.find((u) => u.state === "planned");
      return planned ? [{ ...planned, override: true }] : [];
    },
  };

  const ledger = {
    record(p) {
      beginWrite();
      const verdict = parseVerdict(p.verdict);
      const unit = requiredCell(p.unit, "unit");
      let pr = p.pr === undefined ? "" : String(positiveInteger(p.pr, "PR"));
      if (pr === "") pr = readUnits(dir).find((u) => u.id === unit)?.pr ?? "";
      const row = {
        unit,
        pr,
        sha: requiredCell(p.sha, "SHA"),
        verdict,
        evidence: requiredCell(p.evidence, "evidence"),
        verifier: p.verifier === undefined ? "" : requiredCell(p.verifier, "verifier"),
        ts: new Date().toISOString(),
      };
      const rows = readLedger(dir);
      rows.push(row);
      writeTsv(path.join(dir, "ledger.tsv"), LEDGER_HEADER, rows.map(ledgerCells));
      return row;
    },
    // Latest row for (unit, sha), or null.
    latest(p) {
      ensureOpen();
      const unit = requiredCell(p.unit, "unit");
      const sha = requiredCell(p.sha, "SHA");
      return readLedger(dir).findLast((r) => r.unit === unit && r.sha === sha) ?? null;
    },
    rows() {
      ensureOpen();
      return readLedger(dir);
    },
    summary() {
      ensureOpen();
      return countValues(latestLedger(readLedger(dir)).map((r) => r.verdict));
    },
  };

  const inbox = {
    push(p) {
      beginWrite();
      const ptr = {
        ts: new Date().toISOString(),
        agent: requiredCell(p.agent, "agent"),
        unit: requiredCell(p.unit, "unit"),
        status: requiredCell(p.status, "status"),
        report: p.report === undefined ? "" : requiredCell(p.report, "report"),
      };
      const box = path.join(dir, "inbox");
      if (!existsSync(box)) throw notInitialized(dir);
      // Pushes run under the store lock, so make each timestamp strictly later than the newest pointer.
      // Two pushes in the same millisecond would otherwise tie and sort by their random suffix.
      const newest = readPointers(dir).at(-1);
      if (newest && ptr.ts <= newest.ts) ptr.ts = new Date(Date.parse(newest.ts) + 1).toISOString();
      ptr.file = `${ptr.ts.replace(/[:.]/g, "-")}-${process.pid}-${randomUUID()}.tsv`;
      atomicWrite(path.join(box, ptr.file), `${[ptr.agent, ptr.unit, ptr.status, ptr.report].join("\t")}\n`);
      return ptr;
    },
    // Oldest first; removes what it returns.
    drain() {
      beginWrite();
      const box = path.join(dir, "inbox");
      const rows = readPointers(dir);
      const drained = path.join(dir, `.inbox-drain-${process.pid}-${randomUUID()}`);
      renameSync(box, drained);
      mkdirSync(box);
      rmSync(drained, { recursive: true, force: true });
      return rows;
    },
    peek() {
      ensureOpen();
      return readPointers(dir);
    },
    count() {
      ensureOpen();
      return readPointers(dir).length;
    },
  };

  const gates = {
    park(p) {
      beginWrite();
      const gate = {
        kind: "open",
        id: requiredLine(p.id, "gate id"),
        question: requiredLine(p.question, "question"),
        options: requiredLine(p.options, "options"),
        defaultAnswer: requiredLine(p.defaultAnswer, "default"),
      };
      const rows = readGates(dir);
      const i = rows.findIndex((g) => g.id === gate.id);
      if (i < 0) rows.push(gate);
      else rows[i] = gate;
      atomicWrite(path.join(dir, "gates.md"), renderGates(rows));
      return gate;
    },
    list() {
      ensureOpen();
      return readGates(dir).filter((g) => g.kind === "open");
    },
    resolve(p) {
      beginWrite();
      const id = requiredLine(p.id, "gate id");
      const answer = requiredLine(p.answer, "answer");
      const rows = readGates(dir);
      const i = rows.findIndex((g) => g.id === id);
      if (i < 0) throw new NotFoundError(`gate ${id} not found`);
      const { question, options, defaultAnswer } = rows[i];
      rows[i] = { kind: "resolved", id, question, options, defaultAnswer, answer };
      atomicWrite(path.join(dir, "gates.md"), renderGates(rows));
      return rows[i];
    },
  };

  const frontier = {
    set(p) {
      beginWrite();
      const repo = path.resolve(requiredLine(p.repo, "repo directory"));
      const pin = p.prs === undefined ? undefined : p.prs.map((n) => positiveInteger(n, "PR"));
      if (pin && new Set(pin).size !== pin.length) throw new UsageError("--prs must not contain duplicates");
      const old = parseFrontier(requiredFile(path.join(dir, "frontier.json")));
      const prs = resolveFrontier(repo);
      if (pin) validatePin(prs.map((r) => r.pr), pin);
      const value = { generation: old.generation + 1, prs, lowestUnmerged: prs.find((r) => r.state === "OPEN")?.pr ?? null };
      atomicWrite(path.join(dir, "frontier.json"), `${JSON.stringify(value, null, 2)}\n`);
      return value;
    },
    show() {
      ensureOpen();
      return parseFrontier(requiredFile(path.join(dir, "frontier.json")));
    },
  };

  const standing = {
    show() {
      ensureOpen();
      return readStanding(dir);
    },
    add(p) {
      beginWrite();
      const rows = readStanding(dir);
      rows.push({ number: rows.length + 1, line: requiredLine(p.line, "standing order") });
      atomicWrite(path.join(dir, "preferences.md"), `${rows.map((r) => `${r.number}. ${r.line}`).join("\n")}\n`);
      return rows.at(-1);
    },
  };

  const status = {
    render() {
      beginWrite();
      const unitRows = readUnits(dir);
      const ledgerRows = readLedger(dir);
      const front = parseFrontier(requiredFile(path.join(dir, "frontier.json")));
      const gateRows = readGates(dir);
      const summary = summarize(unitRows, ledgerRows, front, gateRows);
      const file = path.join(dir, "status.md");
      const before = existsSync(file) ? previousSummary(readFileSync(file, "utf8")) : null;
      const change = changed(before, summary);
      atomicWrite(file, statusMarkdown(unitRows, ledgerRows, front, gateRows, summary));
      return { units: unitRows, ledger: ledgerRows, frontier: front, gates: gateRows, summary, changed: change };
    },
  };

  return {
    dir,
    units,
    ledger,
    inbox,
    gates,
    frontier,
    standing,
    status,
    init() {
      ensureOpen();
      mkdirSync(dir, { recursive: true });
      ensureLock();
      writeIfMissing(path.join(dir, "units.tsv"), `${UNIT_HEADER}\n`);
      writeIfMissing(path.join(dir, "ledger.tsv"), `${LEDGER_HEADER}\n`);
      mkdirSync(path.join(dir, "inbox"), { recursive: true });
      writeIfMissing(path.join(dir, "gates.md"), "");
      writeIfMissing(path.join(dir, "preferences.md"), "");
      writeIfMissing(path.join(dir, "frontier.json"), "{}\n");
      return { store: dir };
    },
    close() {
      if (closed) return;
      closed = true;
      const r = release;
      release = null;
      r?.();
    },
  };
}
