import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, buildPoolStatus, escapeHtml, renderPanelHtml, toTrackView } from "../src/panel.js";
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

test("toTrackView: maps raw metadata, falling back for missing fields", () => {
  assert.deepEqual(toTrackView(track), {
    name: "Hyperdrive",
    artists: "Voyager, Echo",
    album: "Deep Space",
    cover: "https://i.scdn.co/image/abc",
  });
  assert.equal(toTrackView(null), null);
  assert.deepEqual(
    toTrackView({ ...track, name: "", artist_names: [], album_name: "", album_cover_url: "" }),
    { name: "Unknown track", artists: "Unknown artist", album: "", cover: null },
  );
});

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

test("buildPoolStatus: builds one player view per slot with index, volume and guild", () => {
  const st = buildPoolStatus("Andrzej", "interactive", [
    {
      index: 0,
      volume: 80,
      device: "Andrzej #1",
      authMode: "interactive",
      authenticated: true,
      authUrl: null,
      track,
      guilds: [{ id: "1", name: "Guild A", channel: "General" }],
    },
    {
      index: 1,
      volume: 50,
      device: "Andrzej #2",
      authMode: "interactive",
      authenticated: false,
      authUrl: "https://accounts.spotify.com/authorize",
      track: null,
      guilds: [],
    },
  ]);
  assert.equal(st.device, "Andrzej");
  assert.equal(st.players.length, 2);
  assert.equal(st.players[0].index, 0);
  assert.equal(st.players[0].volume, 80);
  assert.equal(st.players[0].device, "Andrzej #1");
  assert.equal(st.players[0].guild?.name, "Guild A");
  assert.equal(st.players[0].track?.name, "Hyperdrive");
  // Free slot: no guild, and the auth link is surfaced while unauthenticated.
  assert.equal(st.players[1].guild, null);
  assert.equal(st.players[1].authUrl, "https://accounts.spotify.com/authorize");
});

test("renderPanelHtml: embeds the device name and the status endpoint", () => {
  const html = renderPanelHtml("Andrzej Śpiewacz");
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("Andrzej Śpiewacz"));
  assert.ok(html.includes("/api/status"));
  assert.ok(html.includes("Authorize Spotify"));
  assert.ok(html.includes("/api/test-audio"));
});

test("renderPanelHtml: escapes a hostile device name", () => {
  const html = renderPanelHtml(`<img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});
