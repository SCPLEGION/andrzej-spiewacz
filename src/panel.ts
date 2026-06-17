import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import type { AuthMode } from "./config.js";
import { hasStoredCredentials, type LibrespotManager, type TrackMetadata } from "./librespot.js";
import type { DiscordBot, GuildView } from "./discord/bot.js";

/** JSON shape served at `/api/status` and consumed by the panel page. */
export interface PanelStatus {
  device: string;
  authMode: AuthMode;
  authenticated: boolean;
  /** OAuth authorization link to surface while not yet authenticated. */
  authUrl: string | null;
  track: { name: string; artists: string; album: string; cover: string | null } | null;
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

/** Assemble the panel status payload from raw runtime state (pure). */
export function buildStatus(input: PanelStatusInput): PanelStatus {
  return {
    device: input.device,
    authMode: input.authMode,
    authenticated: input.authenticated,
    // Once authenticated there's no point dangling a stale auth link.
    authUrl: input.authenticated ? null : input.authUrl,
    track: input.track
      ? {
          name: input.track.name || "Unknown track",
          artists: input.track.artist_names?.join(", ") || "Unknown artist",
          album: input.track.album_name || "",
          cover: input.track.album_cover_url || null,
        }
      : null,
    guilds: input.guilds,
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
 * green accent; polls `/api/status` and reflects auth + streaming state live.
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
  /* faint scanlines */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 9;
    background: repeating-linear-gradient(transparent 0 2px, rgba(0,0,0,.18) 2px 3px);
    mix-blend-mode: multiply;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
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
  .card h2 { font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: var(--dim);
    margin: 0 0 14px; }
  .btn { display: inline-block; text-decoration: none; color: #04130a; background: var(--green);
    font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-size: 13px;
    padding: 12px 22px; border-radius: 3px; box-shadow: var(--glow); transition: transform .1s ease; }
  .btn:hover { transform: translateY(-1px); }
  .muted { color: var(--dim); }
  .linked { color: var(--green); font-weight: 600; }
  .now { display: flex; gap: 16px; align-items: center; }
  .cover { width: 72px; height: 72px; border-radius: 3px; border: 1px solid var(--line);
    object-fit: cover; background: #05080a; flex: none; }
  .now .title { font-size: 15px; font-weight: 600; color: #e9f3ec; }
  .now .meta { color: var(--dim); margin-top: 2px; }
  ul.guilds { list-style: none; margin: 0; padding: 0; }
  ul.guilds li { display: flex; justify-content: space-between; gap: 12px;
    padding: 8px 0; border-bottom: 1px dashed var(--line); }
  ul.guilds li:last-child { border-bottom: 0; }
  ul.guilds .ch { color: var(--dim); }
  .count { color: var(--green); }
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

    <section class="card" id="auth-card">
      <h2>Authorization</h2>
      <div id="auth-body" class="muted">Loading…</div>
    </section>

    <section class="card">
      <h2>Now playing</h2>
      <div id="now" class="muted">— idle —</div>
    </section>

    <section class="card">
      <h2>Streaming to <span id="gcount" class="count">0</span> guild(s)</h2>
      <ul class="guilds" id="guilds"><li class="muted">No guilds connected. Run <code>/join</code> in a voice channel.</li></ul>
    </section>

    <footer>go-librespot · legit Spotify Connect · refreshing every 2s</footer>
  </div>

<script>
  const $ = (id) => document.getElementById(id);
  function text(el, s) { el.textContent = s; }

  function renderAuth(st) {
    const body = $("auth-body");
    body.innerHTML = "";
    if (st.authenticated) {
      const p = document.createElement("div");
      p.className = "linked";
      p.textContent = "✓ Spotify account linked — device reachable from any network.";
      body.appendChild(p);
      return;
    }
    if (st.authUrl) {
      const a = document.createElement("a");
      a.className = "btn"; a.href = st.authUrl; a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Authorize Spotify";
      body.appendChild(a);
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "Opens Spotify login. The redirect lands on the bot host's loopback callback — if you're remote, SSH-tunnel that port (see README).";
      body.appendChild(note);
    } else {
      const p = document.createElement("div");
      p.className = "muted";
      p.textContent = st.authMode === "interactive"
        ? "Waiting for the authorization link… start the bot or run: npm run login"
        : "Zeroconf mode — select the device from your Spotify app on the same LAN.";
      body.appendChild(p);
    }
  }

  function renderNow(st) {
    const el = $("now");
    el.innerHTML = "";
    if (!st.track) { el.className = "muted"; el.textContent = "— idle —"; return; }
    el.className = "now";
    if (st.track.cover) {
      const img = document.createElement("img");
      img.className = "cover"; img.src = st.track.cover; img.alt = "cover";
      el.appendChild(img);
    }
    const info = document.createElement("div");
    const t = document.createElement("div"); t.className = "title"; t.textContent = st.track.name;
    const m = document.createElement("div"); m.className = "meta";
    m.textContent = st.track.artists + (st.track.album ? " — " + st.track.album : "");
    info.appendChild(t); info.appendChild(m); el.appendChild(info);
  }

  function renderGuilds(st) {
    $("gcount").textContent = String(st.guilds.length);
    const ul = $("guilds");
    ul.innerHTML = "";
    if (!st.guilds.length) {
      const li = document.createElement("li"); li.className = "muted";
      li.textContent = "No guilds connected. Run /join in a voice channel.";
      ul.appendChild(li); return;
    }
    for (const g of st.guilds) {
      const li = document.createElement("li");
      const n = document.createElement("span"); n.textContent = g.name;
      const c = document.createElement("span"); c.className = "ch"; c.textContent = "🔊 " + g.channel;
      li.appendChild(n); li.appendChild(c); ul.appendChild(li);
    }
  }

  function renderPill(st) {
    const pill = $("pill");
    if (st.authenticated) { pill.className = "pill ok"; pill.textContent = "● authorized"; }
    else { pill.className = "pill wait"; pill.textContent = "● awaiting auth"; }
  }

  async function tick() {
    try {
      const st = await (await fetch("/api/status", { cache: "no-store" })).json();
      renderPill(st); renderAuth(st); renderNow(st); renderGuilds(st);
    } catch (e) {
      $("pill").className = "pill wait";
      $("pill").textContent = "● offline";
    }
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
  private latestAuthUrl: string | null = null;

  constructor(
    private readonly librespot: LibrespotManager,
    private readonly bot: DiscordBot,
  ) {
    this.librespot.on("authUrl", (url) => {
      this.latestAuthUrl = url;
    });
    this.librespot.on("authComplete", () => {
      this.latestAuthUrl = null;
    });
  }

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
      // The listen callback never fired, so don't leave a half-bound server
      // around for stop() to close or for callers to assume is up.
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

  private currentStatus(): PanelStatus {
    return buildStatus({
      device: config.librespot.deviceName,
      authMode: config.librespot.authMode,
      authenticated: hasStoredCredentials(),
      authUrl: this.latestAuthUrl,
      track: this.bot.getCurrentTrack(),
      guilds: this.bot.getConnectedGuilds(),
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? "/";
    if (url === "/api/status") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(this.currentStatus()));
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
