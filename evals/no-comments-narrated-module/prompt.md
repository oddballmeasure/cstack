---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Read, Grep, Glob, Skill, Agent]
---

Strip the comments that don't earn their place from this file before I commit it. I'm offline right now. Do not try to reach GitHub or the network, and do not change any files. Just give me the result as text in your reply. Paste the cleaned file back with a short list of what went and what stayed.

```js
// Copyright 2026 Acme Inc. Licensed under the MIT License.

import { clamp } from "./math.js";

/**
 * Scrolls the element into view.
 * @param {HTMLElement} el - element to scroll to
 * @returns {void}
 */
export function reveal(el) {
  // get the rect
  const r = el.getBoundingClientRect();
  // compute the target
  const top = clamp(r.top + window.scrollY - 80, 0, Infinity);
  // old approach:
  // el.scrollIntoView({ behavior: "smooth" });
  // Safari ignores scroll-margin with smooth scrolling, see https://bugs.webkit.org/show_bug.cgi?id=189265
  window.scrollTo({ top, behavior: "smooth" });
}
```
