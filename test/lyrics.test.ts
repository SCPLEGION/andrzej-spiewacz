import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLrc,
  currentLineIndex,
  renderKaraoke,
  fetchLyrics,
  simplifyTitle,
} from "../src/lyrics.js";

test("simplifyTitle strips remaster/live/feat/bracket noise", () => {
  assert.equal(simplifyTitle("Riptide"), "Riptide");
  assert.equal(simplifyTitle("Let It Be - Remastered 2009"), "Let It Be");
  assert.equal(simplifyTitle("Hello (feat. Adele)"), "Hello");
  assert.equal(simplifyTitle("Song [Live]"), "Song");
});

test("parseLrc parses timestamps, expands multi-stamp lines, sorts, drops metadata", () => {
  const lrc = [
    "[ar:Some Artist]",
    "[00:12.50]Hello",
    "[00:10.00][00:40.00]Repeat",
    "no timestamp here",
    "[01:05.20]End",
  ].join("\n");
  assert.deepEqual(parseLrc(lrc), [
    { timeMs: 10000, text: "Repeat" },
    { timeMs: 12500, text: "Hello" },
    { timeMs: 40000, text: "Repeat" },
    { timeMs: 65200, text: "End" },
  ]);
});

test("currentLineIndex returns the last passed line, -1 before the first", () => {
  const lines = [
    { timeMs: 1000, text: "a" },
    { timeMs: 2000, text: "b" },
    { timeMs: 3000, text: "c" },
  ];
  assert.equal(currentLineIndex(lines, 0), -1);
  assert.equal(currentLineIndex(lines, 1500), 0);
  assert.equal(currentLineIndex(lines, 2000), 1);
  assert.equal(currentLineIndex(lines, 99999), 2);
});

test("renderKaraoke marks the active line and shows surrounding context", () => {
  const lines = [0, 1, 2, 3, 4, 5].map((n) => ({ timeMs: n * 1000, text: `L${n}` }));
  const out = renderKaraoke(lines, 2);
  assert.ok(out.includes("▶"), "has the active-line marker");
  assert.ok(out.includes("L2"), "shows the active line");
  assert.ok(out.includes("L1"), "shows a line before");
  assert.ok(out.includes("L4"), "shows a line after");
});

/** Minimal fetch Response stand-in for getJson (uses only .ok/.status/.text). */
function fakeJson(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === null ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

test("fetchLyrics prefers LRCLIB synced lyrics and skips later providers", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("lrclib.net/api/get")) {
      return fakeJson({ syncedLyrics: "[00:01.00]Hi there", plainLyrics: "Hi there" });
    }
    return fakeJson(null, 404);
  }) as unknown as typeof fetch;
  try {
    const r = await fetchLyrics({ artist: "A", title: "T" });
    assert.equal(r?.source, "LRCLIB");
    assert.ok(r?.lines?.length);
    assert.ok(!calls.some((u) => u.includes("lyrics.ovh")), "lyrics.ovh not queried");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchLyrics falls back to lyrics.ovh plain text when no synced lyrics exist", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("lrclib")) return fakeJson(u.includes("search") ? [] : null, u.includes("search") ? 200 : 404);
    if (u.includes("lyrics.ovh")) return fakeJson({ lyrics: "la la la" });
    return fakeJson(null, 404);
  }) as unknown as typeof fetch;
  try {
    const r = await fetchLyrics({ artist: "A", title: "T" });
    assert.equal(r?.source, "lyrics.ovh");
    assert.equal(r?.lines, null);
    assert.match(r?.plain ?? "", /la la la/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
