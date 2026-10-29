import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeRepo, gate, commit, git, write, FAKE_BIN, ROOT, path } from "./helpers.mjs";

const SSH_BIN = path.join(ROOT, "tests/fixtures/bin-ssh");
const SCRIPT = 'echo "$DEPLOY_HOST" > host.txt\necho ok > status.txt\necho deployed\n';

function deployRepo(deploy, { files } = {}) {
  const r = makeRepo();
  const local = path.join(r.base, "local");
  const remote = path.join(r.base, "remote");
  mkdirSync(remote);
  const spec = (o = {}) => ({
    host: "app.example",
    user: "deploy",
    working_directory: remote,
    deploy_timeout_seconds: 5,
    health: { command: "cat status.txt", expected_stdout: "ok\n", timeout_seconds: 2, interval_seconds: 0.05 },
    ...o,
  });
  const setDeploy = (d) => {
    const cfgFile = path.join(r.root, ".cstack/config.json");
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    if (d === undefined) delete cfg.deploy;
    else cfg.deploy = typeof d === "function" ? d(local) : d;
    writeFileSync(cfgFile, JSON.stringify(cfg));
  };
  setDeploy(deploy);
  const ship = (f) => {
    const sha = commit(r.root, f, "deploy files");
    git(r.root, "push", "-q", "origin", "main");
    return sha;
  };
  const sha = ship(files ?? { "deploy.sh": SCRIPT, "deploy.json": JSON.stringify(spec()) });
  const log = path.join(r.base, "ssh.log");
  const run = (args, env = {}) => gate("deploy.mjs", [...args, "--repo-dir", r.root, "--json"], { env: { PATH: `${SSH_BIN}${path.delimiter}${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_SSH_LOG: log, ...env } });
  return { ...r, local, remote, spec, ship, sha, run, setDeploy, log };
}

const LOCAL = (dir) => ({ transport: "local", local_directory: dir });
const detail = (res, check) => [...res.json.findings, ...res.json.passes].find((f) => f.check === check)?.detail;

test("deploy usage errors exit 2", () => {
  const d = deployRepo(LOCAL);
  assert.equal(gate("deploy.mjs", []).code, 2);
  assert.equal(d.run(["nope-not-a-sha"]).code, 2);
  assert.equal(gate("deploy.mjs", [d.sha, "--plan"], { cwd: d.root }).code, 0, "the repo defaults to the working directory");
  d.setDeploy(undefined);
  assert.match(d.run([d.sha]).err, /no deploy object/);
  d.setDeploy(null);
  assert.equal(d.run([d.sha]).code, 2);
  d.setDeploy({ transport: "local" });
  assert.match(d.run([d.sha]).err, /needs deploy.local_directory/);
});

test("deploy runs only merged revisions with a valid committed pair", () => {
  const d = deployRepo(LOCAL);
  git(d.root, "checkout", "-q", "-b", "side");
  const side = commit(d.root, { "x.txt": "x\n" }, "side");
  const notMerged = d.run([side, "--plan"]);
  assert.equal(notMerged.code, 1);
  assert.match(detail(notMerged, "merged"), /is not on origin\/main/);
  git(d.root, "checkout", "-q", "main");
  const cases = [
    [{ "deploy.sh": null, "deploy.json": null }, /no co-located deploy.sh and deploy.json/],
    [{ "deploy/deploy.sh": SCRIPT, "deploy/deploy.json": JSON.stringify(d.spec()), "deploy.sh": SCRIPT }, /ambiguous deploy layout/],
    [{ "deploy.sh": null, "deploy/deploy.json": "{nope" }, /deploy\/deploy.json does not parse/],
    [{ "deploy/deploy.json": "[]" }, /must be an object/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ host: "-bad" })) }, /host must be/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ host: undefined })) }, /host must be/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ user: undefined })) }, /user must be/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ port: 70000 })) }, /port must be 1-65535/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ working_directory: "" })) }, /working_directory/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ deploy_timeout_seconds: 0 })) }, /deploy_timeout_seconds/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ health: undefined })) }, /health.command/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ health: { command: "x", expected_stdout: "  " } })) }, /expected_stdout/],
    [{ "deploy/deploy.json": JSON.stringify(d.spec({ health: { command: "x", expected_stdout: "ok", timeout_seconds: 1 } })) }, /interval_seconds/],
  ];
  for (const [files, re] of cases) {
    for (const [f, text] of Object.entries(files)) {
      if (text === null) rmSync(path.join(d.root, f), { force: true });
      else write(d.root, f, text);
    }
    git(d.root, "add", "-A");
    git(d.root, "commit", "-qm", "variant", "--allow-empty");
    git(d.root, "push", "-q", "origin", "main");
    const res = d.run(["HEAD", "--plan"]);
    assert.equal(res.code, 1, res.out + res.err);
    assert.match(detail(res, "deploy files"), re);
  }
  write(d.root, "deploy/deploy.json", JSON.stringify(d.spec({ port: 2222 })));
  const nested = d.ship({ "deploy/deploy.sh": SCRIPT });
  const plan = d.run([nested, "--plan"]);
  assert.equal(plan.code, 0, plan.out + plan.err);
  assert.equal(plan.json.status, "plan");
  assert.match(detail(plan, "deploy files"), /^deploy\/deploy.sh/);
  assert.match(detail(plan, "target"), /^local .*local, health `cat status.txt` expecting "ok"/);
  assert.ok(!existsSync(path.join(d.root, ".cstack/deploys")), "a plan runs nothing");
});

test("deploy needs a person's approval unless deploy.auto, then runs once and polls health", () => {
  const d = deployRepo(LOCAL);
  const refused = d.run([d.sha]);
  assert.equal(refused.code, 1);
  assert.match(detail(refused, "approval"), /a person must approve/);
  const ok = d.run([d.sha, "--approved"]);
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(ok.json.status, "healthy");
  assert.equal(readFileSync(path.join(d.local, "host.txt"), "utf8"), "app.example\n");
  const result = JSON.parse(readFileSync(ok.json.result, "utf8"));
  assert.equal(result.deployed_revision, d.sha);
  assert.equal(result.script.stdout, "deployed\n");
  assert.match(detail(ok, "health"), /healthy after 1 polls/);
  rmSync(path.join(d.local, "status.txt"));
  const again = d.run([d.sha, "--approved"]);
  assert.equal(again.code, 0);
  assert.match(detail(again, "once"), /already deployed: healthy/);
  assert.ok(!existsSync(path.join(d.local, "status.txt")), "the script did not run twice");
  const auto = deployRepo((dir) => ({ ...LOCAL(dir), auto: true }));
  const a = auto.run([auto.sha]);
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(detail(a, "approval"), "config deploy.auto is true");
});

test("deploy reports a failed script, a timeout, an unhealthy service and an interrupted run", () => {
  const failing = (script, spec = {}) => {
    const d = deployRepo(LOCAL, { files: { "deploy.sh": script, "deploy.json": "{}" } });
    const sha = d.ship({ "deploy.json": JSON.stringify(d.spec(spec)) });
    return { d, res: d.run([sha, "--approved"]) };
  };
  const loud = failing("echo boom >&2\nexit 4\n").res;
  assert.equal(loud.code, 1);
  assert.equal(loud.json.status, "script_failed");
  assert.equal(detail(loud, "script"), "exit 4: boom");
  const quiet = failing("echo just stdout\nexit 3\n").res;
  assert.equal(detail(quiet, "script"), "exit 3: just stdout");
  const slow = failing("sleep 5\n", { deploy_timeout_seconds: 0.3 }).res;
  assert.equal(detail(slow, "script"), "exit 124: command timed out");
  const { d, res: sick } = failing("echo starting > status.txt\n", { health: { command: "cat status.txt", expected_stdout: "ok", timeout_seconds: 0.6, interval_seconds: 0.1 } });
  assert.equal(sick.code, 1);
  assert.equal(sick.json.status, "health_timeout");
  assert.match(detail(sick, "health"), /not healthy after \d+ polls in 0.6s; last stdout "starting"/);
  assert.ok(JSON.parse(readFileSync(sick.json.result, "utf8")).health_observations.length > 1);
  const again = d.run(["HEAD", "--approved"]);
  assert.match(detail(again, "once"), /already deployed: health_timeout/);
  assert.equal(again.code, 1);
  const marker = path.join(d.root, ".cstack/deploys");
  const head = git(d.root, "rev-parse", "HEAD");
  writeFileSync(path.join(marker, `${head}.json`), JSON.stringify({ revision: head, status: "running", started: "2026-10-28T00:00:00Z" }));
  const stuck = d.run(["HEAD", "--approved"]);
  assert.equal(stuck.code, 1);
  assert.match(detail(stuck, "once"), /never finished; check the host/);
});

test("deploy over ssh pins the host, port and directory from deploy.json", () => {
  const d = deployRepo({ transport: "ssh", auto: false });
  const res = d.run([d.sha, "--approved"]);
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(readFileSync(path.join(d.remote, "host.txt"), "utf8"), "app.example\n");
  const calls = readFileSync(d.log, "utf8").trim().split("\n");
  assert.match(calls[0], /^-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -p 22 deploy@app.example cd '.*remote' && DEPLOY_HOST='app.example' bash -se$/);
  assert.match(calls[1], /bash -c 'cat status.txt'$/);
  assert.match(detail(res, "target"), /^deploy@app.example:/);
  const sha = d.ship({ "deploy.json": JSON.stringify(d.spec({ port: 2222, working_directory: `${d.remote}/it's here` })) });
  mkdirSync(`${d.remote}/it's here`);
  const quoted = d.run([sha, "--approved"]);
  assert.equal(quoted.code, 0, quoted.out + quoted.err);
  assert.match(readFileSync(d.log, "utf8"), /-p 2222 deploy@app.example cd '.*it'\\''s here'/);
});
