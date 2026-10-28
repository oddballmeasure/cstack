---
max_turns: 12
timeout_seconds: 420
allowed_tools: [Read, Grep, Glob, Skill]
---

A review bot left this on my PR and I think it's wrong. Draft the reply I should post on the thread. I'm Dana Whitfield, GitHub dana-w. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply.

Bot comment on `src/user.ts` line 14:

> Possible null dereference: `user.email.toLowerCase()` will throw when `email` is undefined.

The code:

```ts
11 export function normalizedEmail(user?: User): string | null {
12   if (!user?.email) return null;
13   // ...
14   return user.email.toLowerCase();
15 }
```
