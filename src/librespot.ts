import { spawn, type ChildProcessByStdio, execFile } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { config, librespotApiBase, librespotEventsUrl, type AuthMode } from "./config.js";

const execFileAsync = promisify(execFile);

/** Track metadata emitted by go-librespot's `metadata` event. */
export interface TrackMetadata {
  uri: string;
  name: string;
  artist_names: string[];
  album_name: string;
  album_cover_url: string;
  /** Total duration in milliseconds. */
  duration: number;
  /** Current position in milliseconds. */
  position: number;
}

/** Shape of a go-librespot websocket event frame. */
interface LibrespotEvent {
  type: string;
  data?: unknown;
}

/**
 * Typed events surfaced to the rest of the app. The Discord layer subscribes to
 * these to drive announcements and to know when audio is actually flowing.
 */
export interface LibrespotEvents {
  metadata: [TrackMetadata];
  playing: [];
  paused: [];
  stopped: [];
  /** Spotify Connect session became active (someone selected the device). */
  active: [];
  /** Session released (no controller attached). */
  inactive: [];
  volume: [{ value: number; max: number }];
  ready: [];
  /** Interactive OAuth: the URL the user must open to authorize the device. */
  authUrl: [string];
  /** Fired once credentials are persisted (interactive login completed). */
  authComplete: [];
  exit: [number | null];
}

export const STATE_DIR = resolve("state");
const CONFIG_PATH = resolve(STATE_DIR, "config.yml");
const STATE_FILE = resolve(STATE_DIR, "state.json");

/** True if a go-librespot state JSON blob carries persisted account credentials. */
export function hasCredentialsData(stateJson: string): boolean {
  try {
    const state = JSON.parse(stateJson) as { credentials?: { data?: string } };
    return Boolean(state.credentials?.data);
  } catch {
    return false;
  }
}

/** True if go-librespot already has persisted account credentials on disk. */
export function hasStoredCredentials(): boolean {
  if (!existsSync(STATE_FILE)) return false;
  try {
    return hasCredentialsData(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return false;
  }
}

/** Fields needed to render the go-librespot daemon config. */
export interface LibrespotConfigInput {
  deviceName: string;
  fifoPath: string;
  apiHost: string;
  apiPort: number;
  bitrate: number;
  authMode: AuthMode;
  callbackPort: number;
}

/**
 * Render the daemon's config.yml. Interactive mode disables zeroconf and uses a
 * stored OAuth credential (reachable from any network); zeroconf mode is LAN-only
 * mDNS discovery that persists credentials after the first connect.
 */
export function buildConfigYaml(opts: LibrespotConfigInput): string {
  const { deviceName, fifoPath, apiHost, apiPort, bitrate, authMode, callbackPort } = opts;
  const lines = [
    `device_name: ${JSON.stringify(deviceName)}`,
    `device_type: speaker`,
    `bitrate: ${bitrate}`,
    `audio_backend: pipe`,
    `audio_output_pipe: ${JSON.stringify(fifoPath)}`,
    `audio_output_pipe_format: s16le`,
    `normalisation_disabled: false`,
    `server:`,
    `  enabled: true`,
    `  address: ${JSON.stringify(apiHost)}`,
    `  port: ${apiPort}`,
  ];

  if (authMode === "interactive") {
    lines.push(
      `zeroconf_enabled: false`,
      `credentials:`,
      `  type: interactive`,
      `  interactive:`,
      `    callback_port: ${callbackPort}`,
    );
  } else {
    lines.push(
      `credentials:`,
      `  type: zeroconf`,
      `  zeroconf:`,
      `    persist_credentials: true`,
    );
  }

  return lines.join("\n") + "\n";
}

/** Pull the interactive-OAuth authorization URL out of a daemon log line, if present. */
export function extractAuthUrl(text: string): string | null {
  const match = text.match(/visit the following link:\s*(\S+)/i);
  return match?.[1] ?? null;
}

/** Clamp an arbitrary number to an integer 0–100 percentage. */
export function clampVolumePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** A typed event re-emitted from a raw go-librespot frame, or null to ignore it. */
export type MappedEvent =
  | { event: "metadata"; args: [TrackMetadata] }
  | { event: "playing"; args: [] }
  | { event: "paused"; args: [] }
  | { event: "stopped"; args: [] }
  | { event: "active"; args: [] }
  | { event: "inactive"; args: [] }
  | { event: "volume"; args: [{ value: number; max: number }] };

/** Translate a raw websocket event frame into the app-level event to emit. */
export function mapFrameToEvent(frame: LibrespotEvent): MappedEvent | null {
  switch (frame.type) {
    case "metadata":
      return { event: "metadata", args: [frame.data as TrackMetadata] };
    case "playing":
    case "will_play":
      return { event: "playing", args: [] };
    case "paused":
      return { event: "paused", args: [] };
    case "not_playing":
    case "stopped":
      return { event: "stopped", args: [] };
    case "active":
      return { event: "active", args: [] };
    case "inactive":
      return { event: "inactive", args: [] };
    case "volume":
      return { event: "volume", args: [frame.data as { value: number; max: number }] };
    default:
      return null;
  }
}

export class LibrespotManager extends EventEmitter {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private ws: WebSocket | null = null;
  private wsRetry: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  override emit<K extends keyof LibrespotEvents>(event: K, ...args: LibrespotEvents[K]): boolean {
    return super.emit(event as string, ...args);
  }

  override on<K extends keyof LibrespotEvents>(
    event: K,
    listener: (...args: LibrespotEvents[K]) => void,
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  /** Create the named pipe go-librespot writes PCM into (idempotent). */
  private async ensureFifo(): Promise<void> {
    const { fifoPath } = config.librespot;
    if (existsSync(fifoPath)) {
      if (!statSync(fifoPath).isFIFO()) {
        throw new Error(`${fifoPath} exists but is not a FIFO — remove it and retry.`);
      }
      return;
    }
    await execFileAsync("mkfifo", [fifoPath]);
  }

  /** Write the generated daemon config into state/config.yml. */
  private writeConfig(): void {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, buildConfigYaml(config.librespot), "utf8");
  }

  async start(): Promise<void> {
    if (!existsSync(config.librespot.binPath)) {
      throw new Error(
        `go-librespot binary not found at ${config.librespot.binPath}. ` +
          `Run: npm run install:librespot`,
      );
    }
    await this.ensureFifo();
    this.writeConfig();

    const proc = spawn(config.librespot.binPath, ["--config_dir", STATE_DIR], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => this.handleLog(chunk));
    proc.stderr.on("data", (chunk: Buffer) => this.handleLog(chunk));

    proc.on("exit", (code) => {
      console.warn(`[librespot] daemon exited with code ${code}`);
      this.emit("exit", code);
      if (!this.shuttingDown) {
        // Restart after a short delay so a transient crash self-heals.
        setTimeout(() => void this.start().catch((err) => console.error(err)), 3000);
      }
    });

    // The API server takes a moment to bind; poll until it answers, then
    // attach the websocket.
    await this.waitForApi();
    this.connectEvents();
    this.emit("ready");
  }

  private handleLog(chunk: Buffer): void {
    const text = chunk.toString("utf8").trimEnd();
    if (!text) return;

    // Surface the interactive OAuth authorization link prominently.
    const url = extractAuthUrl(text);
    if (url) {
      console.log(
        `\n${"═".repeat(60)}\n` +
          `  Spotify authorization required — open this URL and log in:\n\n` +
          `  ${url}\n\n` +
          `${"═".repeat(60)}\n`,
      );
      this.emit("authUrl", url);
      return;
    }

    if (/stored credentials/i.test(text)) this.emit("authComplete");

    console.log(`[librespot] ${text}`);
  }

  private async waitForApi(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${librespotApiBase}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 204) return;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("go-librespot API did not come up in time");
  }

  private connectEvents(): void {
    this.ws = new WebSocket(librespotEventsUrl);

    this.ws.on("message", (raw: WebSocket.RawData) => {
      let frame: LibrespotEvent;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.dispatch(frame);
    });

    this.ws.on("close", () => this.scheduleReconnect());
    this.ws.on("error", (err) => console.warn(`[librespot] ws error: ${err.message}`));
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.wsRetry) return;
    this.wsRetry = setTimeout(() => {
      this.wsRetry = null;
      this.connectEvents();
    }, 2000);
  }

  private dispatch(frame: LibrespotEvent): void {
    const mapped = mapFrameToEvent(frame);
    if (!mapped) return;
    // Each branch's args are correctly shaped for its event by construction.
    (this.emit as (event: string, ...args: unknown[]) => boolean)(mapped.event, ...mapped.args);
  }

  // ── HTTP API helpers ────────────────────────────────────────────────────

  private async post(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${librespotApiBase}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`go-librespot ${path} -> ${res.status}`);
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const res = await fetch(`${librespotApiBase}/status`);
    if (!res.ok) throw new Error(`/status -> ${res.status}`);
    // With no Spotify session attached the daemon answers with an empty body.
    const text = await res.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  playpause(): Promise<void> {
    return this.post("/player/playpause");
  }

  next(): Promise<void> {
    return this.post("/player/next");
  }

  prev(): Promise<void> {
    return this.post("/player/prev");
  }

  /** Set volume as a 0–100 percentage. */
  setVolume(percent: number): Promise<void> {
    return this.post("/player/volume", { volume: clampVolumePercent(percent), relative: false });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.wsRetry) clearTimeout(this.wsRetry);
    this.ws?.close();
    this.proc?.kill("SIGTERM");
  }
}
