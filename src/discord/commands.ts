import { SlashCommandBuilder } from "discord.js";

/**
 * Slash commands. Playback *content* is chosen from the real Spotify app (the
 * bot is a Spotify Connect speaker); these commands cover joining/leaving voice
 * and lightweight transport control proxied to go-librespot.
 */
export const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Make Andrzej join your current voice channel and start streaming."),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("Disconnect Andrzej from voice."),
  new SlashCommandBuilder()
    .setName("np")
    .setDescription("Show what's currently playing."),
  new SlashCommandBuilder()
    .setName("device")
    .setDescription("How to select Andrzej as a speaker in your Spotify app."),
  new SlashCommandBuilder()
    .setName("playpause")
    .setDescription("Toggle play/pause."),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip to the next track."),
  new SlashCommandBuilder()
    .setName("prev")
    .setDescription("Go to the previous track."),
  new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Set Spotify volume (0–100).")
    .addIntegerOption((opt) =>
      opt
        .setName("percent")
        .setDescription("Volume from 0 to 100")
        .setMinValue(0)
        .setMaxValue(100)
        .setRequired(true),
    ),
].map((c) => c.toJSON());
