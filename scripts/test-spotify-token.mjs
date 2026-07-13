#!/usr/bin/env node
/**
 * Standalone diagnostic for the real LIBRESPOT_AUTH=spotify_token flow (see
 * src/spotifyAuth.ts / src/linkPortal.ts's /auth/spotify/* routes) — confirms
 * a token from OUR OWN Spotify Developer app can authenticate a real Spotify
 * Connect session through go-librespot, in isolation from the running bot.
 *
 * Doesn't touch the running bot or any real state — spawns go-librespot
 * against a throwaway config dir under state/spotify-token-test/, killed and
 * deleted when this script exits.
 *
 * Uses the exact same redirect_uri as the real app (<LINK_PORTAL_BASE_URL>/auth/spotify/callback),
 * so it works against the same Spotify app registration with no separate setup.
 *
 * Usage (reads SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET / LINK_PORTAL_BASE_URL
 * from .env automatically — no need to export them by hand):
 *   node scripts/test-spotify-token.mjs        -> prints an authorize URL to open in your browser
 *   node scripts/test-spotify-token.mjs <code> -> exchanges the code, tries to auth go-librespot with it
 */
import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI ||
  `${(process.env.LINK_PORTAL_BASE_URL || "https://spiewacz.scplegion.ovh").replace(/\/$/, "")}/auth/spotify/callback`;
const TEST_PORT = 19999;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first (env vars, not in a file).");
  process.exit(1);
}

const code = process.argv[2];

if (!code) {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", "streaming user-read-email user-read-private");
  console.log("1. Open this URL in a browser and approve:\n");
  console.log(url.toString());
  console.log(`\n2. You'll land on a 404 page at ${REDIRECT_URI}?code=...&state=... — that's fine,`);
  console.log("   nothing needs to be running there for this test. Copy the `code=` value from");
  console.log("   the address bar (everything up to the next `&`) and re-run:\n");
  console.log("   node scripts/test-spotify-token.mjs <code>\n");
  process.exit(0);
}

async function main() {
  console.log("Exchanging code for a token…");
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }),
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("Token exchange failed:", tokenJson);
    process.exit(1);
  }
  const accessToken = tokenJson.access_token;
  console.log(`Got an access token (expires in ${tokenJson.expires_in}s, scope: ${tokenJson.scope}).`);

  const meRes = await fetch("https://api.spotify.com/v1/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();
  if (!meRes.ok) {
    console.error("Couldn't fetch profile:", me);
    process.exit(1);
  }
  console.log(`Spotify user: ${me.id} (${me.display_name || "no display name"})`);

  const binPath = resolve("bin/go-librespot");
  if (!existsSync(binPath)) {
    console.error(`go-librespot not found at ${binPath}. Run: npm run install:librespot`);
    process.exit(1);
  }

  const dir = resolve("state", "spotify-token-test");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const fifoPath = resolve(dir, "test.fifo");
  execFileSync("mkfifo", [fifoPath]);

  const configYaml = [
    `device_name: "spotify-token-test"`,
    `device_type: speaker`,
    `audio_backend: pipe`,
    `audio_output_pipe: ${JSON.stringify(fifoPath)}`,
    `audio_output_pipe_format: s16le`,
    `server:`,
    `  enabled: true`,
    `  address: "127.0.0.1"`,
    `  port: ${TEST_PORT}`,
    `credentials:`,
    `  type: spotify_token`,
    `  spotify_token:`,
    `    username: ${JSON.stringify(me.id)}`,
    `    access_token: ${JSON.stringify(accessToken)}`,
    ``,
  ].join("\n");
  writeFileSync(resolve(dir, "config.yml"), configYaml, "utf8");

  console.log("\nStarting go-librespot with the token — watching logs for 15s…\n");
  const proc = spawn(binPath, ["--config_dir", dir], { stdio: "inherit" });

  await new Promise((r) => setTimeout(r, 15_000));

  try {
    const status = await fetch(`http://127.0.0.1:${TEST_PORT}/status`).then((r) => r.json());
    console.log("\n/status response:", JSON.stringify(status, null, 2));
    console.log("\n^ If that has real session data (not empty/error), the token worked.");
  } catch {
    console.log("\n(couldn't reach /status — check the log output above for an auth error)");
  }

  proc.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
