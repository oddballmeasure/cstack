---
max_turns: 25
timeout_seconds: 1200
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Get me a council on this rate limiter before I merge it. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply. I'll paste the result into the PR myself.

Intent: allow at most `limit` calls per key in any rolling `windowMs`.

```js
// src/limiter.js
const hits = new Map();
export function allow(key, limit, windowMs, now = Date.now()) {
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length > limit) return false;
  recent.push(now);
  hits.set(key, recent);
  return true;
}
```
