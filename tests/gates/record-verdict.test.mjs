import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GATES } from "./helpers.mjs";

const SHA = "a".repeat(40);
const record = (store, input, extra = []) => {
  const r = spawnSync(process.execPath, [path.join(GATES, "record-verdict.mjs"), "--store", store, "--unit", "U1", "--sha", SHA, "--by", "fable", "--json", ...extra], { input, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, err: r.stderr };
};
const verdict = (o = {}) => JSON.stringify({ unit: "U1", head_sha: SHA, requirements: [{ id: "R1", delivered: true, evidence: "tests" }], findings: [], ...o });
const failed = (r) => r.json.findings.map((f) => f.check);

test("records a well-formed verdict at the path check-verdict reads, with provenance, once", () => {
  const store = mkdtempSync(path.join(tmpdir(), "cstack-verdict-"));
  const r = record(store, verdict());
  assert.equal(r.code, 0, r.err);
  const file = path.join(store, `verdict-U1-${SHA.slice(0, 12)}.json`);
  assert.equal(r.json.file, file);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([saved.by, typeof saved.recorded_at, saved.requirements[0].id], ["fable", "string", "R1"]);
  const again = record(store, verdict({ findings: ["changed my mind"] }));
  assert.equal(again.code, 1);
  assert.deepEqual(failed(again), ["new"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).findings, [], "the first verdict stands");
});

test("takes the verdict as an argument, the form the allowlist accepts", () => {
  const store = mkdtempSync(path.join(tmpdir(), "cstack-verdict-"));
  const r = record(store, "", ["--verdict", verdict({ findings: ["a > b"] })]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(r.json.file, "utf8")).findings, ["a > b"]);
});

test("refuses a verdict that does not parse or does not match the unit, head and shape", () => {
  const store = mkdtempSync(path.join(tmpdir(), "cstack-verdict-"));
  assert.deepEqual(failed(record(store, "{")), ["json"]);
  assert.deepEqual(failed(record(store, verdict({ unit: "U2", head_sha: "b".repeat(40), requirements: [], findings: null }))), ["unit", "head", "requirements", "findings"]);
  assert.deepEqual(failed(record(store, "[]")), ["unit", "head", "requirements", "findings"]);
  for (const extra of [[], ["x"]]) assert.equal(spawnSync(process.execPath, [path.join(GATES, "record-verdict.mjs"), ...extra], { input: "" }).status, 2);
  const short = spawnSync(process.execPath, [path.join(GATES, "record-verdict.mjs"), "--store", store, "--unit", "U1", "--sha", "abc", "--by", "x"], { input: verdict(), encoding: "utf8" });
  assert.equal(short.status, 2);
  assert.match(short.stderr, /40-hex sha/);
});
