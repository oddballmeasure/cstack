---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Grep, Glob, Skill]
---

I don't fully trust this small cache change. Blast radius? I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply. No shell either, so reason from the code.

```js
// lib/cache.js
export class TtlCache {
  #m = new Map();
  set(k, v, ttlMs, now = Date.now()) { this.#m.set(k, { v, exp: now + ttlMs }); }
  get(k, now = Date.now()) {
+   this.clearExpired(now);
    const e = this.#m.get(k);
    if (!e || e.exp <= now) return undefined;
    return e.v;
  }
  clearExpired(now = Date.now()) {
    for (const [k, e] of this.#m) if (e.exp <= now) this.#m.delete(k);
  }
  get size() { return this.#m.size; }
}
```

The only diff is the `+` line in `get`.
