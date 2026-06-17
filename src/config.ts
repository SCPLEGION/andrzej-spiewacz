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
} as const;

export type AuthMode = "zeroconf" | "interactive";

export function parseAuthMode(value: string): AuthMode {
  if (value === "zeroconf" || value === "interactive") return value;
  throw new Error(`LIBRESPOT_AUTH must be "zeroconf" or "interactive", got "${value}"`);
}

/** Base URL of the go-librespot HTTP API. */
export const librespotApiBase = `http://${config.librespot.apiHost}:${config.librespot.apiPort}`;

/** go-librespot WebSocket event stream. */
export const librespotEventsUrl = `ws://${config.librespot.apiHost}:${config.librespot.apiPort}/events`;
