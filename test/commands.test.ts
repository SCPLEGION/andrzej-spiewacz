import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { commands } from "../src/discord/commands.js";

test("registers the expected command set", () => {
  const names = commands.map((c) => c.name).sort();
  assert.deepEqual(names, [
    "device",
    "join",
    "leave",
    "link",
    "lyrics",
    "np",
    "playpause",
    "prev",
    "skip",
    "volume",
  ]);
});

test("every command has a non-empty name and description", () => {
  for (const c of commands) {
    assert.ok(c.name.length > 0, `name for ${JSON.stringify(c)}`);
    assert.ok((c.description?.length ?? 0) > 0, `description for ${c.name}`);
  }
});

test("volume exposes a required 0..100 integer percent option", () => {
  const volume = commands.find((c) => c.name === "volume");
  assert.ok(volume, "volume command exists");
  const opt = volume?.options?.[0] as
    | { type: number; name: string; required?: boolean; min_value?: number; max_value?: number }
    | undefined;
  assert.ok(opt, "percent option exists");
  assert.equal(opt?.name, "percent");
  assert.equal(opt?.type, 4); // ApplicationCommandOptionType.Integer
  assert.equal(opt?.required, true);
  assert.equal(opt?.min_value, 0);
  assert.equal(opt?.max_value, 100);
});
