import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySpotifyTokens,
  getSpotifyToken,
  setSpotifyToken,
  loadSpotifyTokens,
  saveSpotifyTokens,
} from "../src/spotifyTokens.js";

test("emptySpotifyTokens: nobody linked yet", () => {
  assert.deepEqual(emptySpotifyTokens(), { users: {} });
});

test("getSpotifyToken: undefined for an unknown user", () => {
  assert.equal(getSpotifyToken(emptySpotifyTokens(), "u1"), undefined);
});

test("setSpotifyToken: records the link, pure (no mutation)", () => {
  const start = emptySpotifyTokens();
  const entry = { spotifyUserId: "spotify_u1", refreshToken: "rt1" };
  const withLink = setSpotifyToken(start, "u1", entry);
  assert.deepEqual(start, emptySpotifyTokens()); // original untouched
  assert.deepEqual(getSpotifyToken(withLink, "u1"), entry);
});

test("setSpotifyToken: independent per user, later calls don't clobber earlier ones", () => {
  let tokens = setSpotifyToken(emptySpotifyTokens(), "u1", { spotifyUserId: "s1", refreshToken: "rt1" });
  tokens = setSpotifyToken(tokens, "u2", { spotifyUserId: "s2", refreshToken: "rt2" });
  assert.deepEqual(getSpotifyToken(tokens, "u1"), { spotifyUserId: "s1", refreshToken: "rt1" });
  assert.deepEqual(getSpotifyToken(tokens, "u2"), { spotifyUserId: "s2", refreshToken: "rt2" });
});

test("setSpotifyToken: overwrites an existing link for the same user (relink)", () => {
  let tokens = setSpotifyToken(emptySpotifyTokens(), "u1", { spotifyUserId: "s1", refreshToken: "rt1" });
  tokens = setSpotifyToken(tokens, "u1", { spotifyUserId: "s1_new", refreshToken: "rt2" });
  assert.deepEqual(getSpotifyToken(tokens, "u1"), { spotifyUserId: "s1_new", refreshToken: "rt2" });
});

test("loadSpotifyTokens: empty when the file doesn't exist", () => {
  const path = join(mkdtempSync(join(tmpdir(), "andrzej-spotify-")), "missing.json");
  assert.deepEqual(loadSpotifyTokens(path), emptySpotifyTokens());
});

test("saveSpotifyTokens + loadSpotifyTokens: round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "andrzej-spotify-"));
  const path = join(dir, "nested", "spotify-tokens.json"); // must create the dir
  const tokens = setSpotifyToken(emptySpotifyTokens(), "u1", { spotifyUserId: "s1", refreshToken: "rt1" });
  saveSpotifyTokens(tokens, path);
  assert.deepEqual(loadSpotifyTokens(path), tokens);
  rmSync(dir, { recursive: true, force: true });
});
