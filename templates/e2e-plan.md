# E2E plan: notes CLI

<!--
Format checked by gates/check-e2e.mjs against spec.md and .cstack/config.json.
- Keep the three "## " headings: Lanes, Red check, Mutation spot-check.
- One "### E<n>.<m> <title>" block per lane under "## Lanes". E<n> is the spec E requirement it tests.
  Fields, one per line:
    Kind: positive | negative
    Covers: R ids, a subset of the Covers line of E<n> in the spec
    Driver: cli | http | browser | library
    Script: followed by numbered steps "1. ...", written from the user's point of view
    Evidence: a path under /tmp/cstack-e2e/ (use <run> for the run id)
    Pass when: one predicate with a number or an `exact value`
- Every E has at least one lane. Every R has at least one negative lane.
- Red check: one row per lane from running the suite on the current base.
  Result is FAIL for every lane. PASS means "already passing", ERROR means "broken test". Both reject.
- Mutation spot-check: at least max(2, ceil(20% of lanes)) distinct lanes. Break says what you broke
  in a scratch copy of the reference behaviour. Caught is yes on every row.
- config e2e_command must be set.
This example matches templates/spec.md. Replace all of it.
-->

Suite: `tests/acceptance/notes.test.mjs`. Test names start with the lane id.

## Lanes

### E1.1 Add two notes and list them

Kind: positive
Covers: R1, R2
Driver: cli
Script:
1. Run `notes add "buy milk"` with an empty `NOTES_HOME`.
2. Run `notes add "call bob"`.
3. Run `notes list`.
Evidence: /tmp/cstack-e2e/<run>/E1.1.log
Pass when: `notes list` prints exactly `1. buy milk` then `2. call bob` and exits 0.

### E1.2 Add an empty note

Kind: negative
Covers: R1
Driver: cli
Script:
1. Run `notes add ""`.
Evidence: /tmp/cstack-e2e/<run>/E1.2.log
Pass when: the command exits 2 and stderr is `note text is empty`.

### E1.3 List with no notes

Kind: negative
Covers: R2
Driver: cli
Script:
1. Run `notes list` with an empty `NOTES_HOME`.
Evidence: /tmp/cstack-e2e/<run>/E1.3.log
Pass when: stdout is exactly `no notes` and the exit code is 0.

### E2.1 Remove a note

Kind: positive
Covers: R2, R3
Driver: cli
Script:
1. Run `notes add "buy milk"` and `notes add "call bob"`.
2. Run `notes rm 1`.
3. Run `notes list`.
Evidence: /tmp/cstack-e2e/<run>/E2.1.log
Pass when: `notes list` prints exactly `2. call bob` and exits 0.

### E2.2 Remove an unknown note

Kind: negative
Covers: R3
Driver: cli
Script:
1. Run `notes rm 7` with an empty `NOTES_HOME`.
Evidence: /tmp/cstack-e2e/<run>/E2.2.log
Pass when: the command exits 1 and stderr is `no such note: 7`.

## Red check

| Lane | Result | Reason |
|---|---|---|
| E1.1 | FAIL | `notes: command not found` |
| E1.2 | FAIL | `notes: command not found` |
| E1.3 | FAIL | `notes: command not found` |
| E2.1 | FAIL | `notes: command not found` |
| E2.2 | FAIL | `notes: command not found` |

## Mutation spot-check

| Lane | Break | Caught |
|---|---|---|
| E1.1 | `list` prints newest first | yes |
| E2.2 | `rm` of an unknown id exits 0 | yes |
