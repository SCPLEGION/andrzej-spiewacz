import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spotifyAuthorizeUrl } from "../src/spotifyAuth.js";

test("spotifyAuthorizeUrl: builds the authorize URL for our own app", () => {
  const url = new URL(spotifyAuthorizeUrl("client123", "https://example.com/auth/spotify/callback"));
  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  assert.equal(url.searchParams.get("client_id"), "client123");
  assert.equal(url.searchParams.get("redirect_uri"), "https://example.com/auth/spotify/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "streaming user-read-email user-read-private");
});
