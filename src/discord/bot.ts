import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
  Routes,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextBasedChannel,
  type Message,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  DiscordGatewayAdapterCreator,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} from "@discordjs/voice";
import { config } from "../config.js";
import type { TrackMetadata } from "../librespot.js";
import { createDingResource, type PlayerPool, type PlayerSlot } from "../pool.js";
import type { ChannelStatusMode } from "../channelStatusPrefs.js";
import {
  fetchLyrics,
  renderKaraoke,
  currentLineIndex,
  type LrcLine,
  type LyricsResult,
} from "../lyrics.js";

/** How often to re-check the current lyric line for the "lyrics" channel-status mode. */
const STATUS_LYRICS_TICK_MS = 2_000;
/** Minimum time between actual Discord voice-status API calls (that endpoint
 *  is rate-limited; this also keeps a fast-scrolling song from spamming it). */
const STATUS_LYRICS_MIN_PUSH_INTERVAL_MS = 8_000;
/** Discord's voice-status field caps at 500 chars; keep ours well short of that. */
const STATUS_TEXT_MAX_LEN = 100;

/** Tracks the live lyric line fed into a slot's voice-channel status. */
interface StatusLyricsTracker {
  trackUri: string;
  channelId: string;
  lines: LrcLine[];
  lastPushedIndex: number;
  lastPushedAt: number;
}

/** One guild streaming from an allocated player slot. */
interface GuildSession {
  connection: VoiceConnection;
  slot: PlayerSlot;
  /** Discord user who owns the slot streaming in this guild. */
  userId: string;
  guildName: string;
  channelName: string;
  /** Text channel to post now-playing embeds into, if any. */
  announce: TextBasedChannel | null;
}

/** A live karaoke board updating in place for one slot's current track. */
interface KaraokeSession {
  slotIndex: number;
  trackUri: string;
  title: string;
  artists: string;
  cover: string | null;
  source: string;
  lines: LrcLine[];
  message: Message;
  timer: NodeJS.Timeout;
  /** Last rendered line index, so unchanged ticks skip the Discord edit. */
  lastIndex: number;
  /** ms subtracted from the playback clock to match the heard audio. */
  offsetMs: number;
  /** Tick counter, used to schedule periodic /status resyncs. */
  ticks: number;
  /** Timestamp of the last Discord edit, to rate-limit message edits. */
  lastEditAt: number;
}

/** Public view of a streaming guild, surfaced to the control panel. */
export interface GuildView {
  id: string;
  name: string;
  channel: string;
}

export class DiscordBot {
  private readonly client: Client;
  private readonly sessions = new Map<string, GuildSession>();
  /** Active karaoke boards, keyed by player-slot index. */
  private readonly karaoke = new Map<number, KaraokeSession>();
  /** Live lyric-line trackers driving "lyrics" mode channel statuses, keyed by slot index. */
  private readonly statusLyrics = new Map<number, StatusLyricsTracker>();
  /** Slot indices whose voice-channel status we've actually set (so we know to clear it). */
  private readonly statusOwned = new Set<number>();
  private readonly statusTickTimer: NodeJS.Timeout;

  constructor(private readonly pool: PlayerPool) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    // Players spin up lazily (one per user, on their first /link or /join), so
    // wire each one's now-playing routing and karaoke follow-along at creation
    // time rather than over a fixed slots array known up front.
    this.pool.on("playerCreated", (slot: PlayerSlot) => {
      slot.on("track", (track: TrackMetadata) => {
        void this.announceNowPlaying(slot, track);
        void this.refreshKaraoke(slot, track);
        void this.updateChannelStatus(slot, track);
      });
    });
    // A mode toggled from the link portal should apply immediately if that
    // user is already streaming, not wait for their next track change.
    this.pool.on("channelStatusModeChanged", (userId: string) => {
      const slot = this.pool.slotForUser(userId);
      if (slot) void this.updateChannelStatus(slot, slot.getTrack());
    });
    this.statusTickTimer = setInterval(() => this.tickAllStatusLyrics(), STATUS_LYRICS_TICK_MS);

    this.wireDiscordEvents();
  }

  async login(): Promise<void> {
    await this.client.login(config.discord.token);
  }

  async destroy(): Promise<void> {
    for (const session of this.sessions.values()) session.connection.destroy();
    this.sessions.clear();
    for (const k of this.karaoke.values()) clearInterval(k.timer);
    this.karaoke.clear();
    clearInterval(this.statusTickTimer);
    this.statusLyrics.clear();
    await this.client.destroy();
  }

  // ── State accessors (read by the control panel) ─────────────────────────

  /** Guilds currently streaming, keyed for cross-reference with pool slots. */
  getConnectedGuilds(): GuildView[] {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      name: s.guildName,
      channel: s.channelName,
    }));
  }

  /** Display label for the guild currently holding a slot, or null. */
  guildLabel(guildId: string | null): { name: string; channel: string } | null {
    if (!guildId) return null;
    const s = this.sessions.get(guildId);
    return s ? { name: s.guildName, channel: s.channelName } : null;
  }

  /**
   * Play a diagnostic ding into the guild's voice channel. Routed through a
   * throwaway player subscribed to the connection, then the slot's main player
   * is re-subscribed — so a live Spotify stream is never torn down. Returns
   * false when the guild isn't currently streaming.
   */
  playTestTone(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    const tonePlayer = createAudioPlayer();
    let restored = false;
    const restore = (): void => {
      if (restored) return; // Idle and error can both fire; only restore once.
      restored = true;
      tonePlayer.stop(true);
      // Hand the connection back to the slot's player only if it's still this
      // guild's active connection (a /leave during the ~0.5s tone may have
      // replaced or destroyed it).
      if (this.sessions.get(guildId)?.connection === session.connection) {
        session.slot.subscribe(session.connection);
      }
    };
    tonePlayer.on(AudioPlayerStatus.Idle, restore);
    tonePlayer.on("error", (err) => {
      console.error(`[discord] test tone error: ${err.message}`);
      restore();
    });
    session.connection.subscribe(tonePlayer);
    tonePlayer.play(createDingResource());
    return true;
  }

  // ── go-librespot → Discord announcements ────────────────────────────────

  /** Post the now-playing embed to the guild that currently holds `slot`. */
  private async announceNowPlaying(slot: PlayerSlot, track: TrackMetadata): Promise<void> {
    const guildId = slot.activeGuildId;
    if (!guildId) return;
    const session = this.sessions.get(guildId);
    if (!session?.announce?.isSendable()) return;
    await session.announce.send({ embeds: [this.nowPlayingEmbed(track)] }).catch(() => {});
  }

  private nowPlayingEmbed(track: TrackMetadata): EmbedBuilder {
    const artists = track.artist_names?.join(", ") || "Unknown artist";
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setAuthor({ name: "Now playing" })
      .setTitle(track.name || "Unknown track")
      .setDescription(`${artists}\n*${track.album_name ?? ""}*`);
    if (track.album_cover_url) embed.setThumbnail(track.album_cover_url);
    return embed;
  }

  // ── Discord interactions ────────────────────────────────────────────────

  private wireDiscordEvents(): void {
    this.client.once("clientReady", (c) => {
      console.log(`[discord] logged in as ${c.user.tag} (${this.pool.size} player(s) running)`);
    });

    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        await this.handleCommand(interaction);
      } catch (err) {
        console.error(err);
        const msg = "Something broke handling that command.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: msg, ephemeral: true }).catch(() => {});
        } else {
          await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
        }
      }
    });
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "join":
        return this.cmdJoin(interaction);
      case "link":
        return this.cmdLink(interaction);
      case "leave":
        return this.cmdLeave(interaction);
      case "np":
        return this.cmdNowPlaying(interaction);
      case "lyrics":
        return this.cmdLyrics(interaction);
      case "device":
        return this.cmdDevice(interaction);
      case "playpause":
        return this.cmdTransport(interaction, (s) => s.playpause(), "⏯️ Toggled.");
      case "skip":
        return this.cmdTransport(interaction, (s) => s.next(), "⏭️ Skipped.");
      case "prev":
        return this.cmdTransport(interaction, (s) => s.prev(), "⏮️ Previous.");
      case "volume": {
        const percent = interaction.options.getInteger("percent", true);
        const slot = this.requireSlot(interaction);
        if (!slot) return;
        slot.setVolumePercent(percent);
        return void interaction.reply({ content: `🔊 Volume set to ${percent}%.`, ephemeral: true });
      }
      default:
        return void interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  }

  /** Resolve the slot this guild holds, or reply with a hint and return null. */
  private requireSlot(interaction: ChatInputCommandInteraction): PlayerSlot | null {
    const slot = this.pool.slotForUser(interaction.user.id);
    if (!slot) {
      void interaction.reply({
        content: "I'm not streaming here — run `/link` (or `/join`) first.",
        ephemeral: true,
      });
      return null;
    }
    return slot;
  }

  private async cmdTransport(
    interaction: ChatInputCommandInteraction,
    action: (slot: PlayerSlot) => Promise<void>,
    ok: string,
  ): Promise<void> {
    const slot = this.requireSlot(interaction);
    if (!slot) return;
    await action(slot);
    await interaction.reply({ content: ok, ephemeral: true });
  }

  /**
   * Get-or-create this user's player and join the member's voice channel,
   * returning the player. Replies with an error and returns null when the
   * member isn't in a voice channel.
   */
  private async joinAndAllocate(
    interaction: ChatInputCommandInteraction,
  ): Promise<PlayerSlot | null> {
    const member = interaction.member as GuildMember | null;
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel || !interaction.guild) {
      await this.respond(interaction, { content: "Join a voice channel first.", ephemeral: true });
      return null;
    }

    // Every user gets their own permanent player, created on first use and
    // reused (restarted if it was released) on every later /join or /link.
    // /join then brings the bot to wherever *this* caller is currently sitting.
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;
    let slot: PlayerSlot;
    try {
      slot = await this.pool.getOrCreate(userId);
    } catch (err) {
      await this.respond(interaction, {
        content: `Couldn't start your player: ${(err as Error).message}`,
        ephemeral: true,
      });
      return null;
    }

    // @discordjs/voice keeps exactly one connection per guild: a repeat join
    // returns the SAME connection object and issues the channel-move itself. So
    // we only wire listeners / tear down a stale connection when joinVoiceChannel
    // actually hands us a new object.
    const previousSession = this.sessions.get(guildId);
    const previous = previousSession?.connection;

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
    });
    const reused = connection === previous;
    console.log(`[discord] ${interaction.user.tag} → ${voiceChannel.name} on slot #${slot.index}`);
    if (!reused) {
      connection.on(VoiceConnectionStatus.Ready, () =>
        console.log(`[discord] voice ready (slot #${slot.index}) — audio should flow now`),
      );
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        // Only clean up if this exact connection is still the active one (a
        // fresh join may have replaced it). Stop the streaming user's player —
        // their permanent slot and credentials are untouched.
        const active = this.sessions.get(guildId);
        if (active?.connection === connection) {
          this.stopKaraoke(active.slot.index);
          this.clearChannelStatus(active.slot.index, connection.joinConfig.channelId);
          this.sessions.delete(guildId);
          void this.pool.release(active.userId);
        }
      });
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        // Region change / kick / network blip: brief grace to reconnect, else
        // destroy so a dead connection doesn't linger (Destroyed then cleans up).
        void Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]).catch(() => {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        });
      });
    }

    // Taking over this guild's single connection with a different user's slot
    // leaves the previous slot owned but no longer audible — drop its active
    // guild so now-playing routing and the panel stop pointing it here.
    if (previousSession && previousSession.slot !== slot) {
      previousSession.slot.activeGuildId = null;
    }

    slot.activeGuildId = guildId;
    this.sessions.set(guildId, {
      connection,
      slot,
      userId,
      guildName: interaction.guild.name,
      channelName: voiceChannel.name,
      announce:
        interaction.channel?.type === ChannelType.GuildText ? interaction.channel : null,
    });
    // A new object means any old one is already destroyed or orphaned; tear it
    // down defensively. The reused-object case needs no teardown at all.
    if (!reused && previous && previous.state.status !== VoiceConnectionStatus.Destroyed) {
      previous.destroy();
    }

    slot.subscribe(connection);
    return slot;
  }

  private async cmdJoin(interaction: ChatInputCommandInteraction): Promise<void> {
    const slot = await this.joinAndAllocate(interaction);
    if (!slot) return;

    if (!slot.isAuthenticated()) {
      await interaction.reply({
        content:
          `Joined on player **${slot.deviceName}**, but it isn't linked to a Spotify ` +
          `account yet. Run \`/link\` to connect your Spotify.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.reply(
      `Joined on player **${slot.deviceName}**.\n` +
        `Open Spotify → Devices → select **${slot.deviceName}**, then hit play.`,
    );
  }

  private async cmdLink(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!config.linkPortal.enabled || !config.linkPortal.baseUrl || !config.discord.clientSecret) {
      await interaction.reply({
        ephemeral: true,
        content:
          "Linking isn't available right now — ask the bot's admin to set LINK_PORTAL_BASE_URL " +
          "and DISCORD_CLIENT_SECRET.",
      });
      return;
    }

    // If this user already owns a LINKED player, /link would wipe that account's
    // credentials and kill its live stream (relink restarts the daemon). Make
    // them /leave first to switch accounts. A held-but-unlinked slot (plain
    // /join, or a previously failed link) is fine to (re)link.
    const held = this.pool.slotForUser(interaction.user.id);
    if (held?.isAuthenticated()) {
      await interaction.reply({
        ephemeral: true,
        content:
          `You're already linked to **${held.deviceName}**. ` +
          `Run \`/leave\` first if you want to connect a different Spotify account.`,
      });
      return;
    }

    const slot = await this.joinAndAllocate(interaction);
    if (!slot) return;

    // Starting the authorization means relaunching the daemon — defer so we
    // don't hit Discord's 3s interaction deadline.
    await interaction.deferReply({ ephemeral: true });
    try {
      await slot.beginRelink();
    } catch (err) {
      await interaction.editReply(
        `Couldn't start the Spotify login: ${(err as Error).message}. Try \`/link\` again.`,
      );
      return;
    }

    await interaction.editReply(
      `**Link your Spotify to ${slot.deviceName}**\n\n` +
        `Open ${config.linkPortal.baseUrl} and log in with Discord (if you haven't already) to finish — ` +
        `then pick **${slot.deviceName}** in Spotify → Devices and press play.`,
    );
  }

  /** Reply or follow-up depending on whether the interaction was already deferred/replied. */
  private async respond(
    interaction: ChatInputCommandInteraction,
    payload: { content: string; ephemeral: boolean },
  ): Promise<void> {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }

  private async cmdLeave(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const slot = this.pool.slotForUser(userId);
    if (!slot) {
      await interaction.reply({ content: "You're not linked to a player.", ephemeral: true });
      return;
    }
    // Tear down the guild connection this user's slot is streaming into (if
    // any), then release their slot back to the pool.
    const guildId = slot.activeGuildId ?? interaction.guild?.id ?? null;
    const session = guildId ? this.sessions.get(guildId) : undefined;
    if (session && session.slot === slot && guildId) {
      session.connection.destroy();
      this.sessions.delete(guildId);
    }
    this.stopKaraoke(slot.index);
    this.clearChannelStatus(slot.index, session?.connection.joinConfig.channelId ?? null);
    await this.pool.release(userId);
    await interaction.reply({ content: "👋 Left voice.", ephemeral: true });
  }

  private async cmdNowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    const slot = this.slotForInteraction(interaction);
    const track = slot?.getTrack();
    if (!track) {
      await interaction.reply({ content: "Nothing playing yet.", ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [this.nowPlayingEmbed(track)] });
  }

  /**
   * Show the lyrics of the user's current track inside Discord. When synced
   * (timestamped) lyrics are available we post a live "karaoke" board that edits
   * itself in time with playback, highlighting the current line; otherwise we
   * fall back to the plain text. The source is always credited in the footer.
   */
  /**
   * Resolve the player whose lyrics this caller wants: the slot they personally
   * linked, or — failing that — whatever slot is streaming in this guild. The
   * latter matters for the karaoke board, which should follow the music playing
   * in the channel even when the caller isn't the one who linked the account.
   */
  private slotForInteraction(interaction: ChatInputCommandInteraction): PlayerSlot | undefined {
    const owned = this.pool.slotForUser(interaction.user.id);
    if (owned) return owned;
    const guildId = interaction.guildId;
    return guildId ? this.sessions.get(guildId)?.slot : undefined;
  }

  private async cmdLyrics(interaction: ChatInputCommandInteraction): Promise<void> {
    const slot = this.slotForInteraction(interaction);
    const track = slot?.getTrack();
    if (!slot || !track) {
      await interaction.reply({ content: "Nothing playing yet — start a song first.", ephemeral: true });
      return;
    }

    // The lookup hits external APIs; defer so we don't blow Discord's 3s deadline.
    await interaction.deferReply();
    const artists = track.artist_names?.join(", ") || "";
    const title = track.name || "";
    const durationSec = track.duration ? Math.round(track.duration / 1000) : undefined;
    console.log(
      `[lyrics] lookup title=${JSON.stringify(title)} artist=${JSON.stringify(artists)} ` +
        `album=${JSON.stringify(track.album_name ?? "")} dur=${durationSec ?? "?"}s`,
    );
    const result = await fetchLyrics({ artist: artists, title, album: track.album_name || undefined, durationSec });

    if (!result || (!result.lines?.length && !result.plain)) {
      console.warn(`[lyrics] no match for title=${JSON.stringify(title)} artist=${JSON.stringify(artists)}`);
      await interaction.editReply(
        `Couldn't find lyrics for **${title || "?"}** — **${artists || "unknown artist"}**.\n` +
          `_(searched LRCLIB + lyrics.ovh for exactly that title/artist)_`,
      );
      return;
    }

    // No synced lyrics anywhere: show the plain text statically, source in footer.
    if (!result.lines?.length) {
      await interaction.editReply({
        embeds: [this.plainLyricsEmbed(title, artists, track.album_cover_url || null, result)],
      });
      return;
    }

    // Synced lyrics → a live karaoke board that follows the playback clock.
    // The optional `offset` nudges sync per board; default comes from config.
    const offsetMs = interaction.options.getInteger("offset") ?? config.karaoke.syncOffsetMs;
    this.stopKaraoke(slot.index);
    const lines = result.lines;
    const idx = currentLineIndex(lines, slot.estimatedPositionMs() - offsetMs);
    const head = { title, artists, cover: track.album_cover_url || null, source: result.source, offsetMs };
    const message = await interaction.editReply({ embeds: [this.karaokeEmbed(head, lines, idx, false)] });
    this.karaoke.set(slot.index, {
      slotIndex: slot.index,
      trackUri: track.uri,
      title,
      artists,
      cover: track.album_cover_url || null,
      source: result.source,
      lines,
      message,
      timer: setInterval(() => this.tickKaraoke(slot), 500),
      lastIndex: idx,
      offsetMs,
      ticks: 0,
      lastEditAt: Date.now(),
    });
  }

  /** Advance the karaoke board for `slot` to the line at the current position. */
  private tickKaraoke(slot: PlayerSlot): void {
    const session = this.karaoke.get(slot.index);
    if (!session) return;
    // Periodically resync the clock from go-librespot to undo any drift (~4s).
    if (++session.ticks % 8 === 0) void slot.syncPositionFromStatus();
    const idx = currentLineIndex(session.lines, slot.estimatedPositionMs() - session.offsetMs);
    if (idx === session.lastIndex) return; // no visible change — skip the edit
    // Cap edits to avoid Discord rate limits; keep lastIndex stale so the next
    // eligible tick still catches up to the current line.
    const now = Date.now();
    if (now - session.lastEditAt < 1000) return;
    session.lastIndex = idx;
    session.lastEditAt = now;
    void session.message
      .edit({ embeds: [this.karaokeEmbed(session, session.lines, idx, false)] })
      .catch(() => this.stopKaraoke(slot.index));
  }

  /**
   * When the slot under an active board moves to a new track, refetch lyrics and
   * rebuild the same message so the board keeps following along. If the new track
   * has no synced lyrics, retire the board with a note.
   */
  private async refreshKaraoke(slot: PlayerSlot, track: TrackMetadata): Promise<void> {
    const session = this.karaoke.get(slot.index);
    if (!session || session.trackUri === track.uri) return;

    const artists = track.artist_names?.join(", ") || "";
    const title = track.name || "";
    const result = await fetchLyrics({
      artist: artists,
      title,
      album: track.album_name || undefined,
      durationSec: track.duration ? Math.round(track.duration / 1000) : undefined,
    });

    // The board may have been stopped or replaced while we were fetching.
    if (this.karaoke.get(slot.index) !== session) return;

    if (!result?.lines?.length) {
      this.stopKaraoke(slot.index);
      await session.message
        .edit({
          embeds: [
            this.endedEmbed(
              title,
              artists,
              track.album_cover_url || null,
              result?.plain ? "only unsynced lyrics found" : "no synced lyrics found",
            ),
          ],
        })
        .catch(() => {});
      return;
    }

    session.trackUri = track.uri;
    session.title = title;
    session.artists = artists;
    session.cover = track.album_cover_url || null;
    session.source = result.source;
    session.lines = result.lines;
    session.lastIndex = -2; // force the next tick to render the new track
  }

  /** Stop and forget the karaoke board for a slot, if any. */
  private stopKaraoke(slotIndex: number): void {
    const session = this.karaoke.get(slotIndex);
    if (!session) return;
    clearInterval(session.timer);
    this.karaoke.delete(slotIndex);
  }

  // ── Voice channel status (song name / live lyrics) ──────────────────────

  /**
   * Apply `slot`'s owner's channel-status preference for the guild it's
   * currently streaming into. Called on every track change and whenever the
   * preference itself is toggled from the link portal.
   */
  private async updateChannelStatus(slot: PlayerSlot, track: TrackMetadata | null): Promise<void> {
    const guildId = slot.activeGuildId;
    const channelId = guildId ? this.sessions.get(guildId)?.connection.joinConfig.channelId : null;
    if (!channelId) return;

    const mode: ChannelStatusMode = slot.assignedUserId
      ? this.pool.getChannelStatusMode(slot.assignedUserId)
      : "off";

    if (mode === "off") {
      this.statusLyrics.delete(slot.index);
      if (this.statusOwned.has(slot.index)) await this.pushChannelStatus(slot.index, channelId, null);
      return;
    }
    if (!track) return; // nothing playing yet — leave whatever's there (or nothing)

    if (mode === "song") {
      this.statusLyrics.delete(slot.index);
      await this.pushChannelStatus(slot.index, channelId, this.songStatusText(track));
      return;
    }

    await this.startStatusLyrics(slot, channelId, track);
  }

  /** Begin (or restart, on a track change) live-lyric tracking for "lyrics" mode. */
  private async startStatusLyrics(slot: PlayerSlot, channelId: string, track: TrackMetadata): Promise<void> {
    const artists = track.artist_names?.join(", ") || "";
    const title = track.name || "";
    const result = await fetchLyrics({
      artist: artists,
      title,
      album: track.album_name || undefined,
      durationSec: track.duration ? Math.round(track.duration / 1000) : undefined,
    });

    // The track (or the preference) may have moved on while we were fetching.
    if (slot.getTrack()?.uri !== track.uri) return;
    if ((slot.assignedUserId ? this.pool.getChannelStatusMode(slot.assignedUserId) : "off") !== "lyrics") return;

    if (!result?.lines?.length) {
      // No synced lyrics for this track — fall back to the song name.
      this.statusLyrics.delete(slot.index);
      await this.pushChannelStatus(slot.index, channelId, this.songStatusText(track));
      return;
    }

    this.statusLyrics.set(slot.index, {
      trackUri: track.uri,
      channelId,
      lines: result.lines,
      lastPushedIndex: -2,
      lastPushedAt: 0,
    });
  }

  /** Push the current line for every tracked "lyrics"-mode slot, throttled per slot. */
  private tickAllStatusLyrics(): void {
    const now = Date.now();
    for (const [slotIndex, tracker] of this.statusLyrics) {
      const slot = this.pool.get(slotIndex);
      if (!slot || slot.getTrack()?.uri !== tracker.trackUri) {
        this.statusLyrics.delete(slotIndex);
        continue;
      }
      const idx = currentLineIndex(tracker.lines, slot.estimatedPositionMs() - config.karaoke.syncOffsetMs);
      if (idx === tracker.lastPushedIndex) continue;
      if (now - tracker.lastPushedAt < STATUS_LYRICS_MIN_PUSH_INTERVAL_MS) continue;
      tracker.lastPushedIndex = idx;
      tracker.lastPushedAt = now;
      const line = idx >= 0 ? tracker.lines[idx]?.text : undefined;
      void this.pushChannelStatus(slotIndex, tracker.channelId, line ? `🎤 ${line}` : null);
    }
  }

  /** `🎵 Artist — Title`, truncated to keep the channel list tidy. */
  private songStatusText(track: TrackMetadata): string {
    const artists = track.artist_names?.join(", ") || "Unknown artist";
    const title = track.name || "Unknown track";
    const text = `🎵 ${artists} — ${title}`;
    return text.length > STATUS_TEXT_MAX_LEN ? `${text.slice(0, STATUS_TEXT_MAX_LEN - 1)}…` : text;
  }

  /** Clear a slot's channel status on teardown (/leave, disconnect), if we'd set one. */
  private clearChannelStatus(slotIndex: number, channelId: string | null): void {
    this.statusLyrics.delete(slotIndex);
    if (channelId && this.statusOwned.has(slotIndex)) void this.pushChannelStatus(slotIndex, channelId, null);
  }

  private async pushChannelStatus(slotIndex: number, channelId: string, status: string | null): Promise<void> {
    if (status) this.statusOwned.add(slotIndex);
    else this.statusOwned.delete(slotIndex);
    try {
      await this.client.rest.put(Routes.channelVoiceStatus(channelId), { body: { status } });
    } catch (err) {
      console.warn(`[discord] couldn't set channel status: ${(err as Error).message}`);
    }
  }

  private karaokeEmbed(
    head: { title: string; artists: string; cover: string | null; source: string; offsetMs?: number },
    lines: LrcLine[],
    idx: number,
    ended: boolean,
  ): EmbedBuilder {
    const sync =
      !ended && typeof head.offsetMs === "number" ? ` · sync ${head.offsetMs >= 0 ? "+" : ""}${head.offsetMs}ms` : "";
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setAuthor({ name: ended ? "Lyrics" : "🎤 Karaoke" })
      .setTitle(`${head.title}${head.artists ? ` — ${head.artists}` : ""}`)
      .setDescription(renderKaraoke(lines, idx))
      .setFooter({ text: `Źródło: ${head.source}${sync}` });
    if (head.cover) embed.setThumbnail(head.cover);
    return embed;
  }

  private plainLyricsEmbed(
    title: string,
    artists: string,
    cover: string | null,
    result: LyricsResult,
  ): EmbedBuilder {
    const MAX = 4000; // Discord embed description hard limit is 4096.
    let body = result.plain ?? "";
    if (body.length > MAX) body = body.slice(0, MAX - 1).trimEnd() + "…";
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setAuthor({ name: "Lyrics" })
      .setTitle(`${title}${artists ? ` — ${artists}` : ""}`)
      .setDescription(body || "—")
      .setFooter({ text: `Źródło: ${result.source} · brak zsynchronizowanego tekstu (bez karaoke)` });
    if (cover) embed.setThumbnail(cover);
    return embed;
  }

  private endedEmbed(title: string, artists: string, cover: string | null, reason: string): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setAuthor({ name: "Karaoke" })
      .setTitle(`${title}${artists ? ` — ${artists}` : ""}`)
      .setDescription(`Karaoke ended — ${reason}. Run \`/lyrics\` again.`);
    if (cover) embed.setThumbnail(cover);
    return embed;
  }

  private async cmdDevice(interaction: ChatInputCommandInteraction): Promise<void> {
    const reachability =
      config.librespot.authMode === "interactive"
        ? `_Each player is linked to its own account via OAuth — selectable from any network._`
        : `_Requires the bot host and your Spotify app on the same network (Zeroconf)._`;
    await interaction.reply({
      ephemeral: true,
      content:
        `**Connecting your Spotify to Andrzej**\n` +
        `1. Join a voice channel and run \`/link\` — it gives you a one-time page to finish ` +
        `connecting **your** Spotify account.\n` +
        `2. In the Spotify app, tap the **Devices** icon (bottom-left on desktop).\n` +
        `3. Pick your player's device from the list.\n` +
        `4. Press play — audio comes out in the voice channel.\n` +
        `_(If a player is already linked, \`/join\` skips straight to step 2.)_\n` +
        `Everyone gets their own independent player, so several people can listen ` +
        `to different music at once.\n\n` +
        reachability,
    });
  }
}
