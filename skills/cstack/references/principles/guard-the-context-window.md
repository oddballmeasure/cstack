# Guard the Context Window

<!-- Adapted from pstack skills/principle-guard-the-context-window/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

**Apply when:** Context is filling up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents; keep summaries in the main thread, not raw payloads.

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
