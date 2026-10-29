// Shared helpers for cstack gate scripts. No dependencies beyond Node 22+.
// Output contract for every gate:
//   one line per check: "PASS <check>: <detail>" or "FAIL <check>: <detail>"
//   last line: "gate <name>: approved" or "gate <name>: rejected (<n> findings)"
//   --json prints {gate, approved, findings:[{check, detail}], passes:[...]} instead
// Exit codes: 0 approved, 1 rejected, 2 usage or environment error.
import { readFileSync, existsSync, statSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export class UsageError extends Error {}

// The PATH value of an env. Windows env keys are case-insensitive, and a child gets the first key in sort
// order, so `{ ...process.env, PATH }` overrides `Path`.
export function envPath(env = process.env) {
  const key = Object.keys(env).filter((k) => k.toUpperCase() === "PATH").sort()[0];
  return key ? env[key] : "";
}

// The file a bare command name runs, as `command -v` finds it, or null. On Windows a name without an
// extension tries each PATHEXT extension, and a file needs no execute bit.
export function which(cmd, env = process.env, platform = process.platform) {
  const win = platform === "win32";
  const exts = win ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [];
  const names = win && !exts.some((e) => cmd.toUpperCase().endsWith(e.toUpperCase())) ? exts.map((e) => cmd + e) : [cmd];
  for (const dir of envPath(env).split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (!statSync(file).isFile()) continue;
        if (!win) accessSync(file, constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

// A cmd.exe command line that runs a .cmd or .bat file with these arguments, each passed through as one
// literal argument. A batch file re-parses its arguments (`%*`), so metacharacters are escaped twice.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
export function cmdLine(file, args) {
  const quote = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
  return [file.replace(CMD_META, "^$1"), ...args.map(quote)].join(" ");
}

export function run(cmd, args = [], opts = {}) {
  // Windows spawns only .exe and .com files directly. A .cmd or .bat (npm, a test fake) goes through cmd.exe.
  /* node:coverage disable */
  const batch = process.platform === "win32" && !/[\\/]/.test(cmd) ? which(cmd, opts.env) : null;
  if (batch && /\.(cmd|bat)$/i.test(batch)) {
    return run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmdLine(batch, args)}"`], { ...opts, windowsVerbatimArguments: true });
  }
  /* node:coverage enable */
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  const timedOut = r.error?.code === "ETIMEDOUT";
  // A command that could not start (not found, not executable) reports 127, as a shell would.
  if (r.error && !timedOut) return { code: 127, stdout: "", stderr: r.error.message, timedOut: false };
  // With encoding set, stdout and stderr are strings. A null status means a signal killed it.
  return { code: r.status ?? 128, stdout: r.stdout, stderr: r.stderr, timedOut };
}

export function git(cwd, args) {
  return run("git", ["-C", cwd, ...args]);
}

export function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.code !== 0) throw new UsageError(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// Find .cstack/config.json from dir upward. In a sparse implementer worktree the config is still present.
export function loadConfig(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const p = path.join(d, ".cstack", "config.json");
    if (existsSync(p)) {
      try {
        return { root: d, config: JSON.parse(readFileSync(p, "utf8")) };
      } catch (err) {
        throw new UsageError(`${p} does not parse: ${err.message}`);
      }
    }
    const parent = path.dirname(d);
    if (parent === d) throw new UsageError(`no .cstack/config.json above ${dir}`);
    d = parent;
  }
}

// Static prefix of a glob: the part before the first wildcard segment.
export function globPrefix(glob) {
  const out = [];
  for (const seg of glob.split("/")) {
    if (/[*?[{]/.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

export function matchesAny(rel, globs = []) {
  for (const g of globs) {
    if (path.matchesGlob(rel, g)) return g;
    // "dir/**" also covers the directory itself.
    if (g.endsWith("/**") && rel === g.slice(0, -3)) return g;
  }
  return null;
}

export function parseArgs(argv, spec) {
  // spec: { flags: ["json", ...], options: ["base", ...] } ; returns { _: [...], flag: true, option: "v" }
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (spec.flags?.includes(k)) out[k] = true;
      else if (spec.options?.includes(k)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new UsageError(`--${k} needs a value`);
        out[k] = v;
      } else throw new UsageError(`unknown option --${k}`);
    } else out._.push(a);
  }
  return out;
}

export class Gate {
  constructor(name, { json = false } = {}) {
    this.name = name;
    this.json = json;
    this.findings = [];
    this.passes = [];
  }
  pass(check, detail) {
    this.passes.push({ check, detail });
  }
  fail(check, detail) {
    this.findings.push({ check, detail });
  }
  check(cond, check, okDetail, failDetail) {
    if (cond) this.pass(check, okDetail);
    else this.fail(check, failDetail);
    return cond;
  }
  get approved() {
    return this.findings.length === 0;
  }
  // Prints the report and returns the exit code (0 approved, 1 rejected).
  finish(extra = {}) {
    if (this.json) {
      process.stdout.write(JSON.stringify({ gate: this.name, approved: this.approved, findings: this.findings, passes: this.passes, ...extra }, null, 2) + "\n");
    } else {
      for (const p of this.passes) process.stdout.write(`PASS ${p.check}: ${p.detail}\n`);
      for (const f of this.findings) process.stdout.write(`FAIL ${f.check}: ${f.detail}\n`);
      process.stdout.write(this.approved ? `gate ${this.name}: approved\n` : `gate ${this.name}: rejected (${this.findings.length} findings)\n`);
    }
    return this.approved ? 0 : 1;
  }
}

// Wrap a gate's main so usage errors exit 2 with a clear message.
export async function main(fn) {
  try {
    process.exitCode = await fn(process.argv.slice(2));
  } catch (err) {
    // Anything that is not a UsageError is a bug in the gate: let it crash with a stack trace.
    /* node:coverage disable */
    if (!(err instanceof UsageError)) throw err;
    /* node:coverage enable */
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
  }
}
