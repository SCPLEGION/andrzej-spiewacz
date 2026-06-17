import { config } from "./config.js";
import { LibrespotManager, hasStoredCredentials } from "./librespot.js";

/**
 * One-time interactive Spotify login. Run with `npm run login`.
 *
 * Starts go-librespot in interactive OAuth mode, prints the authorization URL,
 * and waits for you to complete the browser login. Once credentials are stored
 * in state/state.json, the normal `npm run dev` / `npm start` will connect
 * directly to Spotify and the device is reachable from any network.
 *
 * Headless host? Forward the callback port over SSH before opening the link:
 *   ssh -L 38080:127.0.0.1:38080 user@your-server
 */
async function main(): Promise<void> {
  if (config.librespot.authMode !== "interactive") {
    console.error(
      `LIBRESPOT_AUTH is "${config.librespot.authMode}". ` +
        `Set LIBRESPOT_AUTH=interactive in .env to use remote OAuth login.`,
    );
    process.exit(1);
  }

  if (hasStoredCredentials()) {
    console.log("Already authenticated — credentials exist in state/state.json. Nothing to do.");
    return;
  }

  const librespot = new LibrespotManager();
  await librespot.start();

  console.log(
    `Waiting for you to authorize (callback on 127.0.0.1:${config.librespot.callbackPort})…`,
  );

  await new Promise<void>((resolvePromise) => {
    const done = (): void => {
      if (hasStoredCredentials()) {
        clearInterval(poll);
        resolvePromise();
      }
    };
    librespot.on("authComplete", done);
    // Belt-and-suspenders: also poll the state file in case the log line is missed.
    const poll = setInterval(done, 1000);
  });

  console.log("\n✅ Login complete. Credentials saved to state/state.json.");
  console.log("   You can now run `npm run dev` — the device works from any network.");
  await librespot.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error("Login failed:", err);
  process.exit(1);
});
