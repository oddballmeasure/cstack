<!-- Adapted from pstack skills/how/references/explorer-prompt.md @ 519d36a (MIT, Lauren Tan). -->

# Explorer prompt template

Build each explorer's brief from this template. Fill in the placeholders. Put it under the brief headings from the mode skill (GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT).

---

Read the cstack mode skill first: {MODE_SKILL_PATH}.

Do not edit files. Do not read these paths: {PATHS_HIDDEN}.

Other explorers are working on other slices of the same subsystem in parallel. Do not try to cover everything. Stay on your angle and go deep.

## Question

> {QUESTION}

## Your exploration angle

{EXPLORATION_ANGLE}

## Profile leads

{PROFILE_LEADS, or "none"}

## Output

### Components found
The key types, services, classes and abstractions. For each one: name, file path, and one sentence on what it does.

### Flow
The execution flow, step by step. For each step: the function or method that runs, its file, what it does, and what it calls next. Include the data that moves between steps.

### Files read
Every file you read, so the explainer can cite them.

### Boundaries
Where this subsystem connects to the rest of the codebase. Its inputs and outputs.

### Non-obvious things
Anything surprising, historically motivated, or easy to get wrong. Things that look like they work one way but work another.

### Open questions
Anything you could not fully trace. Be honest about gaps.
