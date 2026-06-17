import { config } from "./config.js";
import { LibrespotManager, hasStoredCredentials } from "./librespot.js";
import { AudioBridge } from "./audio.js";
import { DiscordBot } from "./discord/bot.js";
import { ControlPanel } from "./panel.js";

async function main(): Promise<void> {
  console.log(`Starting ${config.librespot.deviceName}…`);

  if (config.librespot.authMode === "interactive" && !hasStoredCredentials()) {
    console.log(
      "No stored Spotify credentials yet — an authorization link will be printed below. " +
        "You can also run `npm run login` separately to do this one-time step.",
    );
  }

  const librespot = new LibrespotManager();
  const audio = new AudioBridge();
  const bot = new DiscordBot(librespot, audio);
  const panel = new ControlPanel(librespot, bot);

  // Start the Spotify Connect daemon and let it create the FIFO first, then
  // bring up the audio bridge that reads from it, then connect to Discord, and
  // finally expose the web control/auth panel.
  await librespot.start();
  audio.start();
  await bot.login();
  // start() logs the real bound URL from inside the listen callback, or an
  // actionable error if the port is taken — no premature success message here.
  panel.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down…`);
    panel.stop();
    audio.stop();
    await librespot.stop();
    await bot.destroy();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
