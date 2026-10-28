---
type: llm
weight: 3
---

The reply names the key safety fact: clearExpired only deletes entries with exp <= now, which get() would already treat as missing, so get() returns the same values as before.
