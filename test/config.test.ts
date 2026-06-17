import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAuthMode,
  config,
  librespotApiBase,
  librespotEventsUrl,
} from "../src/config.js";

test("parseAuthMode: accepts the two valid modes", () => {
  assert.equal(parseAuthMode("interactive"), "interactive");
  assert.equal(parseAuthMode("zeroconf"), "zeroconf");
});

test("parseAuthMode: rejects anything else", () => {
  assert.throws(() => parseAuthMode("nope"), /LIBRESPOT_AUTH/);
  assert.throws(() => parseAuthMode(""), /LIBRESPOT_AUTH/);
});

test("config: sensible defaults with only Discord creds set", () => {
  assert.equal(config.librespot.authMode, "interactive");
  assert.equal(config.librespot.callbackPort, 38080);
  assert.equal(config.librespot.apiPort, 3678);
  assert.equal(config.librespot.bitrate, 320);
  assert.equal(config.panel.enabled, true);
  assert.equal(config.panel.port, 8077);
  assert.equal(config.panel.host, "127.0.0.1");
});

test("derived API URLs follow host/port", () => {
  assert.equal(librespotApiBase, "http://127.0.0.1:3678");
  assert.equal(librespotEventsUrl, "ws://127.0.0.1:3678/events");
});
