import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyChannelStatusPrefs,
  getChannelStatusMode,
  setChannelStatusMode,
  loadChannelStatusPrefs,
  saveChannelStatusPrefs,
} from "../src/channelStatusPrefs.js";

test("emptyChannelStatusPrefs: no users", () => {
  assert.deepEqual(emptyChannelStatusPrefs(), { users: {} });
});

test("getChannelStatusMode: defaults to off for an unknown user", () => {
  assert.equal(getChannelStatusMode(emptyChannelStatusPrefs(), "u1"), "off");
});

test("setChannelStatusMode: records song/lyrics, pure (no mutation)", () => {
  const start = emptyChannelStatusPrefs();
  const withSong = setChannelStatusMode(start, "u1", "song");
  assert.deepEqual(start, emptyChannelStatusPrefs()); // original untouched
  assert.equal(getChannelStatusMode(withSong, "u1"), "song");

  const withLyrics = setChannelStatusMode(withSong, "u1", "lyrics");
  assert.equal(getChannelStatusMode(withLyrics, "u1"), "lyrics");
  assert.equal(getChannelStatusMode(withSong, "u1"), "song"); // earlier value unaffected
});

test("setChannelStatusMode: setting off drops the user rather than storing it", () => {
  const withSong = setChannelStatusMode(emptyChannelStatusPrefs(), "u1", "song");
  const backToOff = setChannelStatusMode(withSong, "u1", "off");
  assert.deepEqual(backToOff, { users: {} });
});

test("setChannelStatusMode: setting off on a user with no pref is a no-op (same reference)", () => {
  const start = emptyChannelStatusPrefs();
  assert.equal(setChannelStatusMode(start, "u1", "off"), start);
});

test("setChannelStatusMode: independent per user", () => {
  let prefs = setChannelStatusMode(emptyChannelStatusPrefs(), "u1", "song");
  prefs = setChannelStatusMode(prefs, "u2", "lyrics");
  assert.equal(getChannelStatusMode(prefs, "u1"), "song");
  assert.equal(getChannelStatusMode(prefs, "u2"), "lyrics");
});

test("loadChannelStatusPrefs: empty when the file doesn't exist", () => {
  const path = join(mkdtempSync(join(tmpdir(), "andrzej-status-")), "missing.json");
  assert.deepEqual(loadChannelStatusPrefs(path), emptyChannelStatusPrefs());
});

test("saveChannelStatusPrefs + loadChannelStatusPrefs: round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "andrzej-status-"));
  const path = join(dir, "nested", "channel-status.json"); // must create the dir
  const prefs = setChannelStatusMode(setChannelStatusMode(emptyChannelStatusPrefs(), "u1", "lyrics"), "u2", "song");
  saveChannelStatusPrefs(prefs, path);
  assert.deepEqual(loadChannelStatusPrefs(path), prefs);
  rmSync(dir, { recursive: true, force: true });
});
