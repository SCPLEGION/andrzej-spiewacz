import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STATE_BASE_DIR } from "./config.js";

/**
 * What a linked user wants shown as their voice channel's status while they're
 * streaming: nothing, the current song, or a live-updating lyric line.
 */
export type ChannelStatusMode = "off" | "song" | "lyrics";

/** Per-user channel-status preference. Users default to "off" if absent. */
export interface ChannelStatusPrefs {
  users: Record<string, ChannelStatusMode>;
}

/** A fresh prefs store with no preferences set yet. */
export function emptyChannelStatusPrefs(): ChannelStatusPrefs {
  return { users: {} };
}

/** `userId`'s mode, defaulting to "off" if they've never set one (pure). */
export function getChannelStatusMode(prefs: ChannelStatusPrefs, userId: string): ChannelStatusMode {
  return prefs.users[userId] ?? "off";
}

/**
 * Set `userId`'s mode (pure — returns a new store, does not mutate `prefs`).
 * "off" is the default, so it's dropped from storage rather than persisted.
 */
export function setChannelStatusMode(
  prefs: ChannelStatusPrefs,
  userId: string,
  mode: ChannelStatusMode,
): ChannelStatusPrefs {
  if (mode === "off") {
    if (!(userId in prefs.users)) return prefs;
    const users = { ...prefs.users };
    delete users[userId];
    return { users };
  }
  return { users: { ...prefs.users, [userId]: mode } };
}

/**
 * Load the prefs store from disk, or an empty one if the file doesn't exist
 * yet. A corrupt file is logged and treated as empty rather than crashing.
 */
export function loadChannelStatusPrefs(
  path: string = resolve(STATE_BASE_DIR, "channel-status.json"),
): ChannelStatusPrefs {
  if (!existsSync(path)) return emptyChannelStatusPrefs();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ChannelStatusPrefs;
  } catch (err) {
    console.warn(`[channel-status] failed to parse ${path}, starting fresh: ${(err as Error).message}`);
    return emptyChannelStatusPrefs();
  }
}

/**
 * Persist the prefs store atomically: write to a temp file then rename over
 * the real path, so a crash mid-write can never leave a torn/partial file.
 */
export function saveChannelStatusPrefs(
  prefs: ChannelStatusPrefs,
  path: string = resolve(STATE_BASE_DIR, "channel-status.json"),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(prefs, null, 2), "utf8");
  renameSync(tmpPath, path);
}
