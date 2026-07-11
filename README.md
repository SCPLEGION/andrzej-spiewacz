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
/link (user A) ──▶ go-librespot (account A) → FIFO → ffmpeg → AudioPlayer ──▶ guild voice
/link (user B) ──▶ go-librespot (account B) → FIFO → ffmpeg → AudioPlayer ──▶ guild voice
go-librespot /events (WebSocket) ──▶ "now playing" embeds + web panel
```

The Node process supervises a **player per Discord user**, bridges each one's
PCM pipe into Discord, and proxies transport controls to each daemon's HTTP API.

**One independent player per person.** Spotify allows only one simultaneous
stream per Premium account, so every Discord user who links their own account
gets their own go-librespot instance, showing up as its own Connect device
(`Andrzej Śpiewacz #1`, `#2`, …). The first time someone runs `/link` (or
`/join`), the bot permanently assigns them the next device number and stores it
in `state/registry.json` — that mapping, and their Spotify credentials, live
forever, but the go-librespot daemon itself only *runs* while they're actively
linked in: `/join` spins it up (loading their already-stored token straight from
disk), `/leave` shuts it back down. There's no player-count limit to configure —
capacity is just "however many people are currently listening," not a fixed pool.
Different people can stream **different music at the same time**, each with
their own volume and transport.

**Volume is applied on the Discord side.** go-librespot runs with
`external_volume`, so it emits full-scale PCM and only *reports* the target
volume; the bot applies the gain inline right before encoding. A `/volume`
change (or a move of the Spotify app slider) takes effect on the next ~20 ms
frame instead of waiting for the FIFO + ffmpeg buffer to drain.

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

6. **Run**:
   ```bash
   npm run dev     # watch mode (tsx)
   # or
   npm run build && npm start
   ```
   There's no separate login step — the bot starts with zero players running.
   Spotify auth happens per-person: each user runs `/link` in Discord and gets
   a one-time link to the [link portal](#link-portal) to finish it. See
   [Remote access](#remote-access-any-network) if the host is headless.

## Using it

1. In Discord, join a voice channel and run `/link` (first time) or `/join`
   (already linked). The bot brings up your personal player and tells you its
   device name (e.g. *Andrzej Śpiewacz #2*).
2. In the Spotify app, open the **Devices** menu and pick **that** device.
3. Press play. Audio plays in your voice channel; the bot posts a now-playing
   embed on each track change. Other people can `/link`/`/join` and play their
   own music on their own player at the same time.

### Commands

| Command | Action |
|---|---|
| `/link` | Connect your Spotify account and join your voice channel (sends you a link portal URL) |
| `/join` | Join your voice channel on your already-linked player |
| `/leave` | Disconnect and stop your player |
| `/np` | Show the current track on your player |
| `/playpause` `/skip` `/prev` | Transport control (your player) |
| `/volume <0–100>` | Set your player's volume (instant, Discord-side) |
| `/device` | Instructions for selecting the speaker in Spotify |

All transport/volume commands act on the player linked to *you*, the caller —
run `/link` (or `/join`) first.

## Remote access (any network)

By default `LIBRESPOT_AUTH=interactive`: once a user's daemon has stored
credentials, it connects **directly to Spotify's servers**, so their speaker
shows up in the Spotify app from any network — phone on mobile data, work
laptop, wherever. No mDNS, no same-LAN requirement.

**Headless host?** During `/link`, go-librespot's OAuth redirect points at
`http://127.0.0.1:<callback_port>/login` on the *bot's* machine — that's why the
[link portal](#link-portal) page says the browser tab "won't load" after you
approve: Spotify redirects the user's own browser there, and on a remote host
that loopback isn't the user's machine. The address bar still contains the
`code=...` needed, though — the portal has you paste the whole URL into a form
instead of a Discord command, and submits it to the bot's own local callback
for you. Nobody needs to SSH-tunnel anything for this; the callback port is
only ever hit by the bot process itself, never exposed externally (so it
doesn't need to be published in `docker-compose.yml` either, unlike the panel
and link-portal ports).

To go back to LAN-only mDNS discovery instead, set `LIBRESPOT_AUTH=zeroconf`.

## Link portal

`/link` doesn't paste raw OAuth links into Discord anymore, and there's no
per-user token to hand out either — the portal (`LINK_PORTAL_BASE_URL`, e.g.
`https://spiewacz.scplegion.ovh`) uses a real **Discord OAuth2 login**
(`identify` scope only) with a signed, `HttpOnly` session cookie. Visit the
domain, click **Zaloguj przez Discord**, and it shows whatever state your
player is in:

- **Never run `/link`** — a short "what is this bot" page telling you to run
  it on Discord first.
- **Mid-login** (ran `/link`, haven't finished Spotify auth) — the
  **Autoryzuj Spotify** button (the same authorize URL that used to be posted
  directly into Discord), plus a box to paste the broken `127.0.0.1...`
  redirect URL the browser lands on after approving — submitting it finishes
  the login (what `/code` used to do).
- **Linked** — a tiny status view: device name, whatever's currently playing,
  and the voice-channel-status toggle below. Nothing else — no other user's
  data is ever shown here, unlike the admin control panel below.

One-time setup for the Discord side: in the [Discord Developer
Portal](https://discord.com/developers/applications), open the bot's
application → OAuth2 → add `<LINK_PORTAL_BASE_URL>/auth/discord/callback`
under **Redirects** (must match exactly), and copy the **Client Secret** into
`DISCORD_CLIENT_SECRET`. Without it, the portal refuses to start (same as a
missing `LINK_PORTAL_BASE_URL`).

The session cookie is signed with a random secret generated fresh every time
the bot process starts — so a restart naturally logs everyone out rather than
needing an explicit expiry or a persisted signing key. `/auth/logout` clears
it early if you want to.

**Why there's no `/callback` receiving Spotify's redirect directly:**
go-librespot's OAuth redirect URI is hardcoded to `http://127.0.0.1:<port>/login`
in the binary itself (verified by inspecting it — there's no config option for
it) — Spotify will only ever redirect back to the bot's own loopback, never to
our domain, so the "paste the broken link" step is an unavoidable consequence
of using go-librespot's built-in interactive auth rather than a design choice.

**Voice channel status.** The status page also has a small radio-button toggle
— *Wyłączony* (off), *Nazwa piosenki* (song name), or *Teksty na żywo*
(live lyrics) — that sets what shows up under your voice channel's name in
Discord's channel list (the same "voice channel status" feature Discord added
in 2024, set via `PUT /channels/{id}/voice-status`). "Song name" posts
`🎵 Artist — Title` on every track change; "live lyrics" fetches synced lyrics
(same source as `/lyrics`) and updates the status to the current line roughly
every 8s (throttled — Discord rate-limits this endpoint, and a line-by-line
push would spam it), falling back to the song name when a track has no synced
lyrics. It's per-user: each person picks their own, takes effect immediately if
they're already streaming, and clears when they `/leave`. **The bot needs the
"Set Voice Channel Status" permission** (or Manage Channels) in the target
channel — without it, updates just fail silently (logged as a warning) and
playback is unaffected.

**This is meant to sit behind your own reverse proxy** (nginx/Caddy/Traefik) —
the app itself just listens on plain HTTP (`LINK_PORTAL_HOST=0.0.0.0`,
`LINK_PORTAL_PORT=8078` by default; `docker-compose.yml` publishes `8078`).
Point your proxy's TLS-terminated vhost at that port and set
`LINK_PORTAL_BASE_URL` to the public HTTPS origin. Set
`LINK_PORTAL_ENABLED=false` to turn the whole thing off (`/link` will then
refuse to run, since it has no other way to finish OAuth).

## Control panel

A small web dashboard ships with the bot (enabled by default,
`http://127.0.0.1:8077`). It's a dark/terminal-styled page that shows, live,
one card per **currently running** player:

- **Device name, auth status, and which guild is using it.**
- **Auth status** — and, while a player is unauthenticated, a one-click
  **Authorize Spotify** button pointing at its OAuth link. This is the nicest
  way to link an account: run `/link`, open the panel, click.
- **Now playing** — cover art, track, artist, album.
- **🔔 Test Audio** — plays a short ding through a player's voice channel so you
  can confirm the Discord voice pipeline works end-to-end (enabled once that
  player has `/join`ed a channel).

Players that have never linked, or that are currently `/leave`d, don't have a
card — there's no fixed roster to show idle slots for.

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
mapping, volume clamping, ffmpeg args, panel and link-portal status/HTML
rendering, the slash-command schema, per-index config derivation, the
user→index registry assignment, session cookie signing/verification, and the
per-user channel-status preference store.

## Notes & gotchas

- **First `/link`** persists credentials under `state/<n>/state.json` (`state/`
  itself for index 0) so that user's daemon reconnects automatically on every
  later `/join` — no re-authorizing.
- **`state/registry.json`** is the permanent Discord user → device-index
  mapping. It's never rewritten once a user has an index, and it's what makes
  `/join` recreate the *same* device for the *same* person after a restart.
  Back it up along with `state/` if you move hosts.
- The generated daemon config is written to each index's config dir on every
  start; edit `buildConfigYaml()` in `src/librespot.ts` to change daemon settings.
- One Premium account = one stream, so each linked user needs their own
  account. Per-index API ports, callback ports, FIFOs and credential dirs are
  auto-offset so nothing collides — there's no count to configure.
- `state/`, `bin/`, `.env`, and the FIFO are gitignored.

## Requirements

- Node ≥ 20 (tested on 25), `ffmpeg` and `mkfifo` on PATH.
- A Spotify **Premium** account (one per person who wants to stream their own music).

### Running with Docker

`Dockerfile`/`docker-compose.yml` build a fully self-contained image (Node,
ffmpeg, and the build toolchain for npm's native addons all get installed
inside it) — the **host doesn't need anything preinstalled**, which matters if
you're running this in a bare Proxmox LXC container. One thing that's outside
the image and only fixable on the Proxmox side: Docker itself needs the LXC's
**nesting** feature enabled (container → *Options* → *Features* → check
`nesting`, plus `keyctl` if Docker complains about it) — without it, Docker
inside the LXC won't start at all.

**Deploying updates.** `.github/workflows/docker-publish.yml` builds and pushes
the image to GHCR (`ghcr.io/scplegion/andrzej-spiewacz:latest`) on every push
to `main` — the server never needs to `git clone` or build anything. Once,
first time:

```bash
# On the server, next to your docker-compose.yml + .env:
docker login ghcr.io -u SCPLEGION   # only needed if the package stays private
docker compose pull
docker compose up -d
```

To deploy a new version later, just re-run `docker compose pull && docker
compose up -d`. (First push from Actions creates the package as **private** by
default — either make it public under the repo's *Packages* tab so `pull`
needs no login, or keep it private and use a
[PAT with `read:packages`](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
for the `docker login` above.)
