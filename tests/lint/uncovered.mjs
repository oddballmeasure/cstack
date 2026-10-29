#!/usr/bin/env node
// Prints every branch the gate suite did not take, one per line: <file>:<line> block <b> branch <n>.
// CI runs it only when the 100% coverage bar fails, so an intermittent gap names its line.
// Usage: node tests/lint/uncovered.mjs
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts["coverage:gates"];
const includes = [...script.matchAll(/--test-coverage-include="([^"]+)"/g)].map((m) => `--test-coverage-include=${m[1]}`);
const out = path.join(tmpdir(), `cstack-uncovered-${process.pid}.lcov`);
spawnSync(process.execPath, ["--test", "--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${out}`, ...includes, "tests/gates/*.test.mjs"], { cwd: ROOT, stdio: "ignore" });

// Lines inside /* node:coverage disable */ ... /* node:coverage enable */ do not count toward the bar.
const disabledLines = new Map();
function disabled(file, n) {
  if (!disabledLines.has(file)) {
    const off = new Set();
    let on = true;
    readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((text, i) => {
      if (text.includes("node:coverage disable")) on = false;
      if (!on) off.add(i + 1);
      if (text.includes("node:coverage enable")) on = true;
    });
    disabledLines.set(file, off);
  }
  return disabledLines.get(file).has(n);
}

let file = "";
const misses = new Set();
for (const line of readFileSync(out, "utf8").split("\n")) {
  if (line.startsWith("SF:")) file = path.relative(ROOT, line.slice(3));
  const m = line.match(/^BRDA:(\d+),(\d+),(\d+),(-|0)$/);
  if (m && !disabled(file, Number(m[1]))) misses.add(`${file}:${m[1]} block ${m[2]} branch ${m[3]}`);
}
console.log(misses.size ? [...misses].sort().join("\n") : "no uncovered branches in this run");
