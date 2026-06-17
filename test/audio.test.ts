import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFfmpegArgs } from "../src/audio.js";

test("buildFfmpegArgs: reads the given FIFO and resamples 44.1k → 48k stereo", () => {
  const args = buildFfmpegArgs("/tmp/spotify.fifo");
  // input format
  assert.ok(args.includes("-i"));
  assert.equal(args[args.indexOf("-i") + 1], "/tmp/spotify.fifo");
  // both rates present, output is the last 48000
  assert.ok(args.includes("44100"));
  assert.ok(args.includes("48000"));
  assert.equal(args.at(-1), "pipe:1");
  // s16le on both sides
  assert.ok(args.filter((a) => a === "s16le").length >= 2);
});
