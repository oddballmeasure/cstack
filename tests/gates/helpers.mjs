// Test helpers: throwaway git repos with a cstack config, and a runner for gate scripts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const GATES = path.join(ROOT, "gates");
export const FAKE_BIN = path.join(ROOT, "tests/fixtures/bin");
const TEMPLATE = JSON.parse(readFileSync(path.join(ROOT, "templates/config.json"), "utf8"));

export function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
export const git = (cwd, ...args) => sh(cwd, "git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

export function write(root, rel, text, mode) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
  if (mode) chmodSync(p, mode);
}

// The commands run through sh, which Windows (Git for Windows) has too, but not shebang files.
// test.sh passes unless src/broken exists. e2e.sh prints TAP from tests/acceptance/lanes.txt
// lines "E1.1 pass" or "E1.2 fail <message>"; a lane passes if src/<lane id> exists.
export function makeRepo(cfg = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "cstack-gate-"));
  const origin = path.join(base, "origin.git");
  const root = path.join(base, "repo");
  sh(base, "git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh(base, "git", ["clone", "-q", origin, root]);
  git(root, "checkout", "-q", "-b", "main");
  const config = { ...TEMPLATE, autonomy: "stop", repo: "o/r", test_command: ["sh", "./scripts/test.sh"], e2e_command: ["sh", "./scripts/e2e.sh"], ...cfg };
  write(root, ".cstack/config.json", JSON.stringify(config, null, 2));
  write(root, "scripts/test.sh", "#!/bin/sh\n[ -e src/broken ] && { echo 'unit test failed: broken'; exit 1; }\necho 'ok 1 - unit'\n", 0o755);
  write(
    root,
    "scripts/e2e.sh",
    `#!/bin/sh
n=0
while read -r id rest; do
  n=$((n+1))
  if [ -e "src/$id" ]; then echo "ok $n - $id lane"; else
    echo "not ok $n - $id lane"
    echo "  ---"
    echo "  error: |-"
    echo "    expected $id behaviour in tests/acceptance/$id.test.js"
    echo "  ..."
  fi
done < tests/acceptance/lanes.txt
`,
    0o755,
  );
  write(root, "tests/acceptance/lanes.txt", "E1.1\nE1.2\n");
  write(root, "src/app.js", "export const x = 1;\n");
  write(root, ".gitignore", ".cstack/runs/\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "init");
  git(root, "push", "-q", "origin", "main");
  return { base, root, origin, config };
}

export function commit(cwd, files, message) {
  for (const [rel, text] of Object.entries(files)) write(cwd, rel, text);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

export function gate(name, args, { env = {}, cwd = ROOT } = {}) {
  const r = spawnSync(process.execPath, [path.join(GATES, name), ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, CSTACK_ROLE: "", CSTACK_PROGRAM_AUTONOMY: "", ...env },
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

export const failChecks = (res) => (res.json?.findings || []).map((f) => f.check);
export { existsSync, path };
