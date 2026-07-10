import "dotenv/config";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    /** Empty string => register commands globally. */
    guildId: optional("DISCORD_GUILD_ID", ""),
  },
  librespot: {
    deviceName: optional("LIBRESPOT_DEVICE_NAME", "Andrzej Śpiewacz"),
    binPath: resolve(optional("LIBRESPOT_BIN", "./bin/go-librespot")),
    apiHost: optional("LIBRESPOT_API_HOST", "127.0.0.1"),
    apiPort: Number(optional("LIBRESPOT_API_PORT", "3678")),
    fifoPath: optional("LIBRESPOT_FIFO", "/tmp/andrzej-spiewacz.fifo"),
    bitrate: Number(optional("LIBRESPOT_BITRATE", "320")),
    /**
     * "zeroconf" — device only visible on the same LAN (mDNS).
     * "interactive" — OAuth login once, then reachable from ANY network via
     * Spotify's servers. Use this for a remote/headless host.
     */
    authMode: parseAuthMode(optional("LIBRESPOT_AUTH", "interactive")),
    /** Fixed loopback port for the interactive OAuth redirect. */
    callbackPort: Number(optional("LIBRESPOT_CALLBACK_PORT", "38080")),
  },
  panel: {
    /** Set PANEL_ENABLED=false to disable the web control/auth panel. */
    enabled: optional("PANEL_ENABLED", "true").toLowerCase() !== "false",
    /** Bind address. Loopback by default — SSH-tunnel it for remote access. */
    host: optional("PANEL_HOST", "127.0.0.1"),
    port: Number(optional("PANEL_PORT", "8077")),
  },
  /** Public web page that replaces /code: finishes Spotify OAuth by pasting
   * the redirected URL, and shows the caller's own player status afterward. */
  linkPortal: {
    enabled: optional("LINK_PORTAL_ENABLED", "true").toLowerCase() !== "false",
    /** Binds all interfaces by default (unlike the admin panel) — this is
     * meant to sit behind a reverse proxy / public domain, which is the thing
     * that should actually be exposed to the internet. */
    host: optional("LINK_PORTAL_HOST", "0.0.0.0"),
    port: Number(optional("LINK_PORTAL_PORT", "8078")),
    /** Public HTTPS origin your reverse proxy serves this on, e.g.
     * "https://spiewacz.scplegion.ovh". Required for /link to produce a
     * usable link — left empty, the portal refuses to start. */
    baseUrl: optional("LINK_PORTAL_BASE_URL", ""),
  },
  karaoke: {
    /**
     * Milliseconds the heard audio lags go-librespot's decode position (FIFO +
     * ffmpeg + Discord jitter buffer). Subtracted from the playback clock so the
     * highlighted lyric line matches what listeners actually hear. Tune per host;
     * raise it if lyrics run ahead of the audio, lower it if they trail behind.
     * Can be nudged live per board via `/lyrics offset:<ms>`.
     */
    syncOffsetMs: Number(optional("KARAOKE_SYNC_OFFSET_MS", "1000")),
  },
} as const;

export type AuthMode = "zeroconf" | "interactive";

export function parseAuthMode(value: string): AuthMode {
  if (value === "zeroconf" || value === "interactive") return value;
  throw new Error(`LIBRESPOT_AUTH must be "zeroconf" or "interactive", got "${value}"`);
}

/** Base URL of the go-librespot HTTP API (slot 0). */
export const librespotApiBase = `http://${config.librespot.apiHost}:${config.librespot.apiPort}`;

/** go-librespot WebSocket event stream (slot 0). */
export const librespotEventsUrl = `ws://${config.librespot.apiHost}:${config.librespot.apiPort}/events`;

/** Base directory holding each slot's go-librespot config + credentials. */
export const STATE_BASE_DIR = resolve("state");

/**
 * Fully-resolved config for one player slot. Slot 0 reuses the legacy paths/ports
 * (and the existing `state/` credentials) for backward compatibility; each
 * further slot is offset so its API port, OAuth callback port, FIFO and
 * credential directory never collide with another slot.
 */
export interface LibrespotSlot {
  index: number;
  deviceName: string;
  binPath: string;
  apiHost: string;
  apiPort: number;
  fifoPath: string;
  bitrate: number;
  authMode: AuthMode;
  callbackPort: number;
  /** go-librespot --config_dir for this slot (holds its config.yml + state.json). */
  stateDir: string;
}

/** Device name for a slot: the base name suffixed with a 1-based slot number
 * (the pool is open-ended now, so slots are always numbered). */
export function slotDeviceName(base: string, index: number): string {
  return `${base} #${index + 1}`;
}

/** Derive the config for slot `index` from the base librespot settings. */
export function librespotSlot(index: number): LibrespotSlot {
  const b = config.librespot;
  return {
    index,
    deviceName: slotDeviceName(b.deviceName, index),
    binPath: b.binPath,
    apiHost: b.apiHost,
    apiPort: b.apiPort + index,
    fifoPath: index === 0 ? b.fifoPath : `${b.fifoPath}.${index}`,
    bitrate: b.bitrate,
    authMode: b.authMode,
    callbackPort: b.callbackPort + index,
    stateDir: index === 0 ? STATE_BASE_DIR : resolve(STATE_BASE_DIR, String(index)),
  };
}

/** Base URL of a given slot's go-librespot HTTP API. */
export function slotApiBase(slot: LibrespotSlot): string {
  return `http://${slot.apiHost}:${slot.apiPort}`;
}

/** WebSocket event stream URL for a given slot. */
export function slotEventsUrl(slot: LibrespotSlot): string {
  return `ws://${slot.apiHost}:${slot.apiPort}/events`;
}
