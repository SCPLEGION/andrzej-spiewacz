import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
  AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { resolve } from "node:path";
import { config, STATE_BASE_DIR, librespotSlot, type LibrespotSlot } from "./config.js";
import { AudioBridge } from "./audio.js";
import { LibrespotManager, hasStoredCredentials, clampVolumePercent, type TrackMetadata } from "./librespot.js";
import { assignSlot, loadRegistry, saveRegistry, type WorkerRegistry } from "./registry.js";
import {
  getChannelStatusMode as getMode,
  setChannelStatusMode as setMode,
  loadChannelStatusPrefs,
  saveChannelStatusPrefs,
  type ChannelStatusMode,
  type ChannelStatusPrefs,
} from "./channelStatusPrefs.js";
import { refreshSpotifyToken } from "./spotifyAuth.js";
import {
  getSpotifyToken,
  setSpotifyToken,
  clearSpotifyToken,
  loadSpotifyTokens,
  saveSpotifyTokens,
  type SpotifyTokenEntry,
  type SpotifyTokens,
} from "./spotifyTokens.js";

/**
 * One independent player: a dedicated go-librespot instance (its own Spotify
 * Connect device + account), an ffmpeg bridge, and a single AudioPlayer. A slot
 * is handed to one guild at a time; that guild's voice connection subscribes to
 * the slot's player. Volume is applied inline on the player so changes are
 * near-instant, independent of every other slot.
 *
 * Emits `track` (TrackMetadata) whenever the underlying Spotify session reports
 * new metadata, so the Discord layer can route a now-playing embed to whichever
 * guild currently holds the slot.
 */
export class PlayerSlot extends EventEmitter {
  readonly librespot: LibrespotManager;
  readonly audio: AudioBridge;
  readonly player: AudioPlayer;

  private currentResource: AudioResource | null = null;
  private volumePercent = 100;
  private authUrl: string | null = null;
  // Local playback clock so the karaoke board can estimate the current position
  // between go-librespot metadata events (which only fire on track changes).
  private positionBaseMs = 0;
  private positionBaseAt = Date.now();
  private playing = false;

  lastTrack: TrackMetadata | null = null;
  /** Discord user this player is permanently assigned to (set once, at creation). */
  assignedUserId: string | null = null;
  /** Guild whose voice connection is currently streaming this slot, or null. */
  activeGuildId: string | null = null;

  constructor(readonly slot: LibrespotSlot) {
    super();
    this.librespot = new LibrespotManager(slot);
    this.audio = new AudioBridge(slot.fifoPath, `#${slot.index}`);
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        // See the original rationale: a high threshold lets the player ride
        // through Spotify pauses (the keep-alive fd holds ffmpeg open) instead
        // of tearing the still-open resource down after ~100 ms of silence.
        maxMissedFrames: Number.MAX_SAFE_INTEGER,
      },
    });
    this.wirePlayer();
    this.wireLibrespot();
  }

  get index(): number {
    return this.slot.index;
  }

  get deviceName(): string {
    return this.slot.deviceName;
  }

  async start(): Promise<void> {
    // librespot must create the FIFO before the bridge opens it / spawns ffmpeg.
    await this.librespot.start();
    this.audio.start();
  }

  async stop(): Promise<void> {
    this.audio.stop();
    await this.librespot.stop();
  }

  // ── State accessors (read by the control panel) ─────────────────────────

  getTrack(): TrackMetadata | null {
    return this.lastTrack;
  }

  isAuthenticated(): boolean {
    return hasStoredCredentials(this.slot.stateDir);
  }

  getAuthUrl(): string | null {
    return this.authUrl;
  }

  /** True while a login is in progress (URL shown, code not yet accepted). */
  isAwaitingCode(): boolean {
    return this.librespot.isAwaitingCode();
  }

  getVolumePercent(): number {
    return this.volumePercent;
  }

  /** Estimated current playback position in ms (extrapolated while playing). */
  estimatedPositionMs(): number {
    return this.playing ? this.positionBaseMs + (Date.now() - this.positionBaseAt) : this.positionBaseMs;
  }

  /**
   * Resync the playback clock from go-librespot's authoritative /status, killing
   * any drift the local extrapolation accumulated (buffering stalls, missed
   * events). Best-effort: on any error the local clock simply keeps running.
   */
  async syncPositionFromStatus(): Promise<void> {
    try {
      const status = await this.librespot.status();
      const track = status.track as { position?: unknown } | undefined;
      const pos = track?.position;
      if (typeof pos !== "number") return;
      const paused = status.paused === true || status.stopped === true;
      this.rebasePosition(pos, !paused);
    } catch {
      // ignore — extrapolation continues from the last known base
    }
  }

  /** Reset the playback clock to a known position and play/pause state. */
  private rebasePosition(ms: number, playing: boolean): void {
    this.positionBaseMs = Math.max(0, ms);
    this.positionBaseAt = Date.now();
    this.playing = playing;
  }

  // ── Playback control ────────────────────────────────────────────────────

  /** Subscribe a guild's voice connection and make sure audio is rolling. */
  subscribe(connection: VoiceConnection): void {
    connection.subscribe(this.player);
    this.playShared();
  }

  /**
   * Set this slot's volume as a 0–100 percentage. Applied inline on the Discord
   * side immediately, and mirrored to go-librespot (best-effort) so the Spotify
   * app's slider reflects it too.
   */
  setVolumePercent(percent: number): void {
    this.volumePercent = clampVolumePercent(percent);
    this.audio.setVolume(this.volumePercent / 100);
    void this.librespot
      .setVolume(this.volumePercent)
      .catch((err) => console.warn(`[slot#${this.index}] volume sync failed: ${(err as Error).message}`));
  }

  /** Start a fresh per-user OAuth on this slot; resolves with the authorize URL. */
  beginRelink(): Promise<string> {
    return this.librespot.beginInteractiveRelink();
  }

  /** Finish linking by submitting the OAuth code the user pasted. */
  submitAuthCode(code: string): Promise<void> {
    return this.librespot.submitAuthCode(code);
  }

  /**
   * First-time start (auth mode "spotify_token"): bring up the audio bridge
   * and go-librespot together, authenticating immediately with a
   * freshly-minted token from our own Spotify app.
   */
  async startWithSpotifyToken(username: string, accessToken: string): Promise<void> {
    this.librespot.setSpotifyToken(username, accessToken);
    await this.librespot.start();
    this.audio.start();
  }

  /**
   * Relink an already-running slot with a new Spotify token — only the
   * go-librespot daemon restarts; the audio bridge is left alone since it
   * just keeps reading from the same FIFO once the new daemon writes to it.
   */
  relinkSpotifyToken(username: string, accessToken: string): Promise<void> {
    return this.librespot.startWithSpotifyToken(username, accessToken);
  }

  playpause(): Promise<void> {
    return this.librespot.playpause();
  }

  next(): Promise<void> {
    return this.librespot.next();
  }

  prev(): Promise<void> {
    return this.librespot.prev();
  }

  // ── Internal wiring ─────────────────────────────────────────────────────

  private wirePlayer(): void {
    this.player.on("error", (err) => console.error(`[slot#${this.index}] player error: ${err.message}`));
    this.player.on(AudioPlayerStatus.Playing, () =>
      console.log(`[slot#${this.index}] playing — audio is flowing`),
    );
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Idle means the resource ended (typically an ffmpeg crash). A fresh
      // resource arrives via the bridge's RESOURCE event once ffmpeg restarts;
      // try the current one in the meantime.
      this.playShared();
    });

    this.audio.on(AudioBridge.RESOURCE, (resource: AudioResource) => {
      this.currentResource = resource;
      this.playShared();
    });
  }

  private wireLibrespot(): void {
    this.librespot.on("metadata", (track) => {
      this.lastTrack = track;
      this.rebasePosition(track.position ?? 0, true);
      this.emit("track", track);
    });
    this.librespot.on("active", () =>
      console.log(`[slot#${this.index}] Spotify Connect session active`),
    );
    this.librespot.on("inactive", () =>
      console.log(`[slot#${this.index}] Spotify Connect session released`),
    );
    // Mirror Spotify transport onto the Discord player so pause/resume is
    // immediate rather than draining the FIFO + ffmpeg buffer first.
    this.librespot.on("paused", () => {
      this.rebasePosition(this.estimatedPositionMs(), false);
      this.player.pause();
    });
    this.librespot.on("stopped", () => {
      this.rebasePosition(this.estimatedPositionMs(), false);
      this.player.pause();
    });
    this.librespot.on("playing", () => {
      this.rebasePosition(this.estimatedPositionMs(), true);
      this.player.unpause();
    });
    // Scrubbing jumps the position without new metadata — resync the clock so
    // the karaoke board snaps to the new spot.
    this.librespot.on("seek", (posMs) => this.rebasePosition(posMs, this.playing));
    // With external_volume the daemon doesn't apply gain to the PCM — it just
    // reports the target. Apply that target inline on our side.
    this.librespot.on("volume", ({ value, max }) => {
      if (max > 0) {
        this.volumePercent = clampVolumePercent((value / max) * 100);
        this.audio.setVolume(value / max);
      }
    });
    this.librespot.on("authUrl", (url) => {
      this.authUrl = url;
    });
    this.librespot.on("authComplete", () => {
      this.authUrl = null;
    });
  }

  /** Start the current resource unless it's missing, ended, or already playing. */
  private playShared(): void {
    const resource = this.currentResource;
    if (!resource || resource.ended) return;
    if (this.player.state.status === AudioPlayerStatus.Playing) return;
    try {
      this.player.play(resource);
    } catch (err) {
      console.error(`[slot#${this.index}] could not start resource: ${(err as Error).message}`);
    }
  }

}

/** 500 ms of 880 Hz sine, 10 ms attack + exponential decay, stereo s16le 48 kHz. */
function generateDingBuffer(): Buffer {
  const rate = 48000;
  const freq = 880;
  const total = Math.floor(rate * 0.5);
  const attack = Math.floor(rate * 0.01);
  const buf = Buffer.alloc(total * 4); // 2 ch × 2 bytes
  for (let i = 0; i < total; i++) {
    const env = i < attack ? i / attack : Math.exp((-6 * (i - attack)) / (total - attack));
    const s = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 20000 * env);
    buf.writeInt16LE(s, i * 4);
    buf.writeInt16LE(s, i * 4 + 2);
  }
  return buf;
}

/**
 * A short 880 Hz ding as a Discord-ready raw audio resource (48 kHz stereo
 * s16le). Played through a throwaway player so it never disturbs a slot's live
 * music resource.
 */
export function createDingResource(): AudioResource {
  const stream = new Readable({ read() {} });
  stream.push(generateDingBuffer());
  stream.push(null);
  return createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: false });
}

/**
 * The pool of per-user players. There's no fixed slot count: the first time a
 * Discord user runs `/link` or `/join`, `getOrCreate` hands them a permanent
 * index (never reused, persisted in `registry.json`) and lazily spawns their
 * own go-librespot daemon on demand. A user's daemon is only running while
 * they're actively linked/joined — `release` stops it on `/leave`, but their
 * index and Spotify credentials persist so the next `/join` recreates the
 * exact same device from their stored token.
 *
 * Emits `playerCreated` (PlayerSlot) exactly once per new instance, so the
 * Discord layer can wire its `track` listener at creation time instead of over
 * a fixed slots array known up front.
 */
export class PlayerPool extends EventEmitter {
  private registry: WorkerRegistry;
  private channelStatusPrefs: ChannelStatusPrefs;
  private spotifyTokens: SpotifyTokens;
  private readonly active = new Map<number, PlayerSlot>();

  constructor(
    private readonly registryPath: string = resolve(STATE_BASE_DIR, "registry.json"),
    private readonly channelStatusPrefsPath: string = resolve(STATE_BASE_DIR, "channel-status.json"),
    private readonly spotifyTokensPath: string = resolve(STATE_BASE_DIR, "spotify-tokens.json"),
  ) {
    super();
    this.registry = loadRegistry(registryPath);
    this.channelStatusPrefs = loadChannelStatusPrefs(channelStatusPrefsPath);
    this.spotifyTokens = loadSpotifyTokens(spotifyTokensPath);
  }

  /** Number of players currently running (linked/joined right now). */
  get size(): number {
    return this.active.size;
  }

  /** Nothing to eagerly start — daemons spin up lazily on first /link or /join. */
  async start(): Promise<void> {}

  async stop(): Promise<void> {
    await Promise.all([...this.active.values()].map((s) => s.stop()));
    this.active.clear();
  }

  /** The running player for `userId`, if their daemon is currently up. */
  slotForUser(userId: string): PlayerSlot | undefined {
    const index = this.registry.users[userId];
    return index === undefined ? undefined : this.active.get(index);
  }

  /** Currently-running players, e.g. for the control panel and shutdown. */
  activePlayers(): PlayerSlot[] {
    return [...this.active.values()];
  }

  /** The running player at a given permanent index, if any (panel lookups). */
  get(index: number): PlayerSlot | undefined {
    return this.active.get(index);
  }

  /** Get-or-construct `userId`'s permanent PlayerSlot record without starting
   *  anything, so callers can tell a brand-new instance from an already-active
   *  one before deciding how to bring it up. */
  private ensureSlotRecord(userId: string): { slot: PlayerSlot; created: boolean } {
    const assigned = assignSlot(this.registry, userId);
    this.registry = assigned.registry;
    if (assigned.created) saveRegistry(this.registry, this.registryPath);

    const existing = this.active.get(assigned.index);
    if (existing) return { slot: existing, created: false };

    const slot = new PlayerSlot(librespotSlot(assigned.index));
    slot.assignedUserId = userId;
    this.active.set(assigned.index, slot);
    this.emit("playerCreated", slot);
    return { slot, created: true };
  }

  /**
   * Get-or-create `userId`'s permanent player: assigns them a never-reused
   * index on first call (persisted to registry.json), then lazily starts their
   * go-librespot daemon if it isn't already running. In "spotify_token" auth
   * mode, a brand-new instance for a user with a stored Spotify link mints a
   * fresh access token and starts already-authenticated; otherwise it starts
   * with whatever credentials (if any) are already on disk for that index.
   * Always succeeds; there's no cap on how many users can have a player.
   */
  async getOrCreate(userId: string): Promise<PlayerSlot> {
    const { slot, created } = this.ensureSlotRecord(userId);
    if (!created) return slot;

    const stored = config.librespot.authMode === "spotify_token" ? getSpotifyToken(this.spotifyTokens, userId) : undefined;
    if (stored) {
      try {
        const accessToken = await this.mintFreshSpotifyAccessToken(userId, stored);
        await slot.startWithSpotifyToken(stored.spotifyUserId, accessToken);
        return slot;
      } catch (err) {
        console.warn(`[pool] couldn't refresh Spotify token for ${userId}, starting unauthenticated: ${(err as Error).message}`);
      }
    }
    await slot.start();
    return slot;
  }

  /**
   * Persist `userId`'s Spotify link (from the link portal's OAuth callback)
   * and (re)start their player with the token we just minted — handles both a
   * brand-new player and relinking one that's already running.
   */
  async linkSpotifyAccount(
    userId: string,
    spotifyUserId: string,
    refreshToken: string,
    accessToken: string,
  ): Promise<PlayerSlot> {
    this.spotifyTokens = setSpotifyToken(this.spotifyTokens, userId, { spotifyUserId, refreshToken });
    saveSpotifyTokens(this.spotifyTokens, this.spotifyTokensPath);

    const { slot, created } = this.ensureSlotRecord(userId);
    if (created) await slot.startWithSpotifyToken(spotifyUserId, accessToken);
    else await slot.relinkSpotifyToken(spotifyUserId, accessToken);
    return slot;
  }

  /**
   * True once `userId` has a usable Spotify login: a stored refresh token in
   * "spotify_token" auth mode, or go-librespot's own persisted credentials
   * otherwise. Independent of whether their daemon is currently running.
   */
  isUserAuthenticated(userId: string): boolean {
    if (config.librespot.authMode === "spotify_token") {
      return getSpotifyToken(this.spotifyTokens, userId) !== undefined;
    }
    return this.slotForUser(userId)?.isAuthenticated() ?? false;
  }

  /**
   * Forget `userId`'s stored Spotify refresh token (spotify_token mode only —
   * in interactive mode the daemon's own credentials just get overwritten by
   * the next relink, same as before). Their permanent device index is
   * untouched: /link or the portal's "Link Spotify" button can connect a
   * different account to the same device. Callers are expected to have
   * already stopped the player themselves (e.g. via release()) if it's running.
   */
  clearSpotifyLink(userId: string): void {
    if (getSpotifyToken(this.spotifyTokens, userId) === undefined) return;
    this.spotifyTokens = clearSpotifyToken(this.spotifyTokens, userId);
    saveSpotifyTokens(this.spotifyTokens, this.spotifyTokensPath);
  }

  /** Mint a fresh access token from `stored`'s refresh token, persisting a
   *  rotated refresh token if Spotify issued a new one. */
  private async mintFreshSpotifyAccessToken(userId: string, stored: SpotifyTokenEntry): Promise<string> {
    const fresh = await refreshSpotifyToken({
      clientId: config.spotify.clientId,
      clientSecret: config.spotify.clientSecret,
      refreshToken: stored.refreshToken,
    });
    if (fresh.refreshToken && fresh.refreshToken !== stored.refreshToken) {
      this.spotifyTokens = setSpotifyToken(this.spotifyTokens, userId, { ...stored, refreshToken: fresh.refreshToken });
      saveSpotifyTokens(this.spotifyTokens, this.spotifyTokensPath);
    }
    return fresh.accessToken;
  }

  /**
   * Stop whatever player `userId` currently has running. Their permanent index
   * and Spotify credentials are untouched — the next /join or /link recreates
   * the same device from the same stored token.
   */
  async release(userId: string): Promise<void> {
    const index = this.registry.users[userId];
    if (index === undefined) return;
    const slot = this.active.get(index);
    if (!slot) return;
    this.active.delete(index);
    slot.activeGuildId = null;
    await slot.stop();
  }

  /** What `userId` wants shown as their voice channel's status ("off" by default). */
  getChannelStatusMode(userId: string): ChannelStatusMode {
    return getMode(this.channelStatusPrefs, userId);
  }

  /**
   * Set `userId`'s channel-status preference, persisting it and emitting
   * `channelStatusModeChanged` so the Discord layer can apply it immediately
   * if that user is currently streaming, rather than waiting for their next
   * track change.
   */
  setChannelStatusMode(userId: string, mode: ChannelStatusMode): void {
    this.channelStatusPrefs = setMode(this.channelStatusPrefs, userId, mode);
    saveChannelStatusPrefs(this.channelStatusPrefs, this.channelStatusPrefsPath);
    this.emit("channelStatusModeChanged", userId, mode);
  }
}
