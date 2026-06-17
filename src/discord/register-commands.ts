import { REST, Routes } from "discord.js";
import { config } from "../config.js";
import { commands } from "./commands.js";

/**
 * Registers slash commands. Run with `npm run register`.
 * - With DISCORD_GUILD_ID set: instant, guild-scoped (use during development).
 * - Without it: global registration (can take up to ~1h to appear).
 */
async function main(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(config.discord.token);

  if (config.discord.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
      { body: commands },
    );
    console.log(`Registered ${commands.length} guild commands to ${config.discord.guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
    console.log(`Registered ${commands.length} global commands.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
