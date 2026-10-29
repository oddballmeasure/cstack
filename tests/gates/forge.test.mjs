// The forge layer's choice of backend (gates/lib/forge.mjs). Backend behaviour is covered by the gate suites
// through the fake gh, and in later phases by a contract suite run against every backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgeKind, openForge, FORGES } from "../../gates/lib/forge.mjs";

test("forgeKind: CSTACK_FORGE, then config forge, then github for auto", () => {
  const saved = process.env.CSTACK_FORGE;
  delete process.env.CSTACK_FORGE;
  try {
    assert.deepEqual(FORGES, ["github", "gitlab", "local"]);
    assert.equal(forgeKind({}), "github");
    assert.equal(forgeKind({ forge: "auto" }), "github");
    assert.equal(forgeKind({ forge: "gitlab" }), "gitlab");
    process.env.CSTACK_FORGE = "local";
    assert.equal(forgeKind({ forge: "gitlab" }), "local");
    process.env.CSTACK_FORGE = "gitea";
    assert.throws(() => forgeKind({}), /unknown forge 'gitea'/);
  } finally {
    if (saved === undefined) delete process.env.CSTACK_FORGE;
    else process.env.CSTACK_FORGE = saved;
  }
});

test("openForge returns the github backend and refuses backends not built yet", () => {
  const f = openForge({ repo: "o/r", forge: "github" });
  assert.equal(f.kind, "github");
  assert.equal(f.name, "GitHub");
  assert.equal(f.repo, "o/r");
  assert.throws(() => openForge({ forge: "gitlab" }), /forge 'gitlab' is not implemented yet/);
});
