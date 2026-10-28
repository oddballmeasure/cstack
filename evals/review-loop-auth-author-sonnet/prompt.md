---
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Sonnet wrote this auth middleware tweak for me. Please put it through a review loop. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Intent: requests under `/api/admin` must carry a valid signed session token; everything else is unchanged.

```diff
--- a/server/auth.ts
+++ b/server/auth.ts
@@ -10,9 +10,12 @@ export function requireAdmin(req: Request, res: Response, next: NextFunction) {
-  const session = verifySession(req.cookies.session);
-  if (!session || session.role !== "admin") return res.status(403).end();
-  next();
+  const raw = req.cookies.session ?? req.headers["x-session"];
+  if (!raw) return res.status(401).end();
+  const session = decodeSession(raw); // base64 JSON, no signature check
+  if (session.role !== "admin") return res.status(403).end();
+  req.user = session;
+  next();
 }
```
