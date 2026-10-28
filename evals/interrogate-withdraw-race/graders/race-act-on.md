---
type: llm
weight: 3
---

The reply puts the read-then-write race (two concurrent withdrawals both read the same balance, so the balance can go negative or a withdrawal is lost) in an "Act on" bucket, and suggests an atomic fix such as a conditional UPDATE or row lock.
