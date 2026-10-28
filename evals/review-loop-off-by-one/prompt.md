---
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

I wrote this pagination change with Claude Opus and want a proper review loop on it before I open the PR. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Intent: `page(items, n, size)` returns the n-th page (1-based) of `size` items.

```diff
--- a/src/paginate.js
+++ b/src/paginate.js
@@ -1,6 +1,9 @@
-export function page(items, n) {
-  return items.slice((n - 1) * 20, n * 20);
+export function page(items, n, size = 20) {
+  if (n < 1) throw new RangeError("page starts at 1");
+  const start = (n - 1) * size;
+  return items.slice(start, start + size - 1);
 }
```
