import { spawn, type ChildProcessByStdio, execFile } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  STATE_BASE_DIR,
  librespotSlot,
  slotApiBase,
  slotEventsUrl,
  type AuthMode,
  type LibrespotSlot,
} from "./config.js";

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
  /** User scrubbed the track; payload is the new position in milliseconds. */
  seek: [number];
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

/** Legacy base state dir (slot 0). Kept as an export for external references. */
export const STATE_DIR = STATE_BASE_DIR;

/** True if a go-librespot state JSON blob carries persisted account credentials. */
export function hasCredentialsData(stateJson: string): boolean {
  try {
    const state = JSON.parse(stateJson) as { credentials?: { data?: string } };
    return Boolean(state.credentials?.data);
  } catch {
    return false;
  }
}

/**
 * True if go-librespot already has persisted account credentials on disk for the
 * given state dir (defaults to the legacy `state/` slot-0 location).
 */
export function hasStoredCredentials(stateDir: string = STATE_DIR): boolean {
  const stateFile = resolve(stateDir, "state.json");
  if (!existsSync(stateFile)) return false;
  try {
    return hasCredentialsData(readFileSync(stateFile, "utf8"));
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
    // Volume is applied on the Discord side (inline, near-zero latency). With
    // external_volume the daemon emits full-scale PCM and only *reports* the
    // volume value, so a slider move no longer has to drain the FIFO + ffmpeg
    // buffer before it's audible.
    `external_volume: true`,
    // Pin the step count so /player/volume takes a straight 0..100 and the
    // echoed volume event reports max:100 — never the daemon's internal 65535
    // scale, which would otherwise clobber our inline Discord gain to ~0.
    `volume_steps: 100`,
    `initial_volume: 100`,
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

/**
 * Pull the OAuth `code` out of whatever the user pasted — either the full
 * browser redirect URL (`http://127.0.0.1:38080/login?code=ABC&...`) or a bare
 * code. Returns null if nothing usable is found.
 */
export function extractAuthCode(input: string): string | null {
  const trimmed = input.trim();
  const inUrl = trimmed.match(/[?&]code=([^&\s]+)/);
  if (inUrl?.[1]) return decodeURIComponent(inUrl[1]);
  // A bare token: no spaces, plausible length, URL-safe characters only.
  if (/^[A-Za-z0-9._~-]+$/.test(trimmed) && trimmed.length >= 10) return trimmed;
  return null;
}

/** Clamp an arbitrary number to an integer 0–100 percentage. */
export function clampVolumePercent(percent: number): number {
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** True if a fetch rejection was a refused/reset connection (callback not bound yet). */
export function isConnectionRefused(err: unknown): boolean {
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code
    ?? (err as { code?: string })?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET";
}

/** A typed event re-emitted from a raw go-librespot frame, or null to ignore it. */
export type MappedEvent =
  | { event: "metadata"; args: [TrackMetadata] }
  | { event: "playing"; args: [] }
  | { event: "paused"; args: [] }
  | { event: "stopped"; args: [] }
  | { event: "seek"; args: [number] }
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
    case "seek": {
      // go-librespot's seek payload carries the new position (ms); ignore the
      // frame if it's missing or malformed rather than emitting a bad resync.
      const pos = (frame.data as { position?: unknown })?.position;
      return typeof pos === "number" ? { event: "seek", args: [pos] } : null;
    }
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
  private restartTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;
  /** Bumped on every (re)start; a stale attach loop bails when it sees a newer gen. */
  private attachGen = 0;
  /** Set while an interactive relink is mid-flight, so concurrent /link calls coalesce. */
  private relinkInFlight: Promise<string> | null = null;
  /** True between emitting the auth URL and credentials being persisted. */
  private awaitingCode = false;

  private readonly apiBase: string;
  private readonly eventsUrl: string;
  private readonly configPath: string;

  /**
   * @param slot fully-resolved per-slot config (device name, ports, FIFO,
   *   credential dir). Defaults to slot 0 so single-player callers and the
   *   one-off login script keep working unchanged.
   */
  constructor(private readonly slot: LibrespotSlot = librespotSlot(0)) {
    super();
    this.apiBase = slotApiBase(slot);
    this.eventsUrl = slotEventsUrl(slot);
    this.configPath = resolve(slot.stateDir, "config.yml");
  }

  /** This manager's slot config (device name, ports, state dir). */
  get slotConfig(): LibrespotSlot {
    return this.slot;
  }

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
    const { fifoPath } = this.slot;
    if (existsSync(fifoPath)) {
      if (!statSync(fifoPath).isFIFO()) {
        throw new Error(`${fifoPath} exists but is not a FIFO — remove it and retry.`);
      }
      return;
    }
    await execFileAsync("mkfifo", [fifoPath]);
  }

  /** Write the generated daemon config into this slot's config dir. */
  private writeConfig(): void {
    mkdirSync(this.slot.stateDir, { recursive: true });
    writeFileSync(this.configPath, buildConfigYaml(this.slot), "utf8");
  }

  async start(): Promise<void> {
    if (!existsSync(this.slot.binPath)) {
      throw new Error(
        `go-librespot binary not found at ${this.slot.binPath}. ` +
          `Run: npm run install:librespot`,
      );
    }
    await this.ensureFifo();
    this.writeConfig();

    const proc = spawn(this.slot.binPath, ["--config_dir", this.slot.stateDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;

    proc.stdout.on("data", (chunk: Buffer) => this.handleLog(chunk));
    proc.stderr.on("data", (chunk: Buffer) => this.handleLog(chunk));

    proc.on("exit", (code) => {
      // Only react to the exit of the daemon we currently own. A relink or a
      // prior restart may have already replaced this.proc; a stale handler must
      // not schedule a restart that would collide with the live daemon's ports.
      if (this.proc !== proc) return;
      this.proc = null;
      console.warn(`[librespot#${this.slot.index}] daemon exited with code ${code}`);
      this.emit("exit", code);
      if (!this.shuttingDown) {
        // Restart after a short delay so a transient crash self-heals.
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.shuttingDown) void this.start().catch((err) => console.error(err));
        }, 3000);
      }
    });

    // Attach to the event/API server once it binds — in the BACKGROUND so an
    // un-logged-in interactive slot (one still awaiting OAuth, which may bind its
    // API only after the user completes login) never blocks startup of the other
    // slots or the Discord login. Events simply start flowing once it's up. The
    // generation token lets a fresh start() invalidate any earlier poll loop.
    const gen = ++this.attachGen;
    void this.attachWhenReady(gen);
    this.emit("ready");
  }

  /** Poll the API until it answers (or we shut down / are superseded), then attach the websocket. */
  private async attachWhenReady(gen: number): Promise<void> {
    while (!this.shuttingDown && gen === this.attachGen) {
      try {
        const res = await fetch(`${this.apiBase}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 204) break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!this.shuttingDown && gen === this.attachGen) this.connectEvents();
  }

  /**
   * Force a fresh interactive OAuth: wipe stored credentials, relaunch the
   * daemon, and resolve with the new authorization URL. The daemon keeps running
   * in the background waiting for submitAuthCode(). Rejects if no URL appears.
   */
  async beginInteractiveRelink(timeoutMs = 30_000): Promise<string> {
    // Serialize relinks on this slot: a second /link arriving while one is
    // mid-flight coalesces onto the same pending URL instead of racing the
    // daemon teardown (two daemons would collide on the API/callback ports).
    if (this.relinkInFlight) return this.relinkInFlight;
    this.relinkInFlight = this.doRelink(timeoutMs);
    this.relinkInFlight.catch(() => {}).finally(() => {
      this.relinkInFlight = null;
    });
    return this.relinkInFlight;
  }

  private async doRelink(timeoutMs: number): Promise<string> {
    // Tear the current daemon down deterministically. attachGen++ invalidates
    // any in-flight poll loop; killProc detaches the old proc and WAITS for it
    // to actually exit so the replacement doesn't hit EADDRINUSE on the ports.
    this.shuttingDown = true;
    this.attachGen++;
    if (this.wsRetry) { clearTimeout(this.wsRetry); this.wsRetry = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.ws?.close();
    this.ws = null;
    await this.killProc();
    this.wipeCredentials();
    this.awaitingCode = false;

    let resolveUrl!: (url: string) => void;
    let rejectUrl!: (err: Error) => void;
    const urlPromise = new Promise<string>((res, rej) => {
      resolveUrl = res;
      rejectUrl = rej;
    });
    const onUrl = (url: string): void => {
      clearTimeout(timer);
      resolveUrl(url);
    };
    const timer = setTimeout(() => {
      this.off("authUrl", onUrl);
      // Tear the half-spawned daemon down FULLY before settling. Rejecting only
      // after stop() completes keeps the serializing relinkInFlight promise
      // pending through teardown, so a concurrent /link can't spawn a second
      // daemon (port collision) while this one is still being killed.
      void this.stop().finally(() =>
        rejectUrl(new Error("timed out waiting for the Spotify authorization link")),
      );
    }, timeoutMs);
    this.once("authUrl", onUrl);

    this.shuttingDown = false;
    // start() returns immediately (the websocket attaches in the background once
    // the API binds, which for an un-logged-in slot only happens after the user
    // submits the code). The URL we need is emitted from the daemon logs first.
    // If start() itself fails outright (binary missing, mkfifo denied, …) there's
    // no daemon to ever emit that URL — surface the real error immediately
    // instead of leaving the caller to wait out the full timeout for a generic
    // "timed out" message.
    void this.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[librespot#${this.slot.index}] relink: ${message}`);
      clearTimeout(timer);
      this.off("authUrl", onUrl);
      void this.stop().finally(() => rejectUrl(err instanceof Error ? err : new Error(message)));
    });
    return urlPromise;
  }

  /**
   * Stop the daemon we currently own and resolve only once it has actually
   * exited. SIGTERM is escalated to SIGKILL after a grace period because
   * go-librespot ignores SIGTERM while it is awaiting interactive OAuth.
   */
  private killProc(graceMs = 2500): Promise<void> {
    const proc = this.proc;
    // Detach our ownership first so the start() exit handler treats it as stale
    // (this.proc !== proc) and never schedules an auto-restart for it.
    this.proc = null;
    if (!proc) return Promise.resolve();
    return new Promise<void>((resolvePromise) => {
      const escalate = setTimeout(() => proc.kill("SIGKILL"), graceMs);
      proc.once("exit", () => {
        clearTimeout(escalate);
        resolvePromise();
      });
      proc.kill("SIGTERM");
    });
  }

  /** True while the daemon has shown an auth URL but no credentials are stored yet. */
  isAwaitingCode(): boolean {
    return this.awaitingCode;
  }

  /**
   * Complete an interactive login by handing the OAuth code to the daemon's
   * loopback callback server (the bot shares the daemon's host). The callback
   * answers 200 the instant it accepts the request — BEFORE the token exchange
   * with Spotify runs — so success is confirmed by waiting for credentials to
   * actually be persisted, not by the HTTP status.
   */
  async submitAuthCode(code: string): Promise<void> {
    const url = `http://${this.slot.apiHost}:${this.slot.callbackPort}/login?code=${encodeURIComponent(code)}`;
    // The callback socket may bind a beat after the URL is shown; retry on a
    // refused connection rather than failing the user's first paste.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`auth callback responded ${res.status}`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (!isConnectionRefused(err)) throw err; // a real HTTP error is terminal
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (lastErr) {
      throw new Error(
        `couldn't reach the login callback — is a /link still in progress? (${(lastErr as Error).message})`,
      );
    }
    await this.waitForAuthComplete(20_000);
  }

  /** Resolve once credentials are persisted (authComplete / state.json), else reject on timeout. */
  private waitForAuthComplete(timeoutMs: number): Promise<void> {
    if (hasStoredCredentials(this.slot.stateDir)) return Promise.resolve();
    return new Promise<void>((resolvePromise, reject) => {
      const cleanup = (): void => {
        clearInterval(poll);
        clearTimeout(timer);
        this.off("authComplete", onComplete);
      };
      const onComplete = (): void => {
        cleanup();
        resolvePromise();
      };
      // Belt-and-suspenders: also poll the credential file in case the log line
      // that drives authComplete is worded differently across daemon versions.
      const poll = setInterval(() => {
        if (hasStoredCredentials(this.slot.stateDir)) {
          cleanup();
          resolvePromise();
        }
      }, 500);
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error("the code was accepted but Spotify never confirmed the login (it may have expired)"),
        );
      }, timeoutMs);
      this.once("authComplete", onComplete);
    });
  }

  private wipeCredentials(): void {
    const stateFile = resolve(this.slot.stateDir, "state.json");
    try {
      if (existsSync(stateFile)) rmSync(stateFile);
    } catch (err) {
      console.warn(`[librespot#${this.slot.index}] could not wipe credentials: ${(err as Error).message}`);
    }
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
      this.awaitingCode = true;
      this.emit("authUrl", url);
      return;
    }

    if (/stored credentials/i.test(text)) {
      this.awaitingCode = false;
      this.emit("authComplete");
    }

    console.log(`[librespot#${this.slot.index}] ${text}`);
  }

  private connectEvents(): void {
    // Drop any previous socket first so a stale connection can't keep dispatching
    // duplicate events alongside the new one.
    this.ws?.close();
    this.ws = new WebSocket(this.eventsUrl);

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
    this.ws.on("error", (err) =>
      console.warn(`[librespot#${this.slot.index}] ws error: ${err.message}`),
    );
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.wsRetry) return;
    this.wsRetry = setTimeout(() => {
      this.wsRetry = null;
      // A relink/stop may have flipped shuttingDown while this was queued; don't
      // resurrect a websocket onto a daemon we're tearing down or replacing.
      if (!this.shuttingDown) this.connectEvents();
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
    const res = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`go-librespot ${path} -> ${res.status}`);
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.apiBase}/status`);
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

  /**
   * Set volume as a 0–100 percentage. go-librespot's `/player/volume` takes a
   * value in 0..`volume_steps` (we leave that at its default of 100), so the
   * percent maps straight through. Scaling to 65535 here would saturate the
   * daemon's max — it would report 100% back and the echoed volume event would
   * clobber our inline Discord-side gain.
   */
  setVolume(percent: number): Promise<void> {
    return this.post("/player/volume", { volume: clampVolumePercent(percent) });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    this.attachGen++;
    if (this.wsRetry) { clearTimeout(this.wsRetry); this.wsRetry = null; }
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    this.ws?.close();
    this.ws = null;
    await this.killProc();
  }
}
