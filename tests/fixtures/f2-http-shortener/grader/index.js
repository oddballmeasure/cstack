// Held-out grader for the f2-http-shortener fixture (plan section 6.3). Test names are G1..Gn, never lane ids.
// Run: SHORTENER_ENTRY=<repo>/server.mjs node --test --test-reporter=tap <this directory>
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sandbox, start, runToExit, request, expectRes, expectLink, create, sleep, freePort } from "./lib.js";

const NOT_FOUND = { error: "not_found" };
const readData = (file) => JSON.parse(readFileSync(file, "utf8"));

test("G1 /healthz reports ok and the link count; the startup line names the port", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  assert.match(srv.out.stdout, new RegExp(`^listening on ${srv.port}\\r?\\n`), "first stdout line");
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 0 });
  await create(srv, { url: "https://example.com/" });
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 1 });
});

test("G2 PORT=0 listens on a free port and prints it", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { PORT: 0 });
  assert.ok(srv.port > 0, `printed port ${srv.port}`);
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 0 });
});

test("G3 create without a slug returns 201 with a generated 7-character slug", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const url = "https://example.com/a/very/long/path?x=1";
  const before = Date.now();
  const r = await srv.req("POST", "/api/links", { json: { url } });
  expectRes(r, 201);
  assert.match(String(r.headers["content-type"]), /^application\/json; charset=utf-8$/i, "content type");
  expectLink(r.json, { url, hits: 0 }, srv.port);
  assert.match(r.json.slug, /^[A-Za-z0-9]{7}$/, "generated slug shape");
  assert.equal(r.headers.location, `/api/links/${r.json.slug}`, "Location header");
  const at = Date.parse(r.json.created_at);
  assert.ok(at >= before - 5000 && at <= Date.now() + 5000, `created_at ${r.json.created_at} is near now`);
});

test("G4 the same URL twice makes two links with different slugs", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const a = await create(srv, { url: "https://example.com/same" });
  const b = await create(srv, { url: "https://example.com/same" });
  assert.notEqual(a.slug, b.slug, "two different slugs");
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 2 });
});

test("G5 custom slugs: created, 409 when taken, case-sensitive", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const r = await srv.req("POST", "/api/links", { json: { url: "https://example.com/q3", slug: "q3-plan" } });
  expectRes(r, 201);
  expectLink(r.json, { slug: "q3-plan", url: "https://example.com/q3", hits: 0 }, srv.port);
  assert.equal(r.headers.location, "/api/links/q3-plan", "Location header");
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/other", slug: "q3-plan" } }), 409, { error: "slug_taken" });
  const upper = await srv.req("POST", "/api/links", { json: { url: "https://example.com/upper", slug: "Q3-plan" } });
  expectRes(upper, 201);
  assert.equal(upper.json.slug, "Q3-plan");
  expectRes(await srv.req("GET", "/api/links/q3-plan"), 200);
  assert.equal((await srv.req("GET", "/api/links/q3-plan")).json.url, "https://example.com/q3", "the first link is unchanged");
});

test("G6 invalid URLs return 400 invalid_url and create nothing", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const long = "https://example.com/" + "a".repeat(2049 - "https://example.com/".length);
  assert.equal(long.length, 2049);
  for (const body of [{ url: "not a url" }, { url: "ftp://example.com/x" }, { url: "javascript:alert(1)" }, { url: long }, {}, { url: 42 }, { slug: "nourl" }]) {
    expectRes(await srv.req("POST", "/api/links", { json: body }), 400, { error: "invalid_url" });
  }
  const ok2048 = "https://example.com/" + "a".repeat(2048 - "https://example.com/".length);
  expectRes(await srv.req("POST", "/api/links", { json: { url: ok2048 } }), 201);
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 1 });
});

test("G7 invalid slugs return 400 invalid_slug and create nothing", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  for (const slug of ["ab", "a".repeat(33), "has space", "api", "Healthz", "HEALTHZ", 7, "sl/ash", "dot.ted", true]) {
    expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/", slug } }), 400, { error: "invalid_slug" });
  }
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 0 });
  for (const slug of ["abc", "a".repeat(32), "A_b-9"]) expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/", slug } }), 201);
});

test("G8 bad bodies: invalid_json, 415 for a non-JSON type, 413 for a large body", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const asJson = { "Content-Type": "application/json" };
  expectRes(await srv.req("POST", "/api/links", { body: '{"url":', headers: asJson }), 400, { error: "invalid_json" });
  expectRes(await srv.req("POST", "/api/links", { body: "[1,2]", headers: asJson }), 400, { error: "invalid_json" });
  expectRes(await srv.req("POST", "/api/links", { body: '"https://example.com"', headers: asJson }), 400, { error: "invalid_json" });
  expectRes(await srv.req("POST", "/api/links", { body: '{"url":"https://example.com"}', headers: { "Content-Type": "text/plain" } }), 415, { error: "unsupported_media_type" });
  expectRes(await srv.req("POST", "/api/links", { body: '{"url":"https://example.com"}' }), 415, { error: "unsupported_media_type" });
  const big = JSON.stringify({ url: "https://example.com/", pad: "x".repeat(10000 - 40) });
  expectRes(await srv.req("POST", "/api/links", { body: big, headers: asJson }), 413, { error: "payload_too_large" });
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 0 });
  expectRes(await srv.req("POST", "/api/links", { body: '{"url":"https://example.com/cs"}', headers: { "Content-Type": "application/json; charset=utf-8" } }), 201);
});

test("G9 checks run in order; null slug and unknown keys are accepted", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  expectRes(await srv.req("POST", "/api/links", { json: { url: "nope", slug: "x" } }), 400, { error: "invalid_url" });
  expectRes(await srv.req("POST", "/api/links", { body: "nope", headers: { "Content-Type": "text/plain" } }), 415, { error: "unsupported_media_type" });
  await create(srv, { url: "https://example.com/taken", slug: "taken" });
  expectRes(await srv.req("POST", "/api/links", { json: { url: "bad", slug: "taken" } }), 400, { error: "invalid_url" });
  const r = await srv.req("POST", "/api/links", { json: { url: "https://example.com", slug: null, extra: true } });
  expectRes(r, 201);
  expectLink(r.json, { url: "https://example.com", hits: 0 }, srv.port);
  assert.match(r.json.slug, /^[A-Za-z0-9]{7}$/, "generated slug");
});

test("G10 GET /<slug> redirects with 301, Location, Cache-Control: no-store and an empty body", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  await create(srv, { url: "https://example.com/q3", slug: "q3-plan" });
  const r = await srv.req("GET", "/q3-plan");
  expectRes(r, 301, undefined, { Location: "https://example.com/q3", "Cache-Control": "no-store" });
  assert.equal(r.text, "", "empty body");
  await create(srv, { url: "http://example.com/x?y=1#frag", slug: "frag" });
  expectRes(await srv.req("GET", "/frag"), 301, undefined, { Location: "http://example.com/x?y=1#frag" });
});

test("G11 every redirect counts a hit, the query string is ignored", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const made = await create(srv, { url: "https://example.com/q3", slug: "q3-plan" });
  expectRes(await srv.req("GET", "/q3-plan"), 301);
  expectRes(await srv.req("GET", "/q3-plan?utm_source=chat"), 301, undefined, { Location: "https://example.com/q3" });
  expectRes(await srv.req("GET", "/q3-plan"), 301);
  const r = await srv.req("GET", "/api/links/q3-plan");
  expectRes(r, 200);
  expectLink(r.json, { slug: "q3-plan", url: "https://example.com/q3", hits: 3, created_at: made.created_at, short_url: made.short_url });
  expectRes(await srv.req("GET", "/api/links/q3-plan?x=1"), 200);
});

test("G12 unknown slugs and unknown paths return 404 not_found", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  for (const p of ["/nope123", "/api/links/nope123", "/", "/a/b", "/api/nope", "/api", "/api/links/a/b", "/bad.slug"]) {
    expectRes(await srv.req("GET", p), 404, NOT_FOUND);
  }
});

test("G13 unsupported methods return 405 with an Allow header", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  await create(srv, { url: "https://example.com/q3", slug: "q3-plan" });
  const MNA = { error: "method_not_allowed" };
  expectRes(await srv.req("PUT", "/api/links"), 405, MNA, { Allow: "GET, POST" });
  expectRes(await srv.req("POST", "/api/links/q3-plan", { json: {} }), 405, MNA, { Allow: "GET, DELETE" });
  expectRes(await srv.req("DELETE", "/q3-plan"), 405, MNA, { Allow: "GET" });
  expectRes(await srv.req("POST", "/healthz"), 405, MNA, { Allow: "GET" });
  expectRes(await srv.req("GET", "/api/links/q3-plan"), 200);
});

test("G14 GET /api/links lists links in creation order", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  expectRes(await srv.req("GET", "/api/links"), 200, { links: [] });
  for (const slug of ["bbb", "aaa", "ccc"]) {
    await create(srv, { url: `https://example.com/${slug}`, slug });
    await sleep(5);
  }
  const r = await srv.req("GET", "/api/links");
  expectRes(r, 200);
  assert.deepEqual(Object.keys(r.json), ["links"]);
  assert.deepEqual(r.json.links.map((l) => l.slug), ["bbb", "aaa", "ccc"], "creation order");
  for (const l of r.json.links) expectLink(l, { url: `https://example.com/${l.slug}`, hits: 0 }, srv.port);
});

test("G15 delete returns 204, the slug is gone and can be reused", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  await create(srv, { url: "https://example.com/q3", slug: "q3-plan" });
  expectRes(await srv.req("GET", "/q3-plan"), 301);
  const d = await srv.req("DELETE", "/api/links/q3-plan");
  expectRes(d, 204);
  assert.equal(d.text, "", "empty body");
  expectRes(await srv.req("GET", "/q3-plan"), 404, NOT_FOUND);
  expectRes(await srv.req("GET", "/api/links/q3-plan"), 404, NOT_FOUND);
  expectRes(await srv.req("DELETE", "/api/links/q3-plan"), 404, NOT_FOUND);
  const again = await srv.req("POST", "/api/links", { json: { url: "https://example.com/new", slug: "q3-plan" } });
  expectRes(again, 201);
  expectLink(again.json, { slug: "q3-plan", url: "https://example.com/new", hits: 0 });
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 1 });
});

test("G16 links and hits persist across a SIGTERM restart", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const a = await create(srv, { url: "https://example.com/q3", slug: "q3-plan" });
  const b = await create(srv, { url: "https://example.com/gen" });
  expectRes(await srv.req("GET", "/q3-plan"), 301);
  expectRes(await srv.req("GET", "/q3-plan"), 301);
  const stop = await srv.stop("SIGTERM");
  assert.equal(stop.code, 0, `exit after SIGTERM: ${JSON.stringify(stop)}`);
  const data = readData(sb.dataFile);
  assert.equal(data.version, 1, "data file version");
  assert.deepEqual(data.links.map((l) => l.slug).sort(), [a.slug, b.slug].sort(), "data file slugs");
  const srv2 = await start(sb);
  const ra = await srv2.req("GET", "/api/links/q3-plan");
  expectRes(ra, 200);
  expectLink(ra.json, { slug: "q3-plan", url: a.url, created_at: a.created_at, hits: 2 }, srv2.port);
  const rb = await srv2.req("GET", `/api/links/${b.slug}`);
  expectRes(rb, 200);
  expectLink(rb.json, { slug: b.slug, url: b.url, created_at: b.created_at, hits: 0 }, srv2.port);
  expectRes(await srv2.req("GET", `/${b.slug}`), 301, undefined, { Location: "https://example.com/gen" });
});

test("G17 a SIGKILL right after a response loses nothing", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const a = await create(srv, { url: "https://example.com/crash", slug: "crash" });
  expectRes(await srv.req("GET", "/crash"), 301);
  await srv.stop("SIGKILL");
  const srv2 = await start(sb);
  const r = await srv2.req("GET", "/api/links/crash");
  expectRes(r, 200);
  expectLink(r.json, { slug: "crash", url: a.url, created_at: a.created_at, hits: 1 });
});

test("G18 30 concurrent creates are all kept; the file is always complete JSON; no temp files remain", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  let reading = true;
  let reads = 0;
  const badReads = [];
  const reader = (async () => {
    while (reading) {
      let text;
      try {
        text = readFileSync(sb.dataFile, "utf8");
      } catch {
        await sleep(0);
        continue;
      }
      reads++;
      try {
        JSON.parse(text);
      } catch {
        badReads.push(text.slice(0, 120));
      }
      await sleep(0);
    }
  })();
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => srv.req("POST", "/api/links", { json: { url: `https://example.com/${i}`, slug: `con-${i}` } })));
  reading = false;
  await reader;
  for (const r of results) expectRes(r, 201);
  assert.deepEqual(badReads, [], `reads of the data file that were not complete JSON (${reads} reads)`);
  const list = await srv.req("GET", "/api/links");
  assert.equal(list.json.links.length, 30, "links listed");
  assert.equal(readData(sb.dataFile).links.length, 30, "links in the data file");
  assert.deepEqual(readdirSync(sb.dataDir), ["links.json"], "files in the data directory");
});

test("G19 a missing data directory is created on the first change, not at startup", async (t) => {
  const sb = sandbox(t);
  const file = path.join(sb.dir, "deep", "er", "links.json");
  const srv = await start(sb, { DATA_FILE: file });
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 0 });
  assert.equal(existsSync(path.join(sb.dir, "deep")), false, "startup created the data directory");
  await create(srv, { url: "https://example.com/deep", slug: "deep" });
  assert.deepEqual(readData(file).links.map((l) => l.slug), ["deep"], "data file written");
  assert.equal(readdirSync(sb.dataDir).length, 0, "nothing written to the default test data dir");
});

test("G20 with DATA_FILE unset the data goes to data/links.json in the working directory", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { DATA_FILE: null });
  assert.equal(existsSync(path.join(sb.dir, "data")), false, "startup created data/");
  await create(srv, { url: "https://example.com/def", slug: "default" });
  assert.deepEqual(readData(path.join(sb.dir, "data", "links.json")).links.map((l) => l.slug), ["default"]);
});

test("G21 an invalid data file stops startup with exit 1 and is left unchanged", async (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.dataFile, "{not json");
  const r = await runToExit(sb);
  assert.equal(r.code, 1, `exit code. stderr ${JSON.stringify(r.stderr)}`);
  assert.equal(r.stderr.trimEnd(), `error: invalid data file: ${sb.dataFile}`, "stderr");
  assert.equal(readFileSync(sb.dataFile, "utf8"), "{not json", "file unchanged");
  writeFileSync(sb.dataFile, '{"version":1}');
  const r2 = await runToExit(sb);
  assert.equal(r2.code, 1, "a file without a links array also stops startup");
  assert.equal(r2.stderr.trimEnd(), `error: invalid data file: ${sb.dataFile}`, "stderr");
});

test("G22 a seeded data file is served and its hit count continues", async (t) => {
  const sb = sandbox(t);
  const seeded = { slug: "seeded", url: "https://example.org/s", created_at: "2026-01-02T03:04:05.000Z", hits: 5 };
  writeFileSync(sb.dataFile, JSON.stringify({ version: 1, links: [seeded] }));
  const srv = await start(sb);
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 1 });
  expectRes(await srv.req("GET", "/seeded"), 301, undefined, { Location: "https://example.org/s" });
  const r = await srv.req("GET", "/api/links/seeded");
  expectRes(r, 200);
  expectLink(r.json, { ...seeded, hits: 6 }, srv.port);
});

test("G23 rate limit: the 4th create gets 429 with Retry-After; proxy headers and invalid creates do not help", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { RATE_LIMIT: 3, RATE_WINDOW_MS: 1500 });
  await create(srv, { url: "https://example.com/1" });
  expectRes(await srv.req("POST", "/api/links", { json: { url: "bad" } }), 400, { error: "invalid_url" });
  await create(srv, { url: "https://example.com/2" });
  const r = await srv.req("POST", "/api/links", { json: { url: "https://example.com/3" } });
  expectRes(r, 429, { error: "rate_limited" });
  assert.match(String(r.headers["retry-after"]), /^[12]$/, `Retry-After ${r.headers["retry-after"]}`);
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/4" }, headers: { "X-Forwarded-For": "203.0.113.9" } }), 429, { error: "rate_limited" });
  for (let i = 0; i < 5; i++) expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 2 });
  expectRes(await srv.req("GET", "/api/links"), 200);
});

test("G24 rate limit: creates are allowed again once the window has passed", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { RATE_LIMIT: 3, RATE_WINDOW_MS: 1500 });
  for (let i = 0; i < 3; i++) await create(srv, { url: `https://example.com/${i}` });
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/x" } }), 429, { error: "rate_limited" });
  await sleep(1600);
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/after" } }), 201);
  expectRes(await srv.req("GET", "/healthz"), 200, { status: "ok", links: 4 });
});

test("G25 rate limit is per client address", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { RATE_LIMIT: 2, RATE_WINDOW_MS: 60000, HOST: "127.0.0.1" });
  const one = { localAddress: "127.0.0.1" };
  const two = { localAddress: "127.0.0.2" };
  await create(srv, { url: "https://example.com/a1" }, one);
  await create(srv, { url: "https://example.com/a2" }, one);
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/a3" }, ...one }), 429, { error: "rate_limited" });
  await create(srv, { url: "https://example.com/b1" }, two);
  await create(srv, { url: "https://example.com/b2" }, two);
  expectRes(await srv.req("POST", "/api/links", { json: { url: "https://example.com/b3" }, ...two }), 429, { error: "rate_limited" });
});

test("G26 invalid configuration values stop startup with exit 1", async (t) => {
  const sb = sandbox(t);
  const cases = [
    [{ PORT: "abc" }, "error: invalid PORT: abc"],
    [{ PORT: "70000" }, "error: invalid PORT: 70000"],
    [{ RATE_LIMIT: "0" }, "error: invalid RATE_LIMIT: 0"],
    [{ RATE_WINDOW_MS: "1.5" }, "error: invalid RATE_WINDOW_MS: 1.5"],
  ];
  for (const [env, stderr] of cases) {
    const r = await runToExit(sb, env);
    assert.equal(r.code, 1, `${JSON.stringify(env)} exit code. stderr ${JSON.stringify(r.stderr)}`);
    assert.equal(r.stderr.trimEnd(), stderr, `${JSON.stringify(env)} stderr`);
  }
});

test("G27 a port already in use stops startup with exit 1 and an error line", async (t) => {
  const sb = sandbox(t);
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
  t.after(() => blocker.close());
  const r = await runToExit(sb, { PORT: port });
  assert.equal(r.code, 1, `exit code. stderr ${JSON.stringify(r.stderr)}`);
  assert.match(r.stderr, /^error: /m, "stderr has a line starting with error: ");
});

test("G28 BASE_URL sets the short_url prefix and loses one trailing slash", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb, { BASE_URL: "https://sho.rt/" });
  const a = await create(srv, { url: "https://example.com/b", slug: "based" });
  assert.equal(a.short_url, "https://sho.rt/based");
  const r = await srv.req("GET", "/api/links/based");
  assert.equal(r.json.short_url, "https://sho.rt/based");
});

test("G29 SIGTERM exits 0 within 5 s, also with an idle keep-alive connection open", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const stop1 = await srv.stop("SIGTERM");
  assert.equal(stop1.code, 0, `idle SIGTERM: ${JSON.stringify(stop1)}`);
  const srv2 = await start(sb);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  expectRes(await request(srv2.port, "GET", "/healthz", { agent }), 200);
  expectRes(await request(srv2.port, "GET", "/healthz", { agent }), 200);
  const stop2 = await srv2.stop("SIGTERM");
  assert.equal(stop2.code, 0, `SIGTERM with a keep-alive connection: ${JSON.stringify(stop2)}`);
  const srv3 = await start(sb);
  const stop3 = await srv3.stop("SIGINT");
  assert.equal(stop3.code, 0, `SIGINT: ${JSON.stringify(stop3)}`);
});

test("G30 a request in flight at SIGTERM still completes and is persisted", async (t) => {
  const sb = sandbox(t);
  const srv = await start(sb);
  const body = JSON.stringify({ url: "https://example.com/inflight", slug: "inflight" });
  const half = Math.floor(body.length / 2);
  const res = new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/links", agent: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (r) => {
        let text = "";
        r.on("data", (c) => (text += c));
        r.on("end", () => resolve({ status: r.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.write(body.slice(0, half));
    srv.inflight = req;
  });
  await sleep(300);
  const t0 = Date.now();
  srv.proc.kill("SIGTERM");
  await sleep(300);
  srv.inflight.end(body.slice(half));
  const r = await Promise.race([res, sleep(4000).then(() => ({ status: "no response within 4 s" }))]);
  assert.equal(r.status, 201, `in-flight create: ${JSON.stringify(r)}`);
  const exit = await Promise.race([srv.exited, sleep(Math.max(0, 5000 - (Date.now() - t0))).then(() => null)]);
  assert.ok(exit, "server did not exit within 5 s of SIGTERM");
  assert.equal(exit.code, 0, `exit ${JSON.stringify(exit)}`);
  const srv2 = await start(sb);
  expectRes(await srv2.req("GET", "/api/links/inflight"), 200);
});
