import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConfigYaml,
  mapFrameToEvent,
  extractAuthUrl,
  extractAuthCode,
  clampVolumePercent,
  hasCredentialsData,
  isConnectionRefused,
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

test("buildConfigYaml: external_volume is enabled so gain is applied Discord-side", () => {
  for (const mode of ["interactive", "zeroconf"] as const) {
    const yaml = buildConfigYaml({ ...base, authMode: mode });
    assert.match(yaml, /external_volume: true/);
    // Pinned so /player/volume is 0..100 and the echoed volume event reports
    // max:100, not the daemon's internal 65535 scale.
    assert.match(yaml, /volume_steps: 100/);
    assert.match(yaml, /initial_volume: 100/);
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

test("extractAuthCode: pulls the code from a full redirect URL", () => {
  assert.equal(
    extractAuthCode("http://127.0.0.1:38080/login?code=AQD3xZ_abc-123&state=xyz"),
    "AQD3xZ_abc-123",
  );
  assert.equal(extractAuthCode("  http://127.0.0.1:38080/login?code=ONLYCODE  "), "ONLYCODE");
});

test("extractAuthCode: accepts a bare pasted code", () => {
  assert.equal(extractAuthCode("AQD3xZ_abcdef123456"), "AQD3xZ_abcdef123456");
});

test("extractAuthCode: rejects junk and too-short input", () => {
  assert.equal(extractAuthCode(""), null);
  assert.equal(extractAuthCode("short"), null);
  assert.equal(extractAuthCode("has spaces in it"), null);
  assert.equal(extractAuthCode("https://accounts.spotify.com/authorize?foo=bar"), null);
});

test("clampVolumePercent: clamps and rounds to 0..100 integers", () => {
  assert.equal(clampVolumePercent(-5), 0);
  assert.equal(clampVolumePercent(150), 100);
  assert.equal(clampVolumePercent(50), 50);
  assert.equal(clampVolumePercent(33.6), 34);
  assert.equal(clampVolumePercent(0), 0);
  assert.equal(clampVolumePercent(100), 100);
});

test("isConnectionRefused: detects a not-yet-bound callback (fetch cause code)", () => {
  // Node's fetch wraps the OS error under `cause`.
  assert.equal(isConnectionRefused({ cause: { code: "ECONNREFUSED" } }), true);
  assert.equal(isConnectionRefused({ cause: { code: "ECONNRESET" } }), true);
  // Some paths surface the code directly.
  assert.equal(isConnectionRefused({ code: "ECONNREFUSED" }), true);
  // A real HTTP error or anything else is terminal, not a retry.
  assert.equal(isConnectionRefused(new Error("auth callback responded 400")), false);
  assert.equal(isConnectionRefused({ cause: { code: "ETIMEDOUT" } }), false);
  assert.equal(isConnectionRefused(null), false);
});

test("hasCredentialsData: detects persisted credentials", () => {
  assert.equal(hasCredentialsData('{"credentials":{"data":"abc"}}'), true);
  assert.equal(hasCredentialsData('{"credentials":{}}'), false);
  assert.equal(hasCredentialsData('{"credentials":{"data":""}}'), false);
  assert.equal(hasCredentialsData("{}"), false);
  assert.equal(hasCredentialsData("not json at all"), false);
});
