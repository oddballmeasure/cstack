---
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Give this an adversarial multi-model pass and tell me honestly whether anything here is a real problem. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Intent: replace a manual loop with the built-in `includes`, no behaviour change.

```diff
--- a/src/roles.js
+++ b/src/roles.js
@@ -1,8 +1,3 @@
 export function isStaff(role) {
-  const staff = ["admin", "editor", "support"];
-  for (let i = 0; i < staff.length; i++) {
-    if (staff[i] === role) return true;
-  }
-  return false;
+  return ["admin", "editor", "support"].includes(role);
 }
```
