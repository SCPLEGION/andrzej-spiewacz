import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateToken,
  LinkSessionStore,
  renderExpiredPage,
  renderLinkForm,
  renderStatusPage,
} from "../src/linkPortal.js";

test("generateToken: URL-safe and different every call", () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 24);
});

test("LinkSessionStore: create then get round-trips the session", () => {
  const store = new LinkSessionStore();
  const now = 1_000_000;
  const token = store.create("user-1", "https://accounts.spotify.com/authorize?x=1", now);
  const session = store.get(token, now);
  assert.equal(session?.userId, "user-1");
  assert.equal(session?.authUrl, "https://accounts.spotify.com/authorize?x=1");
  assert.equal(session?.createdAt, now);
});

test("LinkSessionStore: unknown token returns undefined", () => {
  const store = new LinkSessionStore();
  assert.equal(store.get("nope", 0), undefined);
});

test("LinkSessionStore: expires after the TTL and forgets the token", () => {
  const store = new LinkSessionStore();
  const now = 1_000_000;
  const token = store.create("user-1", "https://x", now);
  const THIRTY_ONE_MIN = 31 * 60 * 1000;
  assert.equal(store.get(token, now + THIRTY_ONE_MIN), undefined);
  // Still gone even if asked again right after (already evicted).
  assert.equal(store.get(token, now + THIRTY_ONE_MIN + 1), undefined);
});

test("LinkSessionStore: just under the TTL is still valid", () => {
  const store = new LinkSessionStore();
  const now = 1_000_000;
  const token = store.create("user-1", "https://x", now);
  const TWENTY_NINE_MIN = 29 * 60 * 1000;
  assert.equal(store.get(token, now + TWENTY_NINE_MIN)?.userId, "user-1");
});

test("LinkSessionStore: a fresh session for the same user invalidates the old one", () => {
  const store = new LinkSessionStore();
  const now = 1_000_000;
  const first = store.create("user-1", "https://x", now);
  const second = store.create("user-1", "https://y", now);
  assert.equal(store.get(first, now), undefined);
  assert.equal(store.get(second, now)?.authUrl, "https://y");
});

test("LinkSessionStore: different users get independent sessions", () => {
  const store = new LinkSessionStore();
  const now = 1_000_000;
  const a = store.create("user-1", "https://a", now);
  const b = store.create("user-2", "https://b", now);
  assert.equal(store.get(a, now)?.userId, "user-1");
  assert.equal(store.get(b, now)?.userId, "user-2");
});

test("renderExpiredPage: mentions expiry and escapes a hostile device name", () => {
  const html = renderExpiredPage(`<img src=x onerror=alert(1)>`);
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("wygasł"));
  assert.ok(html.includes("/link"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});

test("renderLinkForm: embeds the authorize URL, token action, and device name", () => {
  const html = renderLinkForm({
    token: "tok123",
    authUrl: "https://accounts.spotify.com/authorize?x=1",
    deviceName: "Andrzej Śpiewacz #2",
  });
  assert.ok(html.includes('href="https://accounts.spotify.com/authorize?x=1"'));
  assert.ok(html.includes('action="/link/tok123"'));
  assert.ok(html.includes("Andrzej Śpiewacz #2"));
  assert.ok(html.includes('name="code"'));
});

test("renderLinkForm: surfaces the error message, escaped", () => {
  const html = renderLinkForm({
    token: "tok123",
    authUrl: "https://x",
    deviceName: "Andrzej",
    error: `<script>alert(1)</script>`,
  });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderLinkForm: omits the error block when there's no error", () => {
  const html = renderLinkForm({ token: "t", authUrl: "https://x", deviceName: "Andrzej" });
  assert.ok(!html.includes('class="err"'));
});

test("renderStatusPage: shows the current track when playing", () => {
  const html = renderStatusPage({
    deviceName: "Andrzej #1",
    track: { name: "Hyperdrive", artists: "Voyager", album: "Deep Space", cover: null },
  });
  assert.ok(html.includes("Hyperdrive"));
  assert.ok(html.includes("Voyager"));
  assert.ok(html.includes("Zalinkowano"));
});

test("renderStatusPage: falls back to an idle message with no track", () => {
  const html = renderStatusPage({ deviceName: "Andrzej #1", track: null });
  assert.ok(html.includes("Nic teraz nie gra"));
});

test("renderStatusPage: escapes a hostile track name", () => {
  const html = renderStatusPage({
    deviceName: "Andrzej",
    track: { name: `<img src=x onerror=alert(1)>`, artists: "A", album: "", cover: null },
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x"));
});
