# Plan: notes CLI

<!--
Format checked by gates/check-plan.mjs together with units.tsv, spec.md and e2e-plan.md.

units.tsv is the source of truth for units. It is tab-separated with this header row:
  id track state branch pr sha issue depends_on lanes brief
- id is U<n> and unique. depends_on and lanes are comma lists without spaces (depends_on may be empty).
- Every unit lists at least one lane from e2e-plan.md. Every lane is assigned to at least one unit.
- Requirement coverage comes from lanes: a unit covers R when one of its lanes has R in Covers.
  Do not repeat requirement ids here. Every R in the spec must be covered by some unit.
- depends_on names existing units and has no cycles.

plan.md has one "## U<n> <title>" section per unit row, and no section for a unit that is not a row.
Each section has:
  Files: inline comma list, or "- path" lines below it
  Verify: inline command, or numbered steps below it
  Size: S | M | L
Prose between fields is fine. This example matches templates/spec.md. Replace all of it.
-->

Order: U1, then U2. U2 needs the note store that U1 creates.

## U1 Add and list notes

Store notes in `$NOTES_HOME/notes.json` and wire `add` and `list`.

Files:
- bin/notes.mjs
- src/store.mjs
- test/store.test.mjs
Verify: `npm test`, then lanes E1.1, E1.2 and E1.3 through `run-e2e.mjs`.
Size: M

## U2 Remove notes

Files: src/store.mjs, bin/notes.mjs, test/rm.test.mjs
Verify:
1. `npm test`
2. Lanes E2.1 and E2.2 through `run-e2e.mjs`.
Size: S
