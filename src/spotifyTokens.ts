import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { STATE_BASE_DIR } from "./config.js";

/** One user's persisted Spotify link: their Spotify account id, plus a
 *  long-lived refresh token used to mint fresh access tokens on demand. */
export interface SpotifyTokenEntry {
  spotifyUserId: string;
  refreshToken: string;
}

/** Per-Discord-user Spotify refresh tokens (spotify_token auth mode only). */
export interface SpotifyTokens {
  users: Record<string, SpotifyTokenEntry>;
}

/** A fresh store with nobody linked yet. */
export function emptySpotifyTokens(): SpotifyTokens {
  return { users: {} };
}

/** `userId`'s stored Spotify link, if any (pure). */
export function getSpotifyToken(tokens: SpotifyTokens, userId: string): SpotifyTokenEntry | undefined {
  return tokens.users[userId];
}

/** Set `userId`'s Spotify link (pure — returns a new store). */
export function setSpotifyToken(tokens: SpotifyTokens, userId: string, entry: SpotifyTokenEntry): SpotifyTokens {
  return { users: { ...tokens.users, [userId]: entry } };
}

/**
 * Load the token store from disk, or an empty one if the file doesn't exist
 * yet. A corrupt file is logged and treated as empty rather than crashing.
 */
export function loadSpotifyTokens(path: string = resolve(STATE_BASE_DIR, "spotify-tokens.json")): SpotifyTokens {
  if (!existsSync(path)) return emptySpotifyTokens();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SpotifyTokens;
  } catch (err) {
    console.warn(`[spotify-tokens] failed to parse ${path}, starting fresh: ${(err as Error).message}`);
    return emptySpotifyTokens();
  }
}

/**
 * Persist the token store atomically: write to a temp file then rename over
 * the real path, so a crash mid-write can never leave a torn/partial file.
 */
export function saveSpotifyTokens(
  tokens: SpotifyTokens,
  path: string = resolve(STATE_BASE_DIR, "spotify-tokens.json"),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(tokens, null, 2), "utf8");
  renameSync(tmpPath, path);
}
