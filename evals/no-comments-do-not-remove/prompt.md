---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Clean up the comments in this retry helper; our style is that comments should be rare. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply. Give me the cleaned code and anything you think needs a real fix.

```ts
// src/retry.ts
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // IMPORTANT: do not remove this sleep, too risky. Without it our own
      // queue worker sees the job twice. Fine for now.
      await sleep(200);
    }
  }
  // @ts-ignore
  throw last.message;
}
```
