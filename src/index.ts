import { config } from "./config.js";
import { PlayerPool } from "./pool.js";
import { DiscordBot } from "./discord/bot.js";
import { ControlPanel } from "./panel.js";
import { LinkPortal } from "./linkPortal.js";

async function main(): Promise<void> {
  console.log(
    `Starting ${config.librespot.deviceName} — players spin up per-user on their first ` +
      `/link or /join, using whatever Spotify credentials are already stored for them.`,
  );

  const pool = new PlayerPool();
  const linkPortal = new LinkPortal(pool);
  const bot = new DiscordBot(pool, linkPortal);
  const panel = new ControlPanel(pool, bot);

  // Nothing to start yet (no players run until a user links/joins); connect to
  // Discord, then expose the web control panel and the public link portal.
  await pool.start();
  await bot.login();
  // start() logs the real bound URL from inside the listen callback, or an
  // actionable error if the port is taken — no premature success message here.
  panel.start();
  linkPortal.start();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down…`);
    panel.stop();
    linkPortal.stop();
    await pool.stop();
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
