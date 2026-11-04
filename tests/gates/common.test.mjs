import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, which, envPath, cmdLine, insideDir } from "../../gates/lib/common.mjs";

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

test("insideDir compares a git-style store root and a short-name temp path in one form on Windows", () => {
  // git prints the common dir with forward slashes and the long name; os.tmpdir() gives the 8.3 short name.
  const disk = new Set(["C:\\", "C:\\Users", "C:\\Users\\runneradmin", "C:\\Users\\runneradmin\\Temp", "C:\\Users\\runneradmin\\Temp\\g\\repo\\.cstack\\runs"]);
  const short = (q) => q.replace(/^c:\\users\\RUNNER~1/i, "C:\\Users\\runneradmin");
  const win = { platform: "win32", exists: (q) => disk.has(short(q).replace(/^c:/, "C:")), realpath: (q) => short(q).replace(/^c:/, "C:") };
  const runs = "C:/Users/runneradmin/Temp/g/repo/.cstack/runs";
  assert.equal(insideDir(runs, "c:\\Users\\RUNNER~1\\Temp\\g\\repo\\.cstack\\runs\\p\\final-e2e-0123456789ab.json", win), true);
  assert.equal(insideDir(runs, "C:\\USERS\\runneradmin\\temp\\g\\repo\\.cstack\\runs\\..x\\r.json", win), true);
  assert.equal(insideDir(runs, "c:\\Users\\RUNNER~1\\Temp\\g\\repo\\.cstack\\r.json", win), false);
  assert.equal(insideDir(runs, "C:\\Users\\runneradmin\\Temp\\g\\repo\\.cstack\\runs", win), false);
  assert.equal(insideDir(runs, "D:\\Users\\runneradmin\\Temp\\g\\repo\\.cstack\\runs\\r.json", { ...win, exists: () => false }), false);
});

test("insideDir follows symlinks and keeps case on POSIX", () => {
  const posix = { platform: "linux", exists: (q) => q === "/" || q.startsWith("/real") || q === "/link", realpath: (q) => q.replace(/^\/link/, "/elsewhere") };
  assert.equal(insideDir("/real/runs", "/real/runs/p/r.json", posix), true);
  assert.equal(insideDir("/real/runs", "/real/RUNS/p/r.json", { ...posix, exists: (q) => q === "/" || q === "/real" }), false);
  assert.equal(insideDir("/link", "/link/r.json", posix), true);
  assert.equal(insideDir("/real/runs", "/link/r.json", posix), false);
});
