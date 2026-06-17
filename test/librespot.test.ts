import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigYaml,
  mapFrameToEvent,
  extractAuthUrl,
  clampVolumePercent,
  hasCredentialsData,
} from "../src/librespot.js";

const base = {
  deviceName: "Andrzej Śpiewacz",
  fifoPath: "/tmp/a.fifo",
  apiHost: "127.0.0.1",
  apiPort: 3678,
  bitrate: 320,
  callbackPort: 38080,
};

test("buildConfigYaml: interactive disables zeroconf and sets callback port", () => {
  const yaml = buildConfigYaml({ ...base, authMode: "interactive" });
  assert.match(yaml, /zeroconf_enabled: false/);
  assert.match(yaml, /type: interactive/);
  assert.match(yaml, /callback_port: 38080/);
  assert.doesNotMatch(yaml, /type: zeroconf/);
  // device name is JSON-quoted so non-ASCII / spaces survive intact
  assert.match(yaml, /device_name: "Andrzej Śpiewacz"/);
  assert.ok(yaml.endsWith("\n"));
});

test("buildConfigYaml: zeroconf persists credentials and omits interactive keys", () => {
  const yaml = buildConfigYaml({ ...base, authMode: "zeroconf" });
  assert.match(yaml, /type: zeroconf/);
  assert.match(yaml, /persist_credentials: true/);
  assert.doesNotMatch(yaml, /zeroconf_enabled: false/);
  assert.doesNotMatch(yaml, /type: interactive/);
});

test("buildConfigYaml: shared keys always present", () => {
  for (const mode of ["interactive", "zeroconf"] as const) {
    const yaml = buildConfigYaml({ ...base, authMode: mode });
    assert.match(yaml, /audio_backend: pipe/);
    assert.match(yaml, /audio_output_pipe_format: s16le/);
    assert.match(yaml, /bitrate: 320/);
    assert.match(yaml, /port: 3678/);
  }
});

test("mapFrameToEvent: maps known frame types", () => {
  assert.deepEqual(mapFrameToEvent({ type: "playing" }), { event: "playing", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "will_play" }), { event: "playing", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "paused" }), { event: "paused", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "stopped" }), { event: "stopped", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "not_playing" }), { event: "stopped", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "active" }), { event: "active", args: [] });
  assert.deepEqual(mapFrameToEvent({ type: "inactive" }), { event: "inactive", args: [] });
});

test("mapFrameToEvent: forwards metadata and volume payloads", () => {
  const meta = { name: "Song", artist_names: ["A"] };
  assert.deepEqual(mapFrameToEvent({ type: "metadata", data: meta }), {
    event: "metadata",
    args: [meta],
  });
  assert.deepEqual(mapFrameToEvent({ type: "volume", data: { value: 30, max: 65535 } }), {
    event: "volume",
    args: [{ value: 30, max: 65535 }],
  });
});

test("mapFrameToEvent: unknown frame types are ignored", () => {
  assert.equal(mapFrameToEvent({ type: "seek" }), null);
  assert.equal(mapFrameToEvent({ type: "" }), null);
});

test("extractAuthUrl: pulls the link out of a daemon log line", () => {
  const line =
    "go-librespot: to complete authentication visit the following link: https://accounts.spotify.com/authorize?foo=bar";
  assert.equal(extractAuthUrl(line), "https://accounts.spotify.com/authorize?foo=bar");
});

test("extractAuthUrl: returns null when no link present", () => {
  assert.equal(extractAuthUrl("nothing to see here"), null);
  assert.equal(extractAuthUrl(""), null);
});

test("clampVolumePercent: clamps and rounds to 0..100 integers", () => {
  assert.equal(clampVolumePercent(-5), 0);
  assert.equal(clampVolumePercent(150), 100);
  assert.equal(clampVolumePercent(50), 50);
  assert.equal(clampVolumePercent(33.6), 34);
  assert.equal(clampVolumePercent(0), 0);
  assert.equal(clampVolumePercent(100), 100);
});

test("hasCredentialsData: detects persisted credentials", () => {
  assert.equal(hasCredentialsData('{"credentials":{"data":"abc"}}'), true);
  assert.equal(hasCredentialsData('{"credentials":{}}'), false);
  assert.equal(hasCredentialsData('{"credentials":{"data":""}}'), false);
  assert.equal(hasCredentialsData("{}"), false);
  assert.equal(hasCredentialsData("not json at all"), false);
});
