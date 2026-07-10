import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignSlot, emptyRegistry, loadRegistry, saveRegistry } from "../src/registry.js";

test("emptyRegistry: no users, starts numbering at 0", () => {
  assert.deepEqual(emptyRegistry(), { users: {}, nextIndex: 0 });
});

test("assignSlot: hands out sequential indices to new users, pure (no mutation)", () => {
  const start = emptyRegistry();
  const a = assignSlot(start, "u1");
  assert.equal(a.index, 0);
  assert.equal(a.created, true);
  assert.deepEqual(start, emptyRegistry()); // original untouched

  const b = assignSlot(a.registry, "u2");
  assert.equal(b.index, 1);
  assert.equal(b.created, true);
});

test("assignSlot: a user who already has an index gets the same one back, unmutated", () => {
  const first = assignSlot(emptyRegistry(), "u1");
  const again = assignSlot(first.registry, "u1");
  assert.equal(again.index, 0);
  assert.equal(again.created, false);
  assert.equal(again.registry, first.registry); // same object — no new registry needed
});

test("assignSlot: never reuses an index, even after other users pile up", () => {
  let registry = emptyRegistry();
  const indices: number[] = [];
  for (const user of ["u1", "u2", "u3"]) {
    const result = assignSlot(registry, user);
    registry = result.registry;
    indices.push(result.index);
  }
  assert.deepEqual(indices, [0, 1, 2]);
  assert.equal(new Set(indices).size, 3);
});

test("loadRegistry: returns an empty registry when the file doesn't exist", () => {
  const path = join(mkdtempSync(join(tmpdir(), "andrzej-registry-")), "missing.json");
  assert.deepEqual(loadRegistry(path), emptyRegistry());
});

test("loadRegistry: treats a corrupt file as empty rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "andrzej-registry-"));
  const path = join(dir, "registry.json");
  writeFileSync(path, "not json", "utf8");
  assert.deepEqual(loadRegistry(path), emptyRegistry());
  rmSync(dir, { recursive: true, force: true });
});

test("saveRegistry + loadRegistry: round-trips a registry through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "andrzej-registry-"));
  const path = join(dir, "nested", "registry.json"); // saveRegistry must create the dir
  const { registry } = assignSlot(assignSlot(emptyRegistry(), "u1").registry, "u2");
  saveRegistry(registry, path);
  assert.deepEqual(loadRegistry(path), registry);
  rmSync(dir, { recursive: true, force: true });
});
