<!-- Adapted from pstack skills/how/references/explainer-prompt.md @ 519d36a (MIT, Lauren Tan). -->

# Explainer prompt template

Build the explainer's brief from this template. Fill in the placeholders. Put it under the brief headings from the mode skill (GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT).

---

Read the cstack mode skill first: {MODE_SKILL_PATH}.

Do not edit files. Do not read these paths: {PATHS_HIDDEN}.

You write an architectural explanation for a senior engineer. Explorer agents traced different slices of the codebase in parallel. Combine their findings into one clear explanation.

## Original question

> {QUESTION}

## Explorer findings

{EXPLORER_FINDINGS_ALL}

(Simple path: drop this section. Explore and explain in one pass.)

## Instructions

Each explorer worked on a different angle of the same subsystem. Their findings overlap in places and can contradict. Reconcile them. Merge the overlaps. Resolve each contradiction by reading the code yourself. Join the slices into one picture.

Write so that a senior engineer new to this area gets a solid mental model and can start work here with confidence.

You have read-only access to the codebase. Use Read, Grep and Glob to check a detail or fill a gap. The explorers did the broad work, so do not re-explore from scratch.

## Output format

Use this structure. Adapt it to the question. Not every question needs every section.

### Overview
One or two paragraphs. What this is, what it does, and why it exists. A reader can stop here and decide whether to read on.

### Key concepts
The types, services or abstractions the reader needs for the rest. Short definitions, not a full list.

### How it works
The core of the explanation and the longest section. Walk through the flow: what triggers it, each step, where the data goes, and the decision points.

Use prose, not pseudocode. Name files and functions so the reader knows where to look. Do not paste large code blocks unless a snippet is essential.

When many components talk to each other, or data changes through stages, add a diagram. Use mermaid for structured flows (sequence diagrams, flowcharts, component graphs). Use ASCII art for simple relations. A diagram must clarify, not decorate. If prose covers the flow, skip the diagram.

### Where things live
A short map of files and directories. List only the ones a person needs to start work here. Mark each path active, legacy or support when you can tell.

### Gotchas
Non-obvious behaviour, history and pitfalls. Skip this section when there is nothing to call out.

## Style

- Use concrete language, not abstractions about abstractions.
- Say "`UserService` calls `AuthClient.refresh()`", not "the service delegates to the client".
- When something is complex, explain why it is complex. Do not only describe the complexity.
- When something is simple, keep it short.
- Use an analogy only when one helps.
- If the explorers flagged open questions or gaps, state them. Do not hide them.
- No em dashes.
