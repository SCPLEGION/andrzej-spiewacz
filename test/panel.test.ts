import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, escapeHtml, renderPanelHtml } from "../src/panel.js";
import type { TrackMetadata } from "../src/librespot.js";

const track: TrackMetadata = {
  uri: "spotify:track:1",
  name: "Hyperdrive",
  artist_names: ["Voyager", "Echo"],
  album_name: "Deep Space",
  album_cover_url: "https://i.scdn.co/image/abc",
  duration: 200000,
  position: 1000,
};

test("buildStatus: maps track metadata into the flat panel shape", () => {
  const st = buildStatus({
    device: "Andrzej",
    authMode: "interactive",
    authenticated: true,
    authUrl: null,
    track,
    guilds: [{ id: "1", name: "Guild", channel: "General" }],
  });
  assert.equal(st.track?.name, "Hyperdrive");
  assert.equal(st.track?.artists, "Voyager, Echo");
  assert.equal(st.track?.album, "Deep Space");
  assert.equal(st.track?.cover, "https://i.scdn.co/image/abc");
  assert.equal(st.guilds.length, 1);
});

test("buildStatus: hides the auth link once authenticated", () => {
  const st = buildStatus({
    device: "Andrzej",
    authMode: "interactive",
    authenticated: true,
    authUrl: "https://accounts.spotify.com/authorize",
    track: null,
    guilds: [],
  });
  assert.equal(st.authUrl, null);
  assert.equal(st.track, null);
});

test("buildStatus: surfaces the auth link while unauthenticated", () => {
  const st = buildStatus({
    device: "Andrzej",
    authMode: "interactive",
    authenticated: false,
    authUrl: "https://accounts.spotify.com/authorize",
    track: null,
    guilds: [],
  });
  assert.equal(st.authUrl, "https://accounts.spotify.com/authorize");
});

test("escapeHtml: neutralizes markup characters", () => {
  assert.equal(escapeHtml(`<script>"&'`), "&lt;script&gt;&quot;&amp;&#39;");
});

test("renderPanelHtml: embeds the device name and the status endpoint", () => {
  const html = renderPanelHtml("Andrzej Śpiewacz");
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("Andrzej Śpiewacz"));
  assert.ok(html.includes("/api/status"));
  assert.ok(html.includes("Authorize Spotify"));
});

test("renderPanelHtml: escapes a hostile device name", () => {
  const html = renderPanelHtml(`<img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});
