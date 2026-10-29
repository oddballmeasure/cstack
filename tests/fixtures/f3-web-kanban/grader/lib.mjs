// Held-out grader helpers for the f3-web-kanban fixture. cstack never sees this directory.
// KANBAN_ENTRY is the server under test; it defaults to server.mjs under the working directory.
import { test as base, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";

export { expect };
export const ENTRY = path.resolve(process.env.KANBAN_ENTRY || "server.mjs");
const OWN_ENV = ["PORT", "HOST", "DATA_FILE", "NODE_OPTIONS"];
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

// Cards for a seeded data file. columns maps a column id to titles or {title, description} objects.
let seq = 0;
export function seedBoard(columns) {
  const at = "2026-10-01T10:00:00.000Z";
  const out = { todo: [], doing: [], done: [] };
  for (const [col, cards] of Object.entries(columns)) {
    out[col] = cards.map((c) => {
      const { title, description = "" } = typeof c === "string" ? { title: c } : c;
      return { id: `seed${++seq}`, title, description, created_at: at, updated_at: at };
    });
  }
  return { version: 1, columns: out };
}

function spawnServer(dir, env) {
  const e = { ...process.env };
  for (const k of OWN_ENV) delete e[k];
  delete e.FORCE_COLOR;
  e.NO_COLOR = "1";
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete e[k];
    else e[k] = String(v);
  }
  const proc = spawn(process.execPath, [ENTRY], { cwd: dir, env: e, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  proc.stdout.on("data", (c) => (out.stdout += c));
  proc.stderr.on("data", (c) => (out.stderr += c));
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  return { proc, out, exited };
}

// Raw HTTP request: the path is sent as given (no normalisation). body objects are sent as JSON.
export function rawRequest(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let data;
    if (body !== undefined) {
      data = typeof body === "string" ? body : JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false, timeout: 10000 }, (res) => {
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
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${p} timed out`)));
    req.on("error", (err) => reject(new Error(`${method} ${p} failed: ${err.message}`)));
    if (data !== undefined) req.write(data);
    req.end();
  });
}

export function describeRes(r) {
  return `${r.method} ${r.path}: status ${r.status}; content-type ${r.headers["content-type"]}; body ${show(r.text)}`;
}

// The `launch` fixture starts servers for one test and stops them all afterwards.
// launch({seed, env, dir}) -> app. A seed is written to the data file before start. dir reuses a working directory.
export const test = base.extend({
  launch: async ({}, use) => {
    const procs = [];
    const dirs = [];
    async function launch(opts = {}) {
      let dir = opts.dir;
      if (!dir) {
        dir = mkdtempSync(path.join(tmpdir(), "kanban-grader-"));
        dirs.push(dir);
      }
      const dataFile = opts.dataFile ?? path.join(dir, "board.json");
      if (opts.seed !== undefined) writeFileSync(dataFile, typeof opts.seed === "string" ? opts.seed : JSON.stringify(opts.seed));
      const port = await freePort();
      const env = { PORT: port, DATA_FILE: dataFile, ...(opts.env || {}) };
      const s = spawnServer(dir, env);
      procs.push(s.proc);
      if (opts.expectExit) {
        const r = await Promise.race([s.exited, sleep(5000).then(() => null)]);
        if (!r) s.proc.kill("SIGKILL");
        return { code: r ? r.code : null, stdout: s.out.stdout, stderr: s.out.stderr, dataFile, dir };
      }
      const result = await Promise.race([
        new Promise((resolve) => {
          const check = () => {
            const m = s.out.stdout.match(/^listening on (\d+)\r?$/m);
            if (m) resolve({ port: Number(m[1]) });
          };
          s.proc.stdout.on("data", check);
          check();
        }),
        s.exited.then((x) => ({ exit: x })),
        sleep(8000).then(() => ({ timeout: true })),
      ]);
      if (!result.port) {
        s.proc.kill("SIGKILL");
        const how = result.exit ? `exited (code ${result.exit.code}, signal ${result.exit.signal})` : "did not print `listening on <port>` within 8 s";
        throw new Error(`server ${ENTRY} ${how}; stdout ${show(s.out.stdout)}; stderr ${show(s.out.stderr)}`);
      }
      const url = `http://127.0.0.1:${result.port}/`;
      const app = {
        url,
        origin: `http://127.0.0.1:${result.port}`,
        port: result.port,
        dir,
        dataFile,
        proc: s.proc,
        exited: s.exited,
        req: (method, p, body) => rawRequest(result.port, method, p, body),
        async board() {
          const r = await rawRequest(result.port, "GET", "/api/board");
          if (r.status !== 200 || !r.json) throw new Error(`GET /api/board failed: ${describeRes(r)}`);
          return r.json;
        },
        // Titles per column from the API, as {todo: [...], doing: [...], done: [...]}.
        async titles() {
          const b = await app.board();
          return Object.fromEntries(b.columns.map((c) => [c.id, c.cards.map((x) => x.title)]));
        },
        async create(title, column, description) {
          const r = await rawRequest(result.port, "POST", "/api/cards", { title, ...(column ? { column } : {}), ...(description !== undefined ? { description } : {}) });
          if (r.status !== 201) throw new Error(`setup create failed: ${describeRes(r)}`);
          return r.json;
        },
        // Signal and wait for exit: {code, signal, ms} or {timedOut: true}.
        async stop(signal = "SIGTERM", limitMs = 5000) {
          const t0 = Date.now();
          s.proc.kill(signal);
          const r = await Promise.race([s.exited, sleep(limitMs).then(() => null)]);
          if (!r) {
            s.proc.kill("SIGKILL");
            return { timedOut: true, ms: Date.now() - t0 };
          }
          return { ...r, ms: Date.now() - t0 };
        },
        async restart() {
          const stopped = await app.stop();
          if (stopped.code !== 0) throw new Error(`server did not stop cleanly on SIGTERM: ${JSON.stringify(stopped)}`);
          return launch({ dir, dataFile, env: opts.env });
        },
        readData: () => JSON.parse(readFileSync(dataFile, "utf8")),
      };
      return app;
    }
    await use(launch);
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  },
});

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The card <li> whose title is exactly `title`.
export const cardByTitle = (page, title) => page.getByTestId("card").filter({ has: page.getByTestId("card-title").filter({ hasText: new RegExp(`^\\s*${escapeRe(title)}\\s*$`) }) });
export const cardById = (page, id) => page.locator(`[data-testid="card"][data-card-id="${id}"]`);
export const columnTitles = (page, col) => page.getByTestId(`cards-${col}`).getByTestId("card-title");

// Open the board, record console errors, page errors and requests.
export async function openBoard(page, app) {
  const log = { errors: [], requests: [] };
  page.on("console", (m) => m.type() === "error" && log.errors.push(m.text()));
  page.on("pageerror", (e) => log.errors.push(String(e.message || e)));
  page.on("request", (r) => log.requests.push({ method: r.method(), url: r.url() }));
  await page.goto(app.url);
  await expect(page.getByTestId("column-todo")).toBeVisible();
  return log;
}

export const moveRequests = (log) => log.requests.filter((r) => r.method === "POST" && /\/api\/cards\/[^/]+\/move$/.test(new URL(r.url).pathname));
