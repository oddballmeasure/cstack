// Held-out grader helpers for the f1-cli-ledger fixture. cstack never sees this directory.
// LEDGER_BIN is the CLI under test; it defaults to bin/ledger.mjs under the working directory.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

export const BIN = path.resolve(process.env.LEDGER_BIN || "bin/ledger.mjs");

// A fresh directory per test. `ledger` is the LEDGER_FILE path inside it.
export function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "ledger-grader-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, "ledger.txt");
  return {
    dir,
    ledger,
    // opts.ledgerFile: false runs with LEDGER_FILE unset.
    run(args, opts = {}) {
      const env = { ...process.env };
      delete env.LEDGER_FILE;
      delete env.NODE_OPTIONS;
      if (opts.ledgerFile !== false) env.LEDGER_FILE = ledger;
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
      return { args, code: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
    },
    write(name, text) {
      writeFileSync(path.join(dir, name), text);
    },
    read(name = "ledger.txt") {
      return readFileSync(path.join(dir, name), "utf8");
    },
    exists(name = "ledger.txt") {
      return existsSync(path.join(dir, name));
    },
  };
}

const show = (s) => JSON.stringify(s.length > 300 ? s.slice(0, 297) + "..." : s);

function describe(r) {
  const how = r.error ? `spawn error ${r.error.code}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`;
  return `ledger ${r.args.join(" ")}: ${how}; stdout ${show(r.stdout)}; stderr ${show(r.stderr)}`;
}

// Exact stdout (each line ends with \n), exact first stderr line, exact exit code.
export function expectRun(r, { code = 0, stdout, stderr }) {
  assert.equal(r.code, code, `expected exit ${code}. Got ${describe(r)}`);
  if (stdout !== undefined) {
    const want = stdout.length ? stdout.map((l) => l + "\n").join("") : "";
    assert.equal(r.stdout, want, `expected stdout ${show(want)}. Got ${describe(r)}`);
  }
  if (stderr !== undefined) {
    assert.equal(r.stderr.trimEnd(), stderr, `expected stderr ${show(stderr)}. Got ${describe(r)}`);
  }
}

// Run each command and require exit 0, for setup steps inside a test.
export function setup(sb, ...commands) {
  for (const args of commands) {
    const r = sb.run(args);
    assert.equal(r.code, 0, `setup step failed. Got ${describe(r)}`);
  }
}
