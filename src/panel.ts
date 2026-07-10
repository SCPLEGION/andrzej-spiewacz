import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import type { AuthMode } from "./config.js";
import type { TrackMetadata } from "./librespot.js";
import type { DiscordBot, GuildView } from "./discord/bot.js";
import type { PlayerPool } from "./pool.js";

/** Flattened track view for the panel. */
export interface TrackView {
  name: string;
  artists: string;
  album: string;
  cover: string | null;
}

/** JSON shape for a single player slot, consumed by the panel page. */
export interface PanelStatus {
  device: string;
  authMode: AuthMode;
  authenticated: boolean;
  /** OAuth authorization link to surface while not yet authenticated. */
  authUrl: string | null;
  track: TrackView | null;
  guilds: GuildView[];
}

export interface PanelStatusInput {
  device: string;
  authMode: AuthMode;
  authenticated: boolean;
  authUrl: string | null;
  track: TrackMetadata | null;
  guilds: GuildView[];
}

/** Per-slot view served in the pool status array. */
export interface PlayerView extends PanelStatus {
  index: number;
  volume: number;
  /** The single guild using this slot, or null when free. */
  guild: GuildView | null;
}

export interface PlayerStatusInput extends PanelStatusInput {
  index: number;
  volume: number;
}

/** Whole-pool payload served at `/api/status`. */
export interface PoolStatus {
  device: string;
  authMode: AuthMode;
  players: PlayerView[];
}

/** Map raw go-librespot track metadata into the flat display shape (pure). */
export function toTrackView(track: TrackMetadata | null): TrackView | null {
  return track
    ? {
        name: track.name || "Unknown track",
        artists: track.artist_names?.join(", ") || "Unknown artist",
        album: track.album_name || "",
        cover: track.album_cover_url || null,
      }
    : null;
}

/** Assemble one slot's panel status payload from raw runtime state (pure). */
export function buildStatus(input: PanelStatusInput): PanelStatus {
  return {
    device: input.device,
    authMode: input.authMode,
    authenticated: input.authenticated,
    // Once authenticated there's no point dangling a stale auth link.
    authUrl: input.authenticated ? null : input.authUrl,
    track: toTrackView(input.track),
    guilds: input.guilds,
  };
}

/** Assemble the whole-pool status from each slot's raw state (pure). */
export function buildPoolStatus(
  device: string,
  authMode: AuthMode,
  inputs: PlayerStatusInput[],
): PoolStatus {
  return {
    device,
    authMode,
    players: inputs.map((inp) => {
      const base = buildStatus(inp);
      return { ...base, index: inp.index, volume: inp.volume, guild: base.guilds[0] ?? null };
    }),
  };
}

/** Minimal HTML-attribute/text escape for the one dynamic value we inline. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The single-page control panel. Dark CRT/terminal aesthetic with the Spotify
 * green accent; polls `/api/status` and renders one card per player slot,
 * reflecting auth + streaming + volume state live.
 */
export function renderPanelHtml(deviceName: string): string {
  const name = escapeHtml(deviceName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name} // CONTROL</title>
<style>
  :root {
    --bg: #07090a; --panel: #0d1113; --line: #1a2125;
    --fg: #c9d6cf; --dim: #5d6b63; --green: #1db954; --amber: #e0a83c;
    --glow: 0 0 8px rgba(29,185,84,.55);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: radial-gradient(120% 80% at 50% -10%, #0c1416 0%, var(--bg) 60%);
    color: var(--fg); font: 14px/1.5 "JetBrains Mono", "Fira Code", ui-monospace, monospace;
    letter-spacing: .02em; padding: 32px 16px; min-height: 100%;
  }
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9;
    background: repeating-linear-gradient(transparent 0 2px, rgba(0,0,0,.18) 2px 3px);
    mix-blend-mode: multiply;
  }
  .wrap { max-width: 820px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; text-transform: uppercase; letter-spacing: .14em; }
  h1 .sub { display: block; color: var(--dim); font-size: 11px; letter-spacing: .2em; margin-top: 4px; }
  .pill { font-size: 11px; text-transform: uppercase; letter-spacing: .14em; padding: 6px 12px;
    border: 1px solid var(--line); border-radius: 2px; white-space: nowrap; }
  .pill.ok { color: var(--green); border-color: rgba(29,185,84,.4); box-shadow: var(--glow); }
  .pill.wait { color: var(--amber); border-color: rgba(224,168,60,.4); }
  .card { background: linear-gradient(180deg, var(--panel), #0a0d0f);
    border: 1px solid var(--line); border-radius: 4px; padding: 20px; margin-bottom: 18px; }
  .card .head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 14px; }
  .card h2 { font-size: 12px; letter-spacing: .16em; text-transform: uppercase; color: #cfe9d8;
    margin: 0; }
  .tag { font-size: 10px; letter-spacing: .14em; text-transform: uppercase; padding: 4px 10px;
    border-radius: 2px; border: 1px solid var(--line); white-space: nowrap; }
  .tag.free { color: var(--dim); }
  .tag.busy { color: var(--green); border-color: rgba(29,185,84,.4); }
  .tag.noauth { color: var(--amber); border-color: rgba(224,168,60,.4); }
  .btn { display: inline-block; text-decoration: none; color: #04130a; background: var(--green);
    font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-size: 12px;
    padding: 10px 18px; border: 0; border-radius: 3px; box-shadow: var(--glow); cursor: pointer;
    transition: transform .1s ease; }
  .btn:hover { transform: translateY(-1px); }
  .btn:disabled { opacity: .5; cursor: default; transform: none; }
  .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line);
    box-shadow: none; }
  .muted { color: var(--dim); }
  .now { display: flex; gap: 14px; align-items: center; margin: 10px 0; }
  .cover { width: 60px; height: 60px; border-radius: 3px; border: 1px solid var(--line);
    object-fit: cover; background: #05080a; flex: none; }
  .now .title { font-size: 14px; font-weight: 600; color: #e9f3ec; }
  .now .meta { color: var(--dim); margin-top: 2px; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
  .vol { color: var(--green); }
  code { color: var(--amber); }
  footer { color: var(--dim); font-size: 11px; text-align: center; margin-top: 24px; letter-spacing: .12em; }
  .blink { animation: blink 1.1s steps(2, start) infinite; }
  @keyframes blink { to { opacity: 0; } }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>${name}<span class="sub">SPOTIFY × DISCORD CONTROL</span></h1>
      <span id="pill" class="pill wait">● connecting<span class="blink">_</span></span>
    </header>

    <div id="players"><div class="muted">Loading…</div></div>

    <footer>go-librespot · legit Spotify Connect · refreshing every 2s</footer>
  </div>

<script>
  const $ = (id) => document.getElementById(id);

  function authButton(p) {
    if (p.authenticated) return '<span class="tag busy">✓ linked</span>';
    if (p.authUrl) {
      return '<a class="btn" href="' + encodeURI(p.authUrl) + '" target="_blank" rel="noopener">Authorize Spotify</a>';
    }
    return '<span class="muted">waiting for authorization link…</span>';
  }

  function nowPlaying(p) {
    if (!p.track) return '<div class="muted now">— idle —</div>';
    const cover = p.track.cover
      ? '<img class="cover" src="' + encodeURI(p.track.cover) + '" alt="cover">'
      : '';
    const meta = esc(p.track.artists) + (p.track.album ? ' — ' + esc(p.track.album) : '');
    return '<div class="now">' + cover +
      '<div><div class="title">' + esc(p.track.name) + '</div>' +
      '<div class="meta">' + meta + '</div></div></div>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderPlayers(st) {
    const root = $("players");
    root.innerHTML = "";
    for (const p of st.players) {
      const card = document.createElement("section");
      card.className = "card";
      const busy = p.guild
        ? '<span class="tag busy">🔊 ' + esc(p.guild.name) + ' · ' + esc(p.guild.channel) + '</span>'
        : '<span class="tag free">free</span>';
      const authTag = p.authenticated ? '' : '<span class="tag noauth">no account</span>';
      card.innerHTML =
        '<div class="head"><h2>' + esc(p.device) + '</h2><div>' + authTag + ' ' + busy + '</div></div>' +
        '<div>' + authButton(p) + '</div>' +
        nowPlaying(p) +
        '<div class="row"><span class="vol">VOL ' + p.volume + '%</span>' +
        '<button class="btn ghost" ' + (p.guild ? '' : 'disabled title="join a voice channel first"') +
        ' onclick="testAudio(' + p.index + ', this)">🔔 Test Audio</button>' +
        '<span class="muted" id="test-' + p.index + '"></span></div>';
      root.appendChild(card);
    }
  }

  function renderPill(st) {
    const pill = $("pill");
    const linked = st.players.filter((p) => p.authenticated).length;
    if (linked === st.players.length) { pill.className = "pill ok"; pill.textContent = "● " + linked + "/" + st.players.length + " linked"; }
    else { pill.className = "pill wait"; pill.textContent = "● " + linked + "/" + st.players.length + " linked"; }
  }

  async function tick() {
    try {
      const st = await (await fetch("/api/status", { cache: "no-store" })).json();
      renderPill(st); renderPlayers(st);
    } catch (e) {
      $("pill").className = "pill wait";
      $("pill").textContent = "● offline";
    }
  }

  async function testAudio(index, btn) {
    const result = $("test-" + index);
    btn.disabled = true;
    result.style.color = "var(--dim)";
    result.textContent = "sending…";
    try {
      const res = await fetch("/api/test-audio?slot=" + index, { method: "POST" });
      const data = await res.json();
      if (res.ok) { result.style.color = "var(--green)"; result.textContent = "✓ ding sent — did you hear it?"; }
      else { result.style.color = "var(--amber)"; result.textContent = "✗ " + (data.error || "error"); }
    } catch {
      result.style.color = "var(--amber)"; result.textContent = "✗ connection error";
    }
    setTimeout(() => { btn.disabled = false; result.textContent = ""; }, 4000);
  }

  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>
`;
}

/** Serves the control/auth panel and a JSON status endpoint over plain HTTP. */
export class ControlPanel {
  private server: Server | null = null;

  constructor(
    private readonly pool: PlayerPool,
    private readonly bot: DiscordBot,
  ) {}

  start(): void {
    if (!config.panel.enabled) {
      console.log("[panel] disabled (PANEL_ENABLED=false)");
      return;
    }
    const server = createServer((req, res) => this.handle(req, res));
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[panel] port ${config.panel.port} is already in use — set PANEL_PORT to a free port. ` +
            `Panel is NOT running for this session.`,
        );
      } else {
        console.error(`[panel] server error: ${err.message}`);
      }
      server.close();
      this.server = null;
    });
    server.listen(config.panel.port, config.panel.host, () => {
      console.log(`[panel] control panel on http://${config.panel.host}:${config.panel.port}`);
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private poolStatus(): PoolStatus {
    const inputs: PlayerStatusInput[] = this.pool.activePlayers().map((slot) => {
      const label = this.bot.guildLabel(slot.activeGuildId);
      const guilds: GuildView[] =
        label && slot.activeGuildId
          ? [{ id: slot.activeGuildId, name: label.name, channel: label.channel }]
          : [];
      return {
        index: slot.index,
        device: slot.deviceName,
        authMode: config.librespot.authMode,
        authenticated: slot.isAuthenticated(),
        authUrl: slot.getAuthUrl(),
        volume: slot.getVolumePercent(),
        track: slot.getTrack(),
        guilds,
      };
    });
    return buildPoolStatus(config.librespot.deviceName, config.librespot.authMode, inputs);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.poolStatus()));
      return;
    }
    if (url.startsWith("/api/test-audio") && req.method === "POST") {
      const slotIndex = Number(new URL(url, "http://localhost").searchParams.get("slot"));
      const slot = this.pool.get(slotIndex);
      if (!slot) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no such player slot" }));
        return;
      }
      if (slot.activeGuildId === null || !this.bot.playTestTone(slot.activeGuildId)) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "player not in a voice channel — /join first" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPanelHtml(config.librespot.deviceName));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}
