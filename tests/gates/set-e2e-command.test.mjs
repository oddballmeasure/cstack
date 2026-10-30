import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gate } from "./helpers.mjs";

function wt(config = { autonomy: "stop", paths_hidden: ["tests/acceptance/**"], e2e_command: null }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cstack-e2e-cmd-"));
  if (config) {
    mkdirSync(path.join(dir, ".cstack"));
    writeFileSync(path.join(dir, ".cstack/config.json"), JSON.stringify(config));
  }
  return dir;
}
const cmdFile = (dir, text) => {
  const f = path.join(dir, "cmd.json");
  writeFileSync(f, text);
  return f;
};

test("sets e2e_command and leaves every other key alone", () => {
  const dir = wt();
  const r = gate("set-e2e-command.mjs", [dir, "--command-file", cmdFile(dir, '["node","--test"]'), "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".cstack/config.json"), "utf8")), { autonomy: "stop", paths_hidden: ["tests/acceptance/**"], e2e_command: ["node", "--test"] });
});

test("refuses a bad command or a missing config; usage errors exit 2", () => {
  const dir = wt();
  for (const text of ["{", "[]", '"npm test"', '[""]', "[1]"]) {
    assert.equal(gate("set-e2e-command.mjs", [dir, "--command-file", cmdFile(dir, text), "--json"]).code, 1, text);
  }
  assert.equal(JSON.parse(readFileSync(path.join(dir, ".cstack/config.json"), "utf8")).e2e_command, null);
  const none = wt(null);
  const r = gate("set-e2e-command.mjs", [none, "--command-file", cmdFile(none, '["x"]'), "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.json.findings[0].detail, /does not exist/);
  for (const args of [[], [dir], ["--command-file", "x"]]) assert.equal(gate("set-e2e-command.mjs", args).code, 2, args.join(" "));
});
