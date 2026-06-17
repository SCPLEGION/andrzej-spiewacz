import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextBasedChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  entersState,
  NoSubscriberBehavior,
  DiscordGatewayAdapterCreator,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
} from "@discordjs/voice";
import { config } from "../config.js";
import { AudioBridge } from "../audio.js";
import { LibrespotManager, type TrackMetadata } from "../librespot.js";

/** One guild currently receiving the shared Spotify stream. */
interface GuildSession {
  connection: VoiceConnection;
  guildName: string;
  channelName: string;
  /** Text channel to post now-playing embeds into, if any. */
  announce: TextBasedChannel | null;
}

/** Public view of a streaming guild, surfaced to the control panel. */
export interface GuildView {
  id: string;
  name: string;
  channel: string;
}

export class DiscordBot {
  private readonly client: Client;
  /**
   * A single shared player drives every guild. There is exactly one Spotify
   * Connect device (one Premium stream), so we broadcast its audio by
   * subscribing each guild's voice connection to the same AudioPlayer — the
   * native @discordjs/voice fan-out.
   */
  private readonly player: AudioPlayer;
  private readonly sessions = new Map<string, GuildSession>();
  private currentResource: AudioResource | null = null;
  private lastTrack: TrackMetadata | null = null;

  constructor(
    private readonly librespot: LibrespotManager,
    private readonly audio: AudioBridge,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        // Spotify pauses leave gaps in the PCM without restarting ffmpeg (the
        // keep-alive FIFO fd holds it open). The default threshold of 5 would
        // stop the still-open resource after ~100ms of silence and it could
        // never resume. A high threshold makes the player emit silence through
        // a pause and pick the audio back up when PCM flows again. A genuine
        // ffmpeg EOF still ends the stream and trips the Idle/restart path.
        maxMissedFrames: Number.MAX_SAFE_INTEGER,
      },
    });

    this.player.on("error", (err) => console.error(`[player] ${err.message}`));
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Idle now only happens on a real resource end (ffmpeg crash). If guilds
      // are listening, try the current resource; a fresh one arrives via the
      // RESOURCE event once ffmpeg restarts.
      if (this.sessions.size > 0) this.ensurePlaying();
    });

    // Whenever the bridge (re)creates a resource — e.g. after an ffmpeg restart
    // — switch the shared player onto it so every guild follows along.
    this.audio.on(AudioBridge.RESOURCE, (resource: AudioResource) => {
      this.currentResource = resource;
      if (this.sessions.size > 0) this.playShared();
    });

    this.wireLibrespotEvents();
    this.wireDiscordEvents();
  }

  async login(): Promise<void> {
    await this.client.login(config.discord.token);
  }

  async destroy(): Promise<void> {
    for (const session of this.sessions.values()) session.connection.destroy();
    this.sessions.clear();
    await this.client.destroy();
  }

  // ── State accessors (read by the control panel) ─────────────────────────

  /** Guilds currently subscribed to the stream. */
  getConnectedGuilds(): GuildView[] {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id,
      name: s.guildName,
      channel: s.channelName,
    }));
  }

  /** The most recent track metadata, or null if nothing has played yet. */
  getCurrentTrack(): TrackMetadata | null {
    return this.lastTrack;
  }

  // ── Shared playback ─────────────────────────────────────────────────────

  /**
   * Play the shared resource. Skips a missing or already-ended resource and
   * never throws — @discordjs/voice's play() throws on an ended resource, and
   * these calls run inside event listeners where an escape would crash us.
   */
  private playShared(): void {
    const resource = this.currentResource;
    if (!resource || resource.ended) return;
    try {
      this.player.play(resource);
    } catch (err) {
      console.error(`[player] could not start resource: ${(err as Error).message}`);
    }
  }

  /** Start the shared resource on the player if it isn't already running. */
  private ensurePlaying(): void {
    if (this.player.state.status === AudioPlayerStatus.Playing) return;
    this.playShared();
  }

  // ── go-librespot → Discord announcements ────────────────────────────────

  private wireLibrespotEvents(): void {
    this.librespot.on("metadata", (track) => {
      this.lastTrack = track;
      void this.announceNowPlaying(track);
    });
    this.librespot.on("active", () =>
      console.log("[librespot] Spotify Connect session active"),
    );
    this.librespot.on("inactive", () =>
      console.log("[librespot] Spotify Connect session released"),
    );
  }

  /** Post the now-playing embed to every guild that has an announce channel. */
  private async announceNowPlaying(track: TrackMetadata): Promise<void> {
    const embed = this.nowPlayingEmbed(track);
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        if (!session.announce?.isSendable()) return;
        await session.announce.send({ embeds: [embed] }).catch(() => {});
      }),
    );
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
      console.log(`[discord] logged in as ${c.user.tag}`);
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
      case "leave":
        return this.cmdLeave(interaction);
      case "np":
        return this.cmdNowPlaying(interaction);
      case "device":
        return this.cmdDevice(interaction);
      case "playpause":
        await this.librespot.playpause();
        return void interaction.reply({ content: "⏯️ Toggled.", ephemeral: true });
      case "skip":
        await this.librespot.next();
        return void interaction.reply({ content: "⏭️ Skipped.", ephemeral: true });
      case "prev":
        await this.librespot.prev();
        return void interaction.reply({ content: "⏮️ Previous.", ephemeral: true });
      case "volume": {
        const percent = interaction.options.getInteger("percent", true);
        await this.librespot.setVolume(percent);
        return void interaction.reply({ content: `🔊 Volume set to ${percent}%.`, ephemeral: true });
      }
      default:
        return void interaction.reply({ content: "Unknown command.", ephemeral: true });
    }
  }

  private async cmdJoin(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.member as GuildMember | null;
    const voiceChannel = member?.voice.channel;
    if (!voiceChannel || !interaction.guild) {
      await interaction.reply({ content: "Join a voice channel first.", ephemeral: true });
      return;
    }

    const guildId = interaction.guild.id;
    // Re-running /join in a guild moves the bot to the new channel cleanly.
    this.sessions.get(guildId)?.connection.destroy();

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: true,
    });
    connection.subscribe(this.player);
    connection.on(VoiceConnectionStatus.Destroyed, () => {
      // Drop the session only if this exact connection is still the active one
      // (a fresh /join may have already replaced it).
      if (this.sessions.get(guildId)?.connection === connection) {
        this.sessions.delete(guildId);
      }
    });
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Region change / kick / network blip: give it a brief chance to
      // reconnect on its own, otherwise destroy it so a dead connection doesn't
      // linger in the session map (the Destroyed handler then cleans up).
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      });
    });

    this.sessions.set(guildId, {
      connection,
      guildName: interaction.guild.name,
      channelName: voiceChannel.name,
      announce:
        interaction.channel?.type === ChannelType.GuildText ? interaction.channel : null,
    });

    // Make sure the shared stream is rolling now that a guild is listening.
    this.playShared();

    await interaction.reply(
      `Joined **${voiceChannel.name}**. Open Spotify → Devices → select ` +
        `**${config.librespot.deviceName}**, then hit play. ` +
        `Now streaming to **${this.sessions.size}** guild(s).`,
    );
  }

  private async cmdLeave(interaction: ChatInputCommandInteraction): Promise<void> {
    const guildId = interaction.guild?.id;
    const session = guildId ? this.sessions.get(guildId) : undefined;
    if (!guildId || !session) {
      await interaction.reply({ content: "I'm not in voice here.", ephemeral: true });
      return;
    }
    session.connection.destroy();
    this.sessions.delete(guildId);
    await interaction.reply({ content: "👋 Left voice.", ephemeral: true });
  }

  private async cmdNowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!this.lastTrack) {
      await interaction.reply({ content: "Nothing playing yet.", ephemeral: true });
      return;
    }
    await interaction.reply({ embeds: [this.nowPlayingEmbed(this.lastTrack)] });
  }

  private async cmdDevice(interaction: ChatInputCommandInteraction): Promise<void> {
    const reachability =
      config.librespot.authMode === "interactive"
        ? `_Linked via OAuth — selectable from any network, no same-LAN requirement._`
        : `_Requires the bot host and your Spotify app on the same network (Zeroconf)._`;
    await interaction.reply({
      ephemeral: true,
      content:
        `**Connecting Spotify to Andrzej**\n` +
        `1. Run \`/join\` while in a voice channel.\n` +
        `2. In the Spotify app, tap the **Devices** icon (bottom-left on desktop).\n` +
        `3. Pick **${config.librespot.deviceName}** from the list.\n` +
        `4. Press play — audio comes out in the voice channel.\n\n` +
        reachability,
    });
  }
}
