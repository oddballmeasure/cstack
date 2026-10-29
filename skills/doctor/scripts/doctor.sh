#!/bin/sh
# cstack doctor: read-only health check of a target repo.
# Usage: doctor.sh [--offline] [repo-dir]
# Prints one line per check: PASS|WARN|FAIL <check>: <detail>. Exit 1 if any FAIL.
# --offline skips every check that calls GitHub.
set -u

offline=0
if [ "${1:-}" = "--offline" ]; then offline=1; shift; fi
dir=${1:-.}
here=$(cd "$(dirname "$0")" && pwd)
plugin_root=$(cd "$here/../../.." && pwd)
fails=0

pass() { printf 'PASS %s: %s\n' "$1" "$2"; }
warn() { printf 'WARN %s: %s\n' "$1" "$2"; }
fail() { printf 'FAIL %s: %s\n' "$1" "$2"; fails=$((fails + 1)); }

# Tools
for t in git jq node; do
  if command -v "$t" >/dev/null 2>&1; then pass "tool $t" "$(command -v "$t")"; else fail "tool $t" "not on PATH"; fi
done
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ]; then pass "node version" "v$major"; else fail "node version" "v$major is below 22 (hooks need path.matchesGlob)"; fi
fi
if [ "$offline" -eq 0 ]; then
  if ! command -v gh >/dev/null 2>&1; then fail "tool gh" "not on PATH"
  elif gh auth status >/dev/null 2>&1; then pass "gh auth" "logged in"
  else fail "gh auth" "not logged in (run gh auth login)"; fi
fi

# Repo
if ! root=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null); then
  fail "git repo" "$dir is not inside a git repository"
  printf '%s\n' "doctor: $fails failed"
  exit 1
fi
pass "git repo" "$root"

cfg="$root/.cstack/config.json"
if [ ! -f "$cfg" ]; then
  fail "config" ".cstack/config.json not found (run the setup-cstack skill)"
  printf '%s\n' "doctor: $fails failed"
  exit 1
fi
if ! jq empty "$cfg" 2>/dev/null; then
  fail "config" ".cstack/config.json does not parse"
  printf '%s\n' "doctor: $fails failed"
  exit 1
fi
pass "config" "parses"

# Schema. Each jq expression prints an error string, or nothing when the field is valid.
schema_errors=$(jq -r '
  def need(cond; msg): if cond then empty else msg end;
  need(.version == 1; "version must be 1"),
  need((.repo | type) == "string" and (.repo | test("^[^/]+/[^/]+$")) and .repo != "owner/name"; "repo must be owner/name"),
  need((.base_branch | type) == "string" and (.base_branch | length) > 0; "base_branch must be a non-empty string"),
  need((.test_command | type) == "array" and (.test_command | length) > 0 and all(.test_command[]; type == "string"); "test_command must be a non-empty array of strings"),
  need(.setup_command == null or ((.setup_command | type) == "array" and (.setup_command | length) > 0); "setup_command must be null or a non-empty array"),
  need(.e2e_command == null or ((.e2e_command | type) == "array" and (.e2e_command | length) > 0); "e2e_command must be null or a non-empty array"),
  need((.required_checks | type) == "array"; "required_checks must be an array"),
  need((.paths_off_limits | type) == "array"; "paths_off_limits must be an array"),
  need((.paths_hidden | type) == "array"; "paths_hidden must be an array"),
  need(.permissions_allow == null or ((.permissions_allow | type) == "array" and all(.permissions_allow[]; type == "string" and test("^[A-Za-z]+(\\(.+\\))?$"))); "permissions_allow must be an array of permission rules such as Bash(make check)"),
  need((.label_prefix | type) == "string" and (.label_prefix | test("^[a-z][a-z0-9-]*$")); "label_prefix must be lowercase letters, digits or dashes"),
  need(.autonomy == "stop" or .autonomy == "send"; "autonomy must be stop or send"),
  need((.parallel | type) == "number" and .parallel >= 1 and .parallel <= 8; "parallel must be 1 to 8"),
  need((.models | type) == "object"; "models must be an object"),
  (.models // {} | ["code","judge","review","gather"][] as $r
     | need((.[$r] // "") | IN("opus","sonnet","haiku","fable","inherit"); "models.\($r) must be opus, sonnet, haiku, fable or inherit")),
  (.limits // {} | ["coder_attempts","verify_rounds","ci_repair_rounds","base_sync_rounds","review_rounds","test_timeout_seconds","ci_timeout_seconds"][] as $k
     | need((.[$k] | type) == "number" and .[$k] >= 1; "limits.\($k) must be a number >= 1")),
  need(.retry_after_hours == null or ((.retry_after_hours | type) == "number" and .retry_after_hours >= 24); "retry_after_hours must be null or a number >= 24"),
  (if .scout == null then empty
   elif (.scout | type) != "object" then "scout must be an object or null"
   else .scout | (
     def int(lo; hi): type == "number" and . == floor and . >= lo and . <= hi;
     def rate: type == "number" and . >= 0 and . <= 1;
     need(.autonomy == null or .autonomy == "propose" or .autonomy == "auto"; "scout.autonomy must be propose or auto"),
     need(.categories == null or ((.categories | type) == "array" and (.categories | length) > 0 and all(.categories[]; IN("bug","regression","docs","enhancement","feature"))); "scout.categories must be a non-empty list of bug, regression, docs, enhancement, feature"),
     need(.areas_per_pass == null or (.areas_per_pass | int(1; 6)); "scout.areas_per_pass must be an integer 1 to 6"),
     need(.cooldown_days == null or ((.cooldown_days | type) == "number" and .cooldown_days >= 0); "scout.cooldown_days must be a number >= 0"),
     need(.max_proposals_per_pass == null or (.max_proposals_per_pass | int(1; 10)); "scout.max_proposals_per_pass must be an integer 1 to 10"),
     need(.max_files == null or (.max_files | int(1; 10)); "scout.max_files must be an integer 1 to 10"),
     need(.repro == null or (.repro | type) == "boolean"; "scout.repro must be true or false"),
     need(.auto_min_decided == null or (.auto_min_decided | int(1; 100000)); "scout.auto_min_decided must be an integer >= 1"),
     need(.auto_min_approval == null or (.auto_min_approval | rate); "scout.auto_min_approval must be 0 to 1"),
     need(.auto_min_done == null or (.auto_min_done | rate); "scout.auto_min_done must be 0 to 1"),
     (keys - ["autonomy","categories","areas_per_pass","cooldown_days","max_proposals_per_pass","max_files","repro","auto_min_decided","auto_min_approval","auto_min_done"] | .[] | "unknown key scout.\(.)"))
   end),
  (if .deploy == null then empty
   elif (.deploy | type) != "object" then "deploy must be an object or null"
   else .deploy | (
     need(.transport == "local" or .transport == "ssh"; "deploy.transport must be local or ssh"),
     need(.transport != "local" or ((.local_directory | type) == "string" and (.local_directory | length) > 0); "deploy.local_directory is required for transport local"),
     need(.local_directory == null or (.local_directory | type) == "string"; "deploy.local_directory must be a string"),
     need(.auto == null or (.auto | type) == "boolean"; "deploy.auto must be true or false"),
     (keys - ["transport","local_directory","auto"] | .[] | "unknown key deploy.\(.)"))
   end),
  (keys - ["version","repo","base_branch","setup_command","test_command","e2e_command","required_checks","paths_off_limits","paths_hidden","permissions_allow","label_prefix","autonomy","parallel","models","limits","retry_after_hours","scout","deploy"]
     | .[] | "unknown key \(.)")
' "$cfg")
if [ -n "$schema_errors" ]; then
  printf '%s\n' "$schema_errors" | while IFS= read -r e; do printf 'FAIL config schema: %s\n' "$e"; done
  fails=$((fails + $(printf '%s\n' "$schema_errors" | wc -l)))
else
  pass "config schema" "all keys valid"
fi

# Commands resolve. A repo-relative path (contains /) must be an executable file under the repo root.
check_cmd() {
  label=$1; exe=$2
  [ -z "$exe" ] && return
  case "$exe" in
    */*) if [ -x "$root/$exe" ] || [ -x "$exe" ]; then pass "$label" "$exe"; else fail "$label" "$exe is not an executable file"; fi ;;
    *) if command -v "$exe" >/dev/null 2>&1; then pass "$label" "$exe on PATH"; else fail "$label" "$exe not on PATH"; fi ;;
  esac
}
check_cmd "test_command" "$(jq -r '.test_command[0] // empty' "$cfg")"
check_cmd "setup_command" "$(jq -r '.setup_command[0] // empty' "$cfg")"
check_cmd "e2e_command" "$(jq -r '.e2e_command[0] // empty' "$cfg")"

# Run store
if git -C "$root" check-ignore -q .cstack/runs/x && git -C "$root" check-ignore -q .cstack/profile.json; then pass "gitignore" "local cstack state is ignored"
else warn "gitignore" ".cstack/runs/ or .cstack/profile.json is not ignored (setup adds .cstack/* and !.cstack/config.json)"; fi
if mkdir -p "$root/.cstack/runs" 2>/dev/null && [ -w "$root/.cstack/runs" ]; then pass "run store" ".cstack/runs is writable"
else fail "run store" ".cstack/runs is not writable"; fi

# Hooks: the guard blocks a known-bad call
guard="$plugin_root/hooks/scripts/guard.mjs"
if [ -f "$guard" ]; then
  # The guard acts only in a cstack context; the CSTACK_RUN marker gives the probe one from any cwd.
  if printf '%s' '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 1"},"cwd":"/"}' | CSTACK_RUN=doctor-self-test node "$guard" >/dev/null 2>&1; then
    fail "hooks" "guard did not block a direct merge"
  else
    pass "hooks" "guard self-test blocks a direct merge"
  fi
else
  fail "hooks" "guard not found at $guard"
fi
# Codex runs plugin hooks only once they are trusted, and skips them silently otherwise (ADR-010). The guard
# leaves a mark for each Codex session it sees in a cstack context, including the call that started this script.
if [ -n "${CODEX_SESSION_ID:-}" ]; then
  if [ -e "$(node -p 'require("os").tmpdir()')/cstack-hook-seen/$CODEX_SESSION_ID" ]; then
    pass "hooks (codex)" "the guard runs in this Codex session"
  else
    fail "hooks (codex)" "the guard did not run in this Codex session: trust cstack's hooks once in /hooks, then run doctor again"
  fi
fi

# GitHub
if [ "$offline" -eq 0 ]; then
  repo=$(jq -r .repo "$cfg"); base=$(jq -r .base_branch "$cfg"); prefix=$(jq -r .label_prefix "$cfg")
  if gh repo view "$repo" --json name >/dev/null 2>&1; then pass "github repo" "$repo"; else fail "github repo" "cannot view $repo"; fi
  if gh api "repos/$repo/branches/$base" >/dev/null 2>&1; then pass "base branch" "$base exists on $repo"; else fail "base branch" "$base not found on $repo"; fi
  labels=$(gh label list --repo "$repo" --limit 500 --json name --jq '.[].name' 2>/dev/null || true)
  missing=""
  for l in ready in-progress done error needs-human investigate proposed; do
    printf '%s\n' "$labels" | grep -qx "$prefix:$l" || missing="$missing $prefix:$l"
  done
  if [ -z "$missing" ]; then pass "labels" "all $prefix:* labels exist"; else fail "labels" "missing:$missing (run the setup-cstack skill)"; fi
  if [ "$(jq '.required_checks | length' "$cfg")" -eq 0 ]; then warn "required checks" "none configured; the merge gate will not wait for CI"; fi
fi

if [ "$fails" -gt 0 ]; then printf '%s\n' "doctor: $fails failed"; exit 1; fi
printf '%s\n' "doctor: ok"
