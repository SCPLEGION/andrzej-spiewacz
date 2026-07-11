/**
 * Imported first by every test file. config.ts runs `import "dotenv/config"` and
 * validates env eagerly at import time, so the environment must be pinned before
 * any source module loads — otherwise a developer's real .env (custom ports,
 * zeroconf mode, …) would make the config default assertions fail spuriously.
 */

// Stop dotenv from loading the project .env into the unit-test process.
process.env.DOTENV_CONFIG_PATH = "/dev/null";

// Clear anything the shell/CI might have exported so defaults are deterministic.
for (const key of [
  "LIBRESPOT_AUTH",
  "LIBRESPOT_DEVICE_NAME",
  "LIBRESPOT_BIN",
  "LIBRESPOT_API_HOST",
  "LIBRESPOT_API_PORT",
  "LIBRESPOT_FIFO",
  "LIBRESPOT_BITRATE",
  "LIBRESPOT_CALLBACK_PORT",
  "PANEL_ENABLED",
  "PANEL_HOST",
  "PANEL_PORT",
  "LINK_PORTAL_ENABLED",
  "LINK_PORTAL_HOST",
  "LINK_PORTAL_PORT",
  "LINK_PORTAL_BASE_URL",
  "DISCORD_GUILD_ID",
  "DISCORD_CLIENT_SECRET",
]) {
  delete process.env[key];
}

// Minimal required creds so config.ts imports without throwing.
process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_CLIENT_ID = "test-client-id";
