# Spec: notes CLI

<!--
Format checked by gates/check-spec.mjs. Keep every "## " heading below, spelled exactly.
- Every section has content. Write "None." when a section has nothing to say.
- Requirements: one line each, "- R<n>: <one observable behaviour>". Number from R1 with no gaps.
- E2E requirements: "- E<n>: <user-visible flow>" then an indented "Covers: R1, R3" line.
  Number from E1 with no gaps. Every R appears in at least one Covers line.
- Done predicate: falsifiable. Name a number or an `exact value`, and say "pass" or "when".
- No placeholder words left in the text (the gate rejects TBD and TODO outside comments).
This example describes a tiny notes CLI. Replace all of it.
-->

## Problem

People keep short notes in scattered text files. They need one command to add, list and remove notes.

## Users

- A developer who works in a terminal all day.

## Goals

- Add, list and remove a note with one command each.

## Non-goals

- Sync between machines.
- Rich text or attachments.

## Requirements

- R1: `notes add <text>` stores the note and prints its id; empty text exits 2 with `note text is empty`.
- R2: `notes list` prints every note as `<id>. <text>`, oldest first; with no notes it prints `no notes`.
- R3: `notes rm <id>` deletes the note; an unknown id exits 1 with `no such note: <id>`.

## E2E requirements

- E1: A user adds two notes and sees both in the list in the order added.
  Covers: R1, R2
- E2: A user removes a note and it no longer appears in the list.
  Covers: R2, R3

## Constraints

- Node 22, no runtime dependencies.
- Notes live in `$NOTES_HOME/notes.json`.

## Done predicate

Done when all 5 lanes in e2e-plan.md pass at the base branch head through `e2e_command`, and `npm test` exits 0.
