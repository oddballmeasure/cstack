# ADR-014: Plain git as a forge (forge phase F4)

Date: 2026-10-30. Decided by Monty: plain git with any remote, or none; other forges later on request.

## Decision

`gates/lib/forge-local.mjs` serves every forge verb with no server. Its records live in the repo's main checkout, under `.cstack/forge/` (ignored by the `.cstack/*` rule), and all of the repo's worktrees share them:
- **Issues and change requests:** one JSON file each, numbered from one sequence under a `mkdir` lock.
- **A change** is a branch plus its record. Its head is origin's copy of the branch when there is a remote, else the local branch.
  - Its merge state comes from `git merge-tree --write-tree`: exit 1 means `conflict`.
  - Its `behind` count is `git rev-list --count head..base`, which is information only.
- **CI** is config `ci_command`, one check named `ci`.
  - It runs once per SHA, in a clean detached worktree, and the verdict is recorded in `.cstack/forge/checks/<sha>.json`.
  - Every later gate reads that record, so no model reports CI.
  - A rerun deletes the record and runs `ci_command` again.
- **Merge** is the merge gate's own: `git merge --no-ff` of exactly the judged head, in a worktree of its own, onto the base it read.
  - With a remote, it then runs `git push --force-with-lease=<base>:<judged base> origin HEAD:refs/heads/<base>`, so a moved base refuses the merge.
  - With no remote, it runs `git update-ref` with the old value, which is atomic.
- **The guard's `no-admin-merge`** now also blocks a session's `git push` or `git update-ref` of the base branch, on every forge. With the local forge, that would be the only way to merge past the gate.
- **Doctor:**
  - requires `ci_command` when `forge` is `local`;
  - checks that the command resolves;
  - warns when `required_checks` lacks `ci`.
- **Setup** sets `ci_command` (default: the test command) and `required_checks: ["ci"]`, and skips labels, which are plain strings here.

## Consequences

- Green means `ci_command` passed on this machine in a clean checkout. That is weaker than server-side CI: there is no isolation from the host and no second machine. The README says so.
- The records are per checkout. Two machines working one remote do not share issues or change requests.
- There are no review bots and no approvals. The cstack review loop and the ledger verdict are the review, as on every forge.
- Without a server, a merge that crashes between the merge commit and its record leaves the record open. The next merge attempt sees the head already contained in the base and fails safely. A person closes the record.
