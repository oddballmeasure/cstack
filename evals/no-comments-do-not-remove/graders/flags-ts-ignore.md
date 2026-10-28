---
type: llm
weight: 3
---

The reply flags the `@ts-ignore` as hiding a real type error (throwing `last.message` on an unknown value) and marks it MUST KILL or as needing a real fix, rather than just keeping or silently deleting it.
