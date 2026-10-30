import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { execPath } from "node:process";
import { makeRepo, gate, path, write } from "./helpers.mjs";

const script = "console.log('args=' + process.argv.slice(1).join(',')); process.exit(require('fs').existsSync('src/broken') ? 3 : 0)";
const repo = (cfg = {}) => makeRepo({ test_command: [execPath, "-e", script], ...cfg });

test("runs test_command in the worktree: uncommitted edits count, extra arguments pass through", () => {
  const r = repo();
  const ok = gate("run-tests.mjs", [r.root, "--json", "--", "a", "b"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.ok, true);
  assert.match(ok.json.tail, /args=a,b/);
  write(r.root, "src/broken", "1\n");
  const red = gate("run-tests.mjs", [r.root, "--json"]);
  assert.equal(red.code, 1);
  assert.deepEqual([red.json.ok, red.json.code, red.json.timed_out], [false, 3, false]);
  assert.match(red.json.findings[0].detail, /^exit 3\n/);
});

test("it never touches the verdict cache, and --lines bounds the tail", () => {
  const r = makeRepo({ test_command: [execPath, "-e", "for (let i = 1; i <= 5; i++) console.log('line ' + i)"] });
  const out = gate("run-tests.mjs", [r.root, "--json", "--lines", "2"]);
  assert.equal(out.json.tail, "line 4\nline 5");
  assert.equal(existsSync(path.join(r.root, ".cstack", "cache")), false);
});

test("a timeout fails; usage errors exit 2", () => {
  const r = makeRepo({ test_command: [execPath, "-e", "setTimeout(() => {}, 60000)"], limits: { test_timeout_seconds: 1 } });
  const slow = gate("run-tests.mjs", [r.root, "--json"]);
  assert.equal(slow.code, 1);
  assert.equal(slow.json.timed_out, true);
  assert.match(slow.json.findings[0].detail, /^timed out/);
  for (const args of [[], [r.root, "x"], [r.root, "--lines", "0"]]) assert.equal(gate("run-tests.mjs", args).code, 2, args.join(" "));
  const none = makeRepo({ test_command: null });
  assert.match(gate("run-tests.mjs", [none.root]).err, /config test_command is not set/);
  const bare = makeRepo({ test_command: [execPath, "-e", "0"], limits: null });
  assert.equal(gate("run-tests.mjs", [bare.root]).code, 0, "the default timeout applies without limits");
  writeFileSync(path.join(bare.root, ".cstack/config.json"), JSON.stringify({ test_command: [execPath, "-e", "0"], limits: {} }));
  assert.equal(gate("run-tests.mjs", [bare.root]).code, 0);
});
