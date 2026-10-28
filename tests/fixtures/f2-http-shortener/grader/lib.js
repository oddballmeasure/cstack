// Held-out grader helpers for the f2-http-shortener fixture. cstack never sees this directory.
// SHORTENER_ENTRY is the server under test; it defaults to server.mjs under the working directory.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";

export const ENTRY = path.resolve(process.env.SHORTENER_ENTRY || "server.mjs");
const OWN_ENV = ["PORT", "HOST", "DATA_FILE", "BASE_URL", "RATE_LIMIT", "RATE_WINDOW_MS", "NODE_OPTIONS"];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (s) => JSON.stringify(s.length > 400 ? s.slice(0, 397) + "..." : s);

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A fresh working directory per test. dataFile is links.json in its own subdirectory.
export function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "shortener-grader-"));
  const dataDir = path.join(dir, "store");
  mkdirSync(dataDir);
  const sb = { dir, dataDir, dataFile: path.join(dataDir, "links.json"), procs: new Set() };
  t.after(() => {
    for (const p of sb.procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });
  return sb;
}

// Spawn the server. env values of null unset a variable. Defaults: a free PORT, DATA_FILE, RATE_LIMIT=1000.
function spawnServer(sb, env, port) {
  const e = { ...process.env };
  for (const k of OWN_ENV) delete e[k];
  delete e.FORCE_COLOR;
  e.NO_COLOR = "1";
  Object.assign(e, { PORT: String(port), DATA_FILE: sb.dataFile, RATE_LIMIT: "1000" });
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete e[k];
    else e[k] = String(v);
  }
  const proc = spawn(process.execPath, [ENTRY], { cwd: sb.dir, env: e, stdio: ["ignore", "pipe", "pipe"] });
  sb.procs.add(proc);
  const out = { stdout: "", stderr: "" };
  proc.stdout.on("data", (c) => (out.stdout += c));
  proc.stderr.on("data", (c) => (out.stderr += c));
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, out, exited };
}

// Start the server and wait for its `listening on <port>` line.
export async function start(sb, env = {}) {
  const port = env.PORT !== undefined ? env.PORT : await freePort();
  const { proc, out, exited } = spawnServer(sb, env, port);
  const result = await Promise.race([
    new Promise((resolve) => {
      const check = () => {
        const m = out.stdout.match(/^listening on (\d+)\r?$/m);
        if (m) {
          proc.stdout.off("data", check);
          resolve({ port: Number(m[1]) });
        }
      };
      proc.stdout.on("data", check);
      check();
    }),
    exited.then((x) => ({ exit: x })),
    sleep(8000).then(() => ({ timeout: true })),
  ]);
  if (!result.port) {
    if (result.timeout) proc.kill("SIGKILL");
    const how = result.exit ? `exited (code ${result.exit.code}, signal ${result.exit.signal})` : "did not print `listening on <port>` within 8 s";
    assert.fail(`server ${ENTRY} ${how}; stdout ${show(out.stdout)}; stderr ${show(out.stderr)}`);
  }
  return {
    port: result.port,
    proc,
    out,
    exited,
    req: (method, p, opts) => request(result.port, method, p, opts),
    // Send a signal and wait for exit. Returns {code, signal, ms}, or {timedOut: true} after limitMs.
    async stop(signal = "SIGTERM", limitMs = 5000) {
      const t0 = Date.now();
      proc.kill(signal);
      const r = await Promise.race([exited, sleep(limitMs).then(() => null)]);
      if (!r) {
        proc.kill("SIGKILL");
        return { timedOut: true, ms: Date.now() - t0 };
      }
      return { ...r, ms: Date.now() - t0 };
    },
  };
}

// Run the server and expect it to exit on its own (startup errors). Returns {code, stdout, stderr} or code null on timeout.
export async function runToExit(sb, env = {}, limitMs = 5000) {
  const port = env.PORT !== undefined ? env.PORT : await freePort();
  const { proc, out, exited } = spawnServer(sb, env, port);
  const r = await Promise.race([exited, sleep(limitMs).then(() => null)]);
  if (!r) proc.kill("SIGKILL");
  return { code: r ? r.code : null, signal: r?.signal ?? null, stdout: out.stdout, stderr: out.stderr };
}

// One HTTP request without following redirects. opts.json sends a JSON body; opts.body sends raw text.
export function request(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    let body = opts.body;
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
    }
    if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: opts.agent ?? false, localAddress: opts.localAddress, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ method, path: p, status: res.statusCode, headers: res.headers, text, json });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${p} timed out`)));
    req.on("error", (err) => reject(new Error(`${method} ${p} failed: ${err.message}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function describe(r) {
  return `${r.method} ${r.path}: status ${r.status}; headers ${JSON.stringify(r.headers)}; body ${show(r.text)}`;
}

// Exact status, and, when given, exact JSON body (deep equal) and exact header values.
export function expectRes(r, status, json, headers = {}) {
  assert.equal(r.status, status, `expected status ${status}. Got ${describe(r)}`);
  if (json !== undefined) {
    assert.match(String(r.headers["content-type"]), /^application\/json; charset=utf-8$/i, `expected JSON content type. Got ${describe(r)}`);
    assert.deepEqual(r.json, json, `expected body ${JSON.stringify(json)}. Got ${describe(r)}`);
  }
  for (const [k, v] of Object.entries(headers)) assert.equal(r.headers[k.toLowerCase()], v, `expected header ${k}: ${v}. Got ${describe(r)}`);
}

export const LINK_KEYS = ["created_at", "hits", "short_url", "slug", "url"];

// A link object with exactly the 5 keys, and the given field values.
export function expectLink(link, want, port) {
  assert.ok(link && typeof link === "object", `expected a link object, got ${JSON.stringify(link)}`);
  assert.deepEqual(Object.keys(link).sort(), LINK_KEYS, `link keys. Got ${JSON.stringify(link)}`);
  assert.match(link.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `created_at is an ISO timestamp. Got ${JSON.stringify(link)}`);
  if (port !== undefined) assert.equal(link.short_url, `http://127.0.0.1:${port}/${link.slug}`, `short_url. Got ${JSON.stringify(link)}`);
  for (const [k, v] of Object.entries(want)) assert.deepEqual(link[k], v, `link ${k}. Got ${JSON.stringify(link)}`);
}

// Create a link and require 201.
export async function create(srv, json, opts = {}) {
  const r = await srv.req("POST", "/api/links", { json, ...opts });
  assert.equal(r.status, 201, `setup create failed. Got ${describe(r)}`);
  return r.json;
}
