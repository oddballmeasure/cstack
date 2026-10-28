# shortener: a small self-hosted URL shortener

## Background

Teams that share links in chat, tickets and slides want short links they control. Hosted shorteners track clicks for advertising, expire free links, and put a third-party domain in front of internal URLs. The self-hosted options (YOURLS, Kutt, Shlink) need a database server, a PHP or Docker stack, and an admin UI that nobody on a small team wants to run.

Interviews with four small teams (two agencies, one open-source project, one internal platform team) showed the same short list of needs. Make a short link from a long one, optionally with a readable slug such as `/q3-plan`. Follow the short link with a plain redirect. See how often a link was followed. Remove a link that was shared by mistake. Keep the links across restarts and deploys without a database. Stop a runaway script from filling the store with junk links. Shut down cleanly when the process manager or the container runtime sends SIGTERM, so a deploy never loses a link that was just created.

Every team ran the service behind its own reverse proxy and wanted one process and one data file that could be backed up with `cp`.

## Product

`shortener` is a single Node HTTP server with a JSON API and a redirect endpoint. It keeps every link in one JSON file.

### Running it

- Start: `node server.mjs`. `server.mjs` is at the repository root.
- When the server is listening, it prints exactly one line to stdout: `listening on <port>`, where `<port>` is the actual port (this matters for `PORT=0`). It prints nothing else to stdout before that line.
- Environment variables. An unset or empty variable takes its default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | TCP port. An integer from 0 to 65535. `0` means any free port. |
| `HOST` | `127.0.0.1` | Address to bind. |
| `DATA_FILE` | `data/links.json` | Path of the data file, relative to the working directory unless absolute. |
| `BASE_URL` | `http://127.0.0.1:<port>` | Prefix for `short_url` in responses. One trailing `/` is removed. `<port>` is the actual port. |
| `RATE_LIMIT` | `10` | Creates allowed per client in one window. A positive integer. |
| `RATE_WINDOW_MS` | `60000` | Window length in milliseconds. A positive integer. |

- A variable with a value that breaks its rule (for example `PORT=abc`, `PORT=70000`, `RATE_LIMIT=0`, `RATE_WINDOW_MS=1.5`) stops startup: exit code 1, stderr `error: invalid <NAME>: <value>`.
- A port that is already in use stops startup: exit code 1, one stderr line that starts with `error: `.

### The data file

- UTF-8 JSON with this shape: `{"version":1,"links":[<link>, ...]}`. A link is `{"slug":"q3-plan","url":"https://example.com/plans/q3","created_at":"2026-10-28T09:15:00.000Z","hits":0}`. `created_at` is `Date.prototype.toISOString()` output. `hits` is a non-negative integer. Other keys in the file are allowed and ignored.
- A missing file is an empty store. The server creates the file, and its parent directories, on the first change. Startup alone creates nothing.
- A file that is not valid JSON, or has no `links` array, stops startup: exit code 1, stderr `error: invalid data file: <DATA_FILE>`, with the value as given (or the default). The file is left unchanged.
- Every change (create, delete, and a hit from a redirect) is written to the file before the response is sent. A server killed with SIGKILL right after a response loses nothing that response confirmed.
- Writes are atomic: the server writes a temporary file in the same directory and renames it over the data file. A reader of the data file always sees complete JSON. Concurrent requests never lose an update, and no temporary file is left behind once the responses are sent.

### HTTP conventions

- Every JSON response has `Content-Type: application/json; charset=utf-8` and a JSON body.
- An error body is exactly `{"error":"<code>"}`. The codes are listed with each route.
- A link in a response is the object `{"slug","url","short_url","created_at","hits"}` with exactly these 5 keys. `short_url` is `<BASE_URL>/<slug>`.
- The query string never affects routing. `/q3-plan?utm=x` is `/q3-plan`.
- A path that matches no route: 404 `{"error":"not_found"}`.
- A route hit with a method it does not support: 405 `{"error":"method_not_allowed"}` with an `Allow` header that lists the supported methods, in the order given below, joined by `, `.

### Routes

| Route | Methods | |
|---|---|---|
| `/healthz` | `GET` | Health |
| `/api/links` | `GET, POST` | List and create |
| `/api/links/<slug>` | `GET, DELETE` | Stats and delete |
| `/<slug>` | `GET` | Redirect |

A `<slug>` segment in a path is any non-empty run of `A-Z a-z 0-9 _ -`. Any other path shape (for example `/`, `/a/b`, `/api/nope`, `/api/links/a/b`) is a 404.

**`GET /healthz`** returns 200 `{"status":"ok","links":<count of links>}`.

**`POST /api/links`** creates a link. The request body is JSON: `{"url":"<url>","slug":"<optional slug>"}`. Other keys are ignored. Checks run in this order, and the first failure is the response:

1. Rate limit (below): 429 `{"error":"rate_limited"}`.
2. `Content-Type` is not `application/json` (parameters such as `; charset=utf-8` are allowed): 415 `{"error":"unsupported_media_type"}`.
3. The body is larger than 8192 bytes: 413 `{"error":"payload_too_large"}`.
4. The body is not valid JSON, or is not a JSON object: 400 `{"error":"invalid_json"}`.
5. `url` is missing, not a string, longer than 2048 characters, not parseable by `new URL()`, or its protocol is not `http:` or `https:`: 400 `{"error":"invalid_url"}`.
6. `slug` is present (not `undefined` and not `null`) and is not a string matching `^[A-Za-z0-9_-]{3,32}$`, or it is `api` or `healthz` in any letter case: 400 `{"error":"invalid_slug"}`.
7. `slug` is already used by a link (slugs are case-sensitive): 409 `{"error":"slug_taken"}`.

On success: 201, header `Location: /api/links/<slug>`, body the new link with `hits` 0. The `url` is stored and returned exactly as sent. Without a `slug`, the server generates one: 7 characters from `A-Z a-z 0-9`, generated again on a collision. The same URL sent twice makes two links.

**`GET /api/links`** returns 200 `{"links":[<link>, ...]}`, ordered by `created_at` ascending, then by slug in code-point order.

**`GET /api/links/<slug>`** returns 200 with the link, or 404 `{"error":"not_found"}`.

**`DELETE /api/links/<slug>`** removes the link and returns 204 with an empty body, or 404 `{"error":"not_found"}`. A deleted slug is free to be used again.

**`GET /<slug>`** for a known slug: 301, header `Location: <url>`, header `Cache-Control: no-store`, empty body, and the link's `hits` grows by 1. Unknown slug: 404 `{"error":"not_found"}`.

### Rate limiting

- The limit applies to `POST /api/links` only. Each client may make at most `RATE_LIMIT` create requests in any `RATE_WINDOW_MS` window (a sliding window). Every create request counts, whatever its outcome, except requests answered with 429.
- The client is the TCP peer address (`req.socket.remoteAddress`). `X-Forwarded-For` and similar headers are ignored.
- A request over the limit gets 429 `{"error":"rate_limited"}` and a `Retry-After` header: whole seconds until the client's oldest counted request leaves the window, rounded up, at least 1.
- Rate-limit state is in memory only. A restart clears it.

### Shutdown

- On SIGTERM or SIGINT the server stops accepting new connections, lets requests already received finish with their normal response, and exits with code 0 within 5 seconds.
- Idle keep-alive connections do not delay the exit.
- Everything a finished request changed is in the data file when the process exits.

## Goals

- Create a short link with one `curl` call, with or without a chosen slug.
- Follow a short link with a plain HTTP redirect that a browser or `curl -L` handles.
- See per-link hit counts.
- Keep all links in one JSON file that survives restarts, crashes after a response, and deploys.
- Limit how fast one client can create links.
- Run under systemd, Docker or a process manager: configured by environment, stopped by SIGTERM without losing data.

## Non-goals

- Authentication, users, or per-user links. The service runs behind the team's proxy.
- A web UI.
- Link expiry, editing a link's URL, or custom redirect codes.
- Analytics beyond a hit count (no referrers, user agents or time series).
- Trusting proxy headers for the client address.
- HTTPS termination, HTTP/2, `HEAD` requests, or CORS.
- More than one server process sharing a data file.

## End-to-end requirements

Each one starts the server as `node server.mjs` in an empty temporary working directory, with `PORT` set to a free port, `DATA_FILE` set to `links.json` in a fresh subdirectory of that directory, `RATE_LIMIT=1000`, and other variables unset unless the requirement says otherwise. It waits for the `listening on <port>` line, then makes HTTP requests to `127.0.0.1:<port>` without following redirects. "Returns" means the status code and, for JSON, the parsed body.

1. **Health.** `GET /healthz` returns 200 `{"status":"ok","links":0}`. After one create, it returns `{"status":"ok","links":1}`. The startup line is `listening on <port>` with the chosen port. With `PORT=0`, the line names a real port that answers `/healthz`.
2. **Create with a generated slug.** `POST /api/links` with `{"url":"https://example.com/a/very/long/path?x=1"}` returns 201. The body has exactly the keys `slug`, `url`, `short_url`, `created_at`, `hits`; `slug` matches `^[A-Za-z0-9]{7}$`; `url` is the URL as sent; `short_url` is `http://127.0.0.1:<port>/<slug>`; `created_at` is an ISO timestamp within a few seconds of now; `hits` is 0. `Location` is `/api/links/<slug>`. Content type is `application/json; charset=utf-8`. Two creates of the same URL return two different slugs.
3. **Create with a custom slug.** `{"url":"https://example.com/q3","slug":"q3-plan"}` returns 201 with slug `q3-plan`. A second create with slug `q3-plan` returns 409 `{"error":"slug_taken"}`. A create with slug `Q3-plan` returns 201 (slugs are case-sensitive).
4. **Validation.** Each of these returns 400 with the code shown, and creates nothing: url `not a url`, `ftp://example.com/x`, `javascript:alert(1)`, a 2049-character `https://` URL, url missing, url `42` (all `invalid_url`); slug `ab`, a 33-character slug, `has space`, `api`, `Healthz`, slug `7` (all `invalid_slug`); body `{"url":` and body `[1,2]` (both `invalid_json`). A body with `Content-Type: text/plain` returns 415 `{"error":"unsupported_media_type"}`. A 10000-byte JSON body returns 413 `{"error":"payload_too_large"}`. A body with both a bad url and a bad slug returns `invalid_url`. `{"url":"https://example.com","slug":null,"extra":true}` returns 201 with a generated slug.
5. **Redirect and hits.** After creating `q3-plan`, `GET /q3-plan` returns 301 with `Location: https://example.com/q3`, `Cache-Control: no-store` and an empty body. After 3 such requests (one of them `GET /q3-plan?utm_source=chat`), `GET /api/links/q3-plan` returns 200 with `hits` 3 and the other fields as created.
6. **Unknown slug and unknown paths.** `GET /nope123` and `GET /api/links/nope123` return 404 `{"error":"not_found"}`. So do `GET /`, `GET /a/b` and `GET /api/nope`.
7. **Method not allowed.** `PUT /api/links` returns 405 `{"error":"method_not_allowed"}` with `Allow: GET, POST`. `POST /api/links/q3-plan` returns 405 with `Allow: GET, DELETE`. `DELETE /q3-plan` returns 405 with `Allow: GET`. `POST /healthz` returns 405 with `Allow: GET`.
8. **List.** After creating slugs `bbb` then `aaa` then `ccc`, `GET /api/links` returns 200 with the three links in creation order (`bbb`, `aaa`, `ccc`), each with the 5 link keys.
9. **Delete.** `DELETE /api/links/q3-plan` returns 204 with an empty body. Then `GET /q3-plan` and `GET /api/links/q3-plan` return 404, and a new create with slug `q3-plan` returns 201 with `hits` 0. A second `DELETE` of a missing slug returns 404 `{"error":"not_found"}`.
10. **Persistence across a restart.** Create two links (one custom slug), follow one twice, delete nothing, stop the server with SIGTERM, then start it again on the same `DATA_FILE`. Both links are still there with the same slug, url and `created_at`, and the followed one has `hits` 2. The data file parses as `{"version":1,"links":[...]}` with both links.
11. **Crash safety.** Create a link, follow it once, then kill the server with SIGKILL. A new server on the same `DATA_FILE` has the link with `hits` 1.
12. **Atomic, lossless writes.** 30 creates sent at the same time all return 201. While they run, every read of the data file that succeeds parses as JSON. Afterwards `GET /api/links` lists 30 links, the data file holds 30 links, and the data file's directory holds only `links.json`.
13. **Data file edge cases.** With a `DATA_FILE` in a directory that does not exist yet, startup creates nothing, and the first create makes the directory and the file. With `DATA_FILE` unset, the first create writes `data/links.json` in the working directory. A data file holding `{not json` makes startup exit 1 with stderr `error: invalid data file: <DATA_FILE>`, and the file keeps its content. A seeded data file with link `seeded` (url `https://example.org/s`, hits 5) serves `GET /seeded` as a 301 and then reports `hits` 6.
14. **Rate limit.** With `RATE_LIMIT=3` and `RATE_WINDOW_MS=1500`: 3 creates return 201; the 4th returns 429 `{"error":"rate_limited"}` with a `Retry-After` of 1 or 2; a 4th with a different `X-Forwarded-For` also returns 429; an invalid create still counts toward the limit; `GET` requests are never limited. After 1.6 seconds without creates, a create returns 201 again.
15. **Rate limit per client.** With `RATE_LIMIT=2` and `RATE_WINDOW_MS=60000` and `HOST=127.0.0.1`, a client connecting from local address `127.0.0.1` is limited after 2 creates, while a client connecting from local address `127.0.0.2` can still create 2 links.
16. **Configuration errors.** `PORT=abc` exits 1 with stderr `error: invalid PORT: abc`. `RATE_LIMIT=0` exits 1 with stderr `error: invalid RATE_LIMIT: 0`. A port already in use exits 1 with a stderr line that starts with `error: `. `BASE_URL=https://sho.rt/` makes `short_url` `https://sho.rt/<slug>`.
17. **Graceful shutdown.** SIGTERM with no requests in flight exits with code 0 within 5 seconds, also while an idle keep-alive connection is open. A create whose headers were sent but whose body had not finished when SIGTERM arrived still returns 201 once the body is sent, the server then exits with code 0, and a restarted server lists that link.

## Constraints

- Node 22 or later. No runtime or dev dependencies: `package.json` has no `dependencies` or `devDependencies`. Use `node:http`, `node:fs`, `node:crypto` and the rest of the standard library.
- The entry point is `server.mjs` at the repository root, an ES module. `npm start` runs it.
- Tests use `node:test`. `npm test` runs them and exits 0. Tests start real servers on free ports (`PORT=0`) and never use a fixed port.
- The server makes no outbound network requests and writes only the data file and its temporary files.

## Done

Done when all 17 end-to-end requirements above pass against `server.mjs` at the base branch head, and `npm test` exits 0.
