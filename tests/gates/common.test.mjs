import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, which, envPath, cmdLine } from "../../gates/lib/common.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "cstack-common-"));

test("envPath reads PATH in any case, and the first key in sort order wins", () => {
  assert.equal(envPath({ PATH: "/a" }), "/a");
  assert.equal(envPath({ Path: "/b", PATH: "/a" }), "/a");
  assert.equal(envPath({}), "");
});

test("which finds an executable on PATH, as command -v does", { skip: process.platform === "win32" && "a POSIX PATH cannot hold a drive letter, and Windows has no execute bit" }, () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n");
  chmodSync(path.join(dir, "tool"), 0o755);
  writeFileSync(path.join(dir, "plain"), "x\n");
  chmodSync(path.join(dir, "plain"), 0o644);
  mkdirSync(path.join(dir, "adir"));
  const env = { PATH: `:${dir}` };
  assert.equal(which("tool", env, "linux"), path.join(dir, "tool"));
  assert.equal(which("plain", env, "linux"), null, "no execute bit");
  assert.equal(which("adir", env, "linux"), null, "a directory");
  assert.equal(which("missing", env, "linux"), null);
});

test("which on Windows tries each PATHEXT extension and needs no execute bit", () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "gh.CMD"), "@echo off\n");
  writeFileSync(path.join(dir, "node.exe"), "");
  const env = { Path: `${dir};`, PATHEXT: ".EXE;.CMD" };
  assert.equal(which("gh", env, "win32"), path.join(dir, "gh.CMD"));
  assert.equal(which("node.exe", env, "win32"), path.join(dir, "node.exe"));
  assert.equal(which("gh", { Path: dir }, "win32"), path.join(dir, "gh.CMD"), "default PATHEXT");
  assert.equal(which("nope", env, "win32"), null);
});

test("cmdLine quotes each argument and escapes cmd.exe metacharacters twice", () => {
  assert.equal(cmdLine("C:\\bin\\gh.cmd", ["pr", "a b"]), 'C:\\bin\\gh.cmd ^^^"pr^^^" ^^^"a^^^ b^^^"');
  assert.equal(cmdLine("x.cmd", ['say "hi"', "dir\\"]), 'x.cmd ^^^"say^^^ \\^^^"hi\\^^^"^^^" ^^^"dir\\\\^^^"');
});

// A fake that prints its argv as JSON: a .cmd shim on Windows, a node script elsewhere.
test("run passes every argument through literally, also to a Windows batch file", () => {
  const dir = tmp();
  const js = path.join(dir, "echo-args.mjs");
  writeFileSync(js, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  if (process.platform === "win32") writeFileSync(path.join(dir, "echo-args.cmd"), '@node "%~dp0echo-args.mjs" %*\r\n');
  else {
    writeFileSync(path.join(dir, "echo-args"), `#!/usr/bin/env node\nimport(${JSON.stringify(js)});\n`);
    chmodSync(path.join(dir, "echo-args"), 0o755);
  }
  const args = ["plain", "two words", 'a "quoted" word', "&|<>^%PATH%!()", "back\\slash\\", "", ".[].name", "x=1;y=2"];
  const r = run("echo-args", args, { env: { ...process.env, PATH: `${dir}${path.delimiter}${envPath()}` } });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), args);
});
