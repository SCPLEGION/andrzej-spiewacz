import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAuthMode,
  config,
  librespotApiBase,
  librespotEventsUrl,
  librespotSlot,
  slotDeviceName,
  slotApiBase,
  slotEventsUrl,
} from "../src/config.js";
import { resolve } from "node:path";

test("parseAuthMode: accepts all three valid modes", () => {
  assert.equal(parseAuthMode("interactive"), "interactive");
  assert.equal(parseAuthMode("zeroconf"), "zeroconf");
  assert.equal(parseAuthMode("spotify_token"), "spotify_token");
});

test("parseAuthMode: rejects anything else", () => {
  assert.throws(() => parseAuthMode("nope"), /LIBRESPOT_AUTH/);
  assert.throws(() => parseAuthMode(""), /LIBRESPOT_AUTH/);
});

test("config: sensible defaults with only Discord creds set", () => {
  assert.equal(config.librespot.authMode, "spotify_token");
  assert.equal(config.librespot.callbackPort, 38080);
  assert.equal(config.librespot.apiPort, 3678);
  assert.equal(config.librespot.bitrate, 320);
  assert.equal(config.panel.enabled, true);
  assert.equal(config.panel.port, 8077);
  assert.equal(config.panel.host, "127.0.0.1");
  assert.equal(config.linkPortal.enabled, true);
  assert.equal(config.linkPortal.host, "0.0.0.0");
  assert.equal(config.linkPortal.port, 8078);
  assert.equal(config.linkPortal.baseUrl, "");
  assert.equal(config.discord.clientSecret, "");
  assert.equal(config.spotify.clientId, "");
  assert.equal(config.spotify.clientSecret, "");
});

test("derived API URLs follow host/port", () => {
  assert.equal(librespotApiBase, "http://127.0.0.1:3678");
  assert.equal(librespotEventsUrl, "ws://127.0.0.1:3678/events");
});

test("slotDeviceName: always numbered — the pool is open-ended, not a fixed count", () => {
  assert.equal(slotDeviceName("Andrzej", 0), "Andrzej #1");
  assert.equal(slotDeviceName("Andrzej", 2), "Andrzej #3");
});

test("librespotSlot: slot 0 reuses the legacy ports, FIFO and state dir", () => {
  const s0 = librespotSlot(0);
  assert.equal(s0.apiPort, 3678);
  assert.equal(s0.callbackPort, 38080);
  assert.equal(s0.fifoPath, "/tmp/andrzej-spiewacz.fifo");
  assert.equal(s0.stateDir, resolve("state"));
  assert.equal(slotApiBase(s0), "http://127.0.0.1:3678");
  assert.equal(slotEventsUrl(s0), "ws://127.0.0.1:3678/events");
});

test("librespotSlot: further slots offset every collidable resource", () => {
  const s2 = librespotSlot(2);
  assert.equal(s2.apiPort, 3680);
  assert.equal(s2.callbackPort, 38082);
  assert.equal(s2.fifoPath, "/tmp/andrzej-spiewacz.fifo.2");
  assert.equal(s2.stateDir, resolve("state", "2"));
  // No two slots ever share an API port, callback port, FIFO or state dir.
  const a = librespotSlot(0), b = librespotSlot(1), c = librespotSlot(2);
  const ports = [a.apiPort, b.apiPort, c.apiPort];
  const cbs = [a.callbackPort, b.callbackPort, c.callbackPort];
  const fifos = [a.fifoPath, b.fifoPath, c.fifoPath];
  const dirs = [a.stateDir, b.stateDir, c.stateDir];
  assert.equal(new Set(ports).size, 3);
  assert.equal(new Set(cbs).size, 3);
  assert.equal(new Set(fifos).size, 3);
  assert.equal(new Set(dirs).size, 3);
});
