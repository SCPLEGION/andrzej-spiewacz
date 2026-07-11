import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderAuthErrorPage,
  renderLinkForm,
  renderLoginPage,
  renderNoPlayerPage,
  renderStatusPage,
} from "../src/linkPortal.js";

test("renderLoginPage: offers a Discord login link and escapes a hostile device name", () => {
  const html = renderLoginPage(`<img src=x onerror=alert(1)>`);
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes('href="/auth/discord/login"'));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});

test("renderAuthErrorPage: shows the failure message, escaped, with a retry link", () => {
  const html = renderAuthErrorPage("Andrzej", `<script>alert(1)</script>`);
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('href="/auth/discord/login"'));
});

test("renderNoPlayerPage: tells the user to run /link and offers logout", () => {
  const html = renderNoPlayerPage("Andrzej");
  assert.ok(html.includes("/link"));
  assert.ok(html.includes('href="/auth/logout"'));
});

test("renderLinkForm: embeds the authorize URL, posts to /code, and device name", () => {
  const html = renderLinkForm({
    authUrl: "https://accounts.spotify.com/authorize?x=1",
    deviceName: "Andrzej Śpiewacz #2",
  });
  assert.ok(html.includes('href="https://accounts.spotify.com/authorize?x=1"'));
  assert.ok(html.includes('action="/code"'));
  assert.ok(html.includes("Andrzej Śpiewacz #2"));
  assert.ok(html.includes('name="code"'));
  assert.ok(html.includes('href="/auth/logout"'));
});

test("renderLinkForm: surfaces the error message, escaped", () => {
  const html = renderLinkForm({
    authUrl: "https://x",
    deviceName: "Andrzej",
    error: `<script>alert(1)</script>`,
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderLinkForm: omits the error block when there's no error", () => {
  const html = renderLinkForm({ authUrl: "https://x", deviceName: "Andrzej" });
  assert.ok(!html.includes('class="err"'));
});

test("renderStatusPage: shows the current track when playing", () => {
  const html = renderStatusPage({
    deviceName: "Andrzej #1",
    track: { name: "Hyperdrive", artists: "Voyager", album: "Deep Space", cover: null },
    channelStatusMode: "off",
  });
  assert.ok(html.includes("Hyperdrive"));
  assert.ok(html.includes("Voyager"));
  assert.ok(html.includes("Zalinkowano"));
});

test("renderStatusPage: falls back to an idle message with no track", () => {
  const html = renderStatusPage({ deviceName: "Andrzej #1", track: null, channelStatusMode: "off" });
  assert.ok(html.includes("Nic teraz nie gra"));
});

test("renderStatusPage: escapes a hostile track name", () => {
  const html = renderStatusPage({
    deviceName: "Andrzej",
    track: { name: `<img src=x onerror=alert(1)>`, artists: "A", album: "", cover: null },
    channelStatusMode: "off",
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});

test("renderStatusPage: renders the mode form posting to /mode, with the current mode checked", () => {
  const html = renderStatusPage({ deviceName: "Andrzej", track: null, channelStatusMode: "lyrics" });
  assert.ok(html.includes('action="/mode"'));
  assert.ok(html.includes('name="mode"'));
  assert.ok(html.includes('value="off"'));
  assert.ok(html.includes('value="song"'));
  assert.ok(html.includes('value="lyrics"'));
  // Only the current mode's radio is checked.
  assert.match(html, /value="lyrics"[^>]*checked/);
  assert.doesNotMatch(html, /value="off"[^>]*checked/);
  assert.doesNotMatch(html, /value="song"[^>]*checked/);
});
