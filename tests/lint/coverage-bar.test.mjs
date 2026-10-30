import { test } from "node:test";
import assert from "node:assert/strict";
import { judge, missesFromLcov } from "./coverage-bar.mjs";

const pass = { code: 0, failedTests: 0, misses: [] };
const gap = { code: 1, failedTests: 0, misses: ["gates/a.mjs:3 block 1 branch 0"] };
const failed = { code: 1, failedTests: 2, misses: [] };

function play(...runs) {
  const said = [];
  let used = 0;
  const code = judge(() => runs[used++], (s) => said.push(s));
  return { code, used, said: said.join("\n") };
}

test("a passing run ends the bar", () => {
  assert.deepEqual(play(pass), { code: 0, used: 1, said: "" });
});

test("a failing test fails at once, with no second run", () => {
  const r = play(failed);
  assert.equal(r.code, 1);
  assert.equal(r.used, 1);
  assert.match(r.said, /2 test\(s\) failed/);
});

test("a gap in one run only passes with a warning that names it", () => {
  const r = play(gap, pass);
  assert.equal(r.code, 0);
  assert.equal(r.used, 2);
  assert.match(r.said, /::warning::.*gates\/a\.mjs:3 block 1 branch 0/);
});

test("a gap in both runs fails and names both", () => {
  const r = play(gap, gap);
  assert.equal(r.code, 1);
  assert.match(r.said, /Uncovered in this run:\ngates\/a\.mjs:3/);
  assert.match(r.said, /Uncovered in the second run:\ngates\/a\.mjs:3/);
});

test("a line gap names no branch and still needs a second run", () => {
  const line = { code: 1, failedTests: 0, misses: [] };
  assert.match(play(line, pass).said, /a line gap[\s\S]*::warning::.*a line/);
  assert.match(play(line, line).said, /second run:\n\(no branch named/);
});

test("a test failing in the second run keeps its exit code", () => {
  const r = play(gap, failed);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.said, /second run/);
});

test("missesFromLcov lists untaken branches and skips disabled lines", () => {
  const src = "a\n/* node:coverage disable */\nb\n/* node:coverage enable */\nc\n";
  const lcov = "SF:gates/x.mjs\nBRDA:1,0,0,1\nBRDA:1,0,1,0\nBRDA:3,1,0,0\nBRDA:5,2,0,-\nend_of_record\n";
  assert.deepEqual(missesFromLcov(lcov, "/r", () => src), ["gates/x.mjs:1 block 0 branch 1", "gates/x.mjs:5 block 2 branch 0"]);
});
