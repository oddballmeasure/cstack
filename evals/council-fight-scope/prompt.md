---
max_turns: 25
timeout_seconds: 1200
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Can you run a council over this one-line fix? My teammates keep saying that while we're in here we should also add a response cache, automatic retries, and a feature flag. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Bug: the profile page crashes when a user has no avatar.

```diff
--- a/web/profile.tsx
+++ b/web/profile.tsx
@@ -21,7 +21,7 @@ export function Profile({ user }: { user: User }) {
   return (
     <header>
-      <img src={user.avatar.url} alt="" />
+      {user.avatar && <img src={user.avatar.url} alt="" />}
       <h1>{user.name}</h1>
     </header>
```
