#!/usr/bin/env node
// Scenario-driven fake gh. Used when FAKE_GH_SCENARIO points at a JSON file:
// { "rules": [ { "match": "<regex over argv joined by spaces>", "responses": [ {"stdout": "...", "stderr": "...", "code": 0}, ... ] } ] }
// The first rule whose regex matches answers. Each rule walks its responses in order across calls;
// the last response repeats. Call counts persist in FAKE_GH_STATE (default: <scenario>.state).
// "json" in a response is stringified into stdout. Unmatched calls exit 1 with "fake gh: unhandled".
// Every call is appended to FAKE_GH_LOG if set.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const line = argv.join(" ");
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, line + "\n");

const scenarioPath = process.env.FAKE_GH_SCENARIO;
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
const statePath = process.env.FAKE_GH_STATE || scenarioPath + ".state";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

for (const [i, rule] of (scenario.rules || []).entries()) {
  if (!new RegExp(rule.match, "s").test(line)) continue;
  const n = state[i] || 0;
  state[i] = n + 1;
  writeFileSync(statePath, JSON.stringify(state));
  const resp = rule.responses[Math.min(n, rule.responses.length - 1)] || {};
  const out = resp.json !== undefined ? JSON.stringify(resp.json) + "\n" : resp.stdout || "";
  process.stdout.write(out);
  if (resp.stderr) process.stderr.write(resp.stderr);
  process.exit(resp.code ?? 0);
}
process.stderr.write(`fake gh: unhandled: ${line}\n`);
process.exit(1);
