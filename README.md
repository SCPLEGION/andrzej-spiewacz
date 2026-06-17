# Andrzej Śpiewacz

Discord voice bot that streams Spotify into a voice channel. It runs
[go-librespot](https://github.com/devgianlu/go-librespot) as a **Spotify Connect
speaker** — the bot shows up as a device in your Spotify app, you press play
there, and the audio comes out in the Discord voice channel.

This is the legitimate path: it uses your own **Spotify Premium** account and the
real Spotify protocol. Premium is required — free accounts get cut off by
Spotify's servers. Nothing here is cracked.

## How it works

```
Spotify app ──(Spotify Connect)──▶ go-librespot daemon
                                        │ raw PCM (s16le 44.1 kHz) → named pipe (FIFO)
                                        ▼
                                   ffmpeg (resample → 48 kHz)
                                        ▼
                              one shared @discordjs/voice player
                              ├──▶ guild A voice channel
                              ├──▶ guild B voice channel   (broadcast to all
                              └──▶ guild C voice channel    joined guilds at once)
go-librespot /events (WebSocket) ──▶ bot posts "now playing" embeds + web panel
```

The Node process supervises go-librespot, bridges its PCM pipe into Discord, and
proxies a few transport controls to the daemon's HTTP API.

**Multiple guilds at once.** There is exactly one Spotify Connect device (one
Premium stream), so that single audio stream is broadcast to every guild that
ran `/join` — each guild's voice connection subscribes to one shared audio
player. Run `/join` in as many servers as you like; they all hear the same
music in sync. `/leave` detaches just that guild.

## Setup

1. **Install dependencies** (inside devbox):
   ```bash
   npm install
   ```

2. **Fetch the go-librespot binary** (prebuilt, no Go toolchain needed):
   ```bash
   npm run install:librespot     # → ./bin/go-librespot
   ```

3. **Create the Discord bot** at <https://discord.com/developers/applications>:
   - Bot tab → reset/copy the **token**.
   - General Information → copy the **Application ID**.
   - Invite it with the `bot` and `applications.commands` scopes and the
     **Connect** + **Speak** voice permissions.
   - No privileged intents are required.

4. **Configure** — copy and fill in:
   ```bash
   cp .env.example .env
   ```
   Set at minimum `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and (for instant slash
   commands during dev) `DISCORD_GUILD_ID`.

5. **Register slash commands**:
   ```bash
   npm run register
   ```

6. **Authenticate with Spotify** (one-time OAuth):
   ```bash
   npm run login
   ```
   This prints an authorization URL. Open it, log in with your Premium account,
   and approve. Credentials are saved to `state/state.json`; after this the
   device works from **any network** and you never need to log in again (unless
   you delete `state/`). See [Remote access](#remote-access-any-network) if the
   host is headless.

7. **Run**:
   ```bash
   npm run dev     # watch mode (tsx)
   # or
   npm run build && npm start
   ```
   `npm run dev` will also prompt for login on first run if you skipped step 6.

## Using it

1. In Discord, join a voice channel and run `/join` — repeat in any other
   servers/channels you want to stream to simultaneously.
2. In the Spotify app, open the **Devices** menu and pick the device named by
   `LIBRESPOT_DEVICE_NAME` (default *Andrzej Śpiewacz*).
3. Press play. Audio plays in every joined voice channel at once; the bot posts a
   now-playing embed in each on track change.

### Commands

| Command | Action |
|---|---|
| `/join` | Join your voice channel and start streaming |
| `/leave` | Disconnect from voice |
| `/np` | Show the current track |
| `/playpause` `/skip` `/prev` | Transport control |
| `/volume <0–100>` | Set Spotify volume |
| `/device` | Instructions for selecting the speaker in Spotify |

## Remote access (any network)

By default `LIBRESPOT_AUTH=interactive`: after the one-time `npm run login`, the
daemon connects **directly to Spotify's servers** using the stored credentials,
so the speaker shows up in your Spotify app from any network — phone on mobile
data, work laptop, wherever. No mDNS, no same-LAN requirement.

**Headless host?** The OAuth redirect goes to `http://127.0.0.1:<callback_port>/login`
on the *bot's* machine, so the browser completing the login must be able to reach
that loopback. Two ways:

- **SSH tunnel** (run the link locally, auth lands on the server):
  ```bash
  ssh -L 38080:127.0.0.1:38080 user@your-server
  # then on the server: npm run login
  # open the printed http://127.0.0.1:38080/... link in your LOCAL browser
  ```
- **Log in locally, copy the state** — run `npm run login` on your laptop, then
  copy the resulting `state/state.json` to the server's `state/` directory.

To go back to LAN-only mDNS discovery instead, set `LIBRESPOT_AUTH=zeroconf`.

## Control panel

A small web dashboard ships with the bot (enabled by default,
`http://127.0.0.1:8077`). It's a dark/terminal-styled page that shows, live:

- **Auth status** — and, while unauthenticated, a one-click **Authorize Spotify**
  button pointing at the OAuth link the daemon emits. This is the nicest way to
  do the first-time login: start the bot, open the panel, click the button.
- **Now playing** — cover art, track, artist, album.
- **Streaming to N guild(s)** — every server currently receiving the stream.

It polls `/api/status` (also available as raw JSON) every 2s. Configure with
`PANEL_HOST` / `PANEL_PORT`, or disable with `PANEL_ENABLED=false`. It binds to
loopback by default; for remote access SSH-tunnel it
(`ssh -L 8077:127.0.0.1:8077 user@server`) rather than exposing it publicly.

## Testing

```bash
npm test        # unit tests (Node's built-in runner via tsx)
npm run typecheck
```

Tests live in `test/` and cover the pure logic — config-yaml generation, event
mapping, volume clamping, ffmpeg args, panel status/HTML rendering, and the
slash-command schema.

## Notes & gotchas

- **First login** persists credentials under `state/state.json` so the daemon
  reconnects automatically on every later start — no re-selecting the device.
- The generated daemon config is written to `state/config.yml` on each start;
  edit `buildConfigYaml()` in `src/librespot.ts` to change daemon settings.
- One Spotify device = one stream, mirrored to all joined guilds in sync (you
  can't play different songs per guild — that would need multiple Premium
  accounts/devices).
- `state/`, `bin/`, `.env`, and the FIFO are gitignored.

## Requirements

- Node ≥ 20 (tested on 25), `ffmpeg` and `mkfifo` on PATH.
- A Spotify **Premium** account.
