import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { extractAuthCode } from "./librespot.js";
import { escapeHtml, toTrackView, type TrackView } from "./panel.js";
import type { PlayerPool } from "./pool.js";
import type { ChannelStatusMode } from "./channelStatusPrefs.js";
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordUser,
  parseCookies,
  SessionSigner,
} from "./discordAuth.js";
import { spotifyAuthorizeUrl, exchangeSpotifyCode, fetchSpotifyProfile } from "./spotifyAuth.js";

const SESSION_COOKIE = "andrzej_session";

function pageShell(title: string, deviceName: string, body: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #07090a; --panel: #0d1113; --line: #1a2125;
    --fg: #c9d6cf; --dim: #5d6b63; --green: #1db954; --amber: #e0a83c;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: radial-gradient(120% 80% at 50% -10%, #0c1416 0%, var(--bg) 60%);
    color: var(--fg); font: 15px/1.6 "JetBrains Mono", "Fira Code", ui-monospace, monospace;
    padding: 40px 16px; min-height: 100%;
  }
  .wrap { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 14px; text-transform: uppercase; letter-spacing: .14em; margin: 0 0 20px; color: #e9f3ec; }
  .card { background: linear-gradient(180deg, var(--panel), #0a0d0f);
    border: 1px solid var(--line); border-radius: 4px; padding: 24px; }
  .step { margin-bottom: 18px; }
  .step .n { color: var(--green); font-weight: 700; }
  .btn { display: inline-block; text-decoration: none; color: #04130a; background: var(--green);
    font-weight: 700; letter-spacing: .06em; text-transform: uppercase; font-size: 13px;
    padding: 12px 20px; border: 0; border-radius: 3px; cursor: pointer; margin-top: 8px; }
  input[type=text] { width: 100%; padding: 10px; margin: 10px 0; background: #05080a;
    border: 1px solid var(--line); color: var(--fg); border-radius: 3px; font: inherit; }
  code { color: var(--amber); }
  .muted { color: var(--dim); font-size: 13px; }
  .err { color: var(--amber); margin: 12px 0; }
  .ok { color: var(--green); font-size: 16px; margin: 0 0 8px; }
  .modes { margin: 18px 0; padding-top: 16px; border-top: 1px solid var(--line); }
  .modes label { display: block; margin: 8px 0; cursor: pointer; }
  .modes input[type=radio] { margin-right: 8px; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
  .foot a { color: var(--dim); }
</style>
</head>
<body><div class="wrap"><h1>${escapeHtml(deviceName)} // LINK</h1><div class="card">${body}</div></div></body>
</html>
`;
}

const LOGOUT_LINK = `<div class="foot"><a href="/auth/logout">Wyloguj</a></div>`;

/**
 * Shown to anyone not logged in: a short "what is this bot" description plus
 * the "Login with Discord" button that starts the session.
 */
export function renderLoginPage(deviceName: string): string {
  return pageShell(deviceName, deviceName, `
    <p>Bot discordowy, który streamuje Spotify na kanał głosowy jako prawdziwe
    urządzenie <b>Spotify Connect</b> — wybierasz je w apce Spotify jak zwykły
    głośnik, wciskasz play, a dźwięk leci na Discordzie. Wymaga konta
    <b>Spotify Premium</b>.</p>

    <div class="step">
      <span class="n">1.</span> Zaloguj się tutaj przez Discord (przycisk niżej).
    </div>
    <div class="step">
      <span class="n">2.</span> Wejdź na kanał głosowy i wpisz <code>/link</code> na
      Discordzie, potem wróć/odśwież tę stronę żeby dokończyć logowanie do Spotify.
    </div>

    <p class="muted">Każda osoba dostaje własny, niezależny player — różni
    ludzie mogą słuchać różnej muzyki naraz. Komendy: <code>/join</code>
    <code>/leave</code> <code>/np</code> <code>/playpause</code> <code>/skip</code>
    <code>/prev</code> <code>/volume</code> <code>/lyrics</code> <code>/device</code>.</p>

    <a class="btn" href="/auth/discord/login">Zaloguj przez Discord</a>
  `);
}

/** Shown when the Discord OAuth exchange itself fails. */
export function renderAuthErrorPage(deviceName: string, message: string): string {
  return pageShell("Login failed", deviceName, `
    <p class="err">Logowanie się nie powiodło: ${escapeHtml(message)}</p>
    <a class="btn" href="/auth/discord/login">Spróbuj ponownie</a>
  `);
}

/** Shown to a logged-in user who has never run /link (no player exists yet). */
export function renderNoPlayerPage(deviceName: string): string {
  return pageShell("Not linked yet", deviceName, `
    <p>Nie masz jeszcze swojego playera.</p>
    <p class="muted">Wejdź na kanał głosowy i wpisz <code>/link</code> na Discordzie,
    potem odśwież tę stronę.</p>
    ${LOGOUT_LINK}
  `);
}

/**
 * Auth mode "spotify_token": the real Spotify login, via our own registered
 * app — no copy-pasting a broken redirect URL, Spotify sends the code
 * straight back to our own domain.
 */
export function renderSpotifyLinkPage(deviceName: string, error?: string): string {
  return pageShell("Link your Spotify", deviceName, `
    <p>Połącz swoje konto Spotify (wymaga <b>Premium</b>) — otworzy się prawdziwa
    strona logowania Spotify, bez wklejania żadnych kodów.</p>
    ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
    <a class="btn" href="/auth/spotify/login">Połącz Spotify</a>
    ${LOGOUT_LINK}
  `);
}

/** The two-step "authorize, then paste the redirect URL" form. */
export function renderLinkForm(opts: { authUrl: string; deviceName: string; error?: string }): string {
  return pageShell("Link your Spotify", opts.deviceName, `
    <div class="step">
      <span class="n">1.</span> Zaloguj się do Spotify na koncie, którego chcesz użyć:<br/>
      <a class="btn" href="${escapeHtml(opts.authUrl)}" target="_blank" rel="noopener">Autoryzuj Spotify</a>
    </div>
    <div class="step">
      <span class="n">2.</span> Po zaakceptowaniu przeglądarka spróbuje otworzyć adres zaczynający się
      od <code>127.0.0.1</code> — <b>to normalne, ta strona się nie wczyta</b>. Skopiuj z paska adresu
      <b>cały</b> ten link i wklej go tutaj:
    </div>
    ${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
    <form method="POST" action="/code">
      <input type="text" name="code" placeholder="http://127.0.0.1:.../login?code=..." required autofocus />
      <button class="btn" type="submit">Zakończ linkowanie</button>
    </form>
    <p class="muted">Po zakończeniu wybierz <b>${escapeHtml(opts.deviceName)}</b> w Spotify → Urządzenia.</p>
    ${LOGOUT_LINK}
  `);
}

const MODE_LABELS: Record<ChannelStatusMode, string> = {
  off: "Wyłączony",
  song: "Nazwa piosenki",
  lyrics: "Teksty na żywo (karaoke)",
};

/** Shown once the account is linked — a small, user-scoped status view. */
export function renderStatusPage(opts: {
  deviceName: string;
  track: TrackView | null;
  channelStatusMode: ChannelStatusMode;
}): string {
  const now = opts.track
    ? `<p><b>${escapeHtml(opts.track.name)}</b><br/><span class="muted">${escapeHtml(opts.track.artists)}</span></p>`
    : `<p class="muted">Nic teraz nie gra.</p>`;
  const modeInputs = (Object.keys(MODE_LABELS) as ChannelStatusMode[])
    .map(
      (mode) => `
      <label>
        <input type="radio" name="mode" value="${mode}" ${mode === opts.channelStatusMode ? "checked" : ""}
          onchange="this.form.requestSubmit()" />
        ${escapeHtml(MODE_LABELS[mode])}
      </label>`,
    )
    .join("");
  return pageShell("Linked", opts.deviceName, `
    <p class="ok">✅ Zalinkowano!</p>
    <p>Wybierz <b>${escapeHtml(opts.deviceName)}</b> w Spotify → Urządzenia i wciśnij play.</p>
    ${now}
    <div class="modes">
      <p class="muted">Status Twojego kanału głosowego podczas grania:</p>
      <form method="POST" action="/mode">
        ${modeInputs}
      </form>
    </div>
    ${LOGOUT_LINK}
  `);
}

/** Read a request body, rejecting once it exceeds `maxBytes` — this endpoint
 *  is public-facing, unlike the loopback-only admin panel. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Public web page that replaces `/code`: log in with Discord (real OAuth2
 * session, HttpOnly signed cookie — no per-user tokens to hand out anymore),
 * then see whatever state your player is in: not linked yet, mid-login
 * (authorize + paste the redirect URL), or your own status once linked.
 */
export class LinkPortal {
  private server: Server | null = null;
  private readonly sessionSigner = new SessionSigner();

  constructor(private readonly pool: PlayerPool) {}

  start(): void {
    if (!config.linkPortal.enabled) {
      console.log("[link-portal] disabled (LINK_PORTAL_ENABLED=false)");
      return;
    }
    if (!config.linkPortal.baseUrl) {
      console.warn(
        "[link-portal] LINK_PORTAL_BASE_URL is not set, so login redirects can't work. " +
          "Link portal is NOT running for this session.",
      );
      return;
    }
    if (!config.discord.clientSecret) {
      console.warn(
        "[link-portal] DISCORD_CLIENT_SECRET is not set, so 'Login with Discord' can't work. " +
          "Link portal is NOT running for this session.",
      );
      return;
    }
    if (config.librespot.authMode === "spotify_token" && (!config.spotify.clientId || !config.spotify.clientSecret)) {
      // Non-fatal: Discord login still works, but /link can't finish since
      // there's no credentials to reach our own Spotify app with.
      console.warn(
        "[link-portal] LIBRESPOT_AUTH=spotify_token but SPOTIFY_CLIENT_ID/SECRET are not set — " +
          "'Link Spotify' will fail until they're configured.",
      );
    }
    const server = createServer((req, res) => void this.handle(req, res));
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[link-portal] port ${config.linkPortal.port} is already in use — set LINK_PORTAL_PORT to a free port. ` +
            `Link portal is NOT running for this session.`,
        );
      } else {
        console.error(`[link-portal] server error: ${err.message}`);
      }
      server.close();
      this.server = null;
    });
    server.listen(config.linkPortal.port, config.linkPortal.host, () => {
      console.log(
        `[link-portal] listening on http://${config.linkPortal.host}:${config.linkPortal.port} ` +
          `(public: ${config.linkPortal.baseUrl})`,
      );
    });
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private discordRedirectUri(): string {
    return `${config.linkPortal.baseUrl.replace(/\/$/, "")}/auth/discord/callback`;
  }

  private spotifyRedirectUri(): string {
    return `${config.linkPortal.baseUrl.replace(/\/$/, "")}/auth/spotify/callback`;
  }

  private sessionUserId(req: IncomingMessage): string | null {
    return this.sessionSigner.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  }

  private cookieHeader(value: string, maxAgeSeconds: number): string {
    const secure = config.linkPortal.baseUrl.startsWith("https://") ? "; Secure" : "";
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
  }

  /** Whatever state `userId`'s player is in, as the matching page. */
  private panelHtml(userId: string, error?: string): string {
    if (config.librespot.authMode === "spotify_token") {
      if (!this.pool.isUserAuthenticated(userId)) return renderSpotifyLinkPage(config.librespot.deviceName, error);
      const slot = this.pool.slotForUser(userId);
      return renderStatusPage({
        deviceName: slot?.deviceName ?? config.librespot.deviceName,
        track: toTrackView(slot?.getTrack() ?? null),
        channelStatusMode: this.pool.getChannelStatusMode(userId),
      });
    }

    // Legacy interactive-mode flow.
    const slot = this.pool.slotForUser(userId);
    if (slot?.isAuthenticated()) {
      return renderStatusPage({
        deviceName: slot.deviceName,
        track: toTrackView(slot.getTrack()),
        channelStatusMode: this.pool.getChannelStatusMode(userId),
      });
    }
    const authUrl = slot?.getAuthUrl();
    if (slot && authUrl) {
      return renderLinkForm({ authUrl, deviceName: slot.deviceName, error });
    }
    return renderNoPlayerPage(config.librespot.deviceName);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (pathname === "/" && req.method === "GET") return this.handleHome(req, res);
    if (pathname === "/auth/discord/login" && req.method === "GET") return this.handleDiscordLogin(res);
    if (pathname === "/auth/discord/callback" && req.method === "GET") {
      return this.handleDiscordCallback(url, res);
    }
    if (pathname === "/auth/spotify/login" && req.method === "GET") return this.handleSpotifyLogin(req, res);
    if (pathname === "/auth/spotify/callback" && req.method === "GET") {
      return this.handleSpotifyCallback(req, url, res);
    }
    if (pathname === "/auth/logout" && req.method === "GET") return this.handleLogout(res);
    if (pathname === "/code" && req.method === "POST") return this.handleSubmitCode(req, res);
    if (pathname === "/mode" && req.method === "POST") return this.handleSetMode(req, res);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }

  private handleHome(req: IncomingMessage, res: ServerResponse): void {
    const userId = this.sessionUserId(req);
    if (!userId) return this.sendHtml(res, 200, renderLoginPage(config.librespot.deviceName));
    return this.sendHtml(res, 200, this.panelHtml(userId));
  }

  private handleDiscordLogin(res: ServerResponse): void {
    res.writeHead(302, { location: discordAuthorizeUrl(config.discord.clientId, this.discordRedirectUri()) });
    res.end();
  }

  private async handleDiscordCallback(url: URL, res: ServerResponse): Promise<void> {
    const code = url.searchParams.get("code");
    if (!code) {
      return this.sendHtml(res, 400, renderAuthErrorPage(config.librespot.deviceName, "Brak kodu w odpowiedzi Discorda."));
    }
    try {
      const accessToken = await exchangeDiscordCode({
        clientId: config.discord.clientId,
        clientSecret: config.discord.clientSecret,
        redirectUri: this.discordRedirectUri(),
        code,
      });
      const user = await fetchDiscordUser(accessToken);
      res.setHeader("Set-Cookie", this.cookieHeader(this.sessionSigner.sign(user.id), 60 * 60 * 24 * 30));
      res.writeHead(302, { location: "/" });
      res.end();
    } catch (err) {
      this.sendHtml(res, 502, renderAuthErrorPage(config.librespot.deviceName, (err as Error).message));
    }
  }

  private handleSpotifyLogin(req: IncomingMessage, res: ServerResponse): void {
    if (!this.sessionUserId(req)) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    res.writeHead(302, { location: spotifyAuthorizeUrl(config.spotify.clientId, this.spotifyRedirectUri()) });
    res.end();
  }

  private async handleSpotifyCallback(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const userId = this.sessionUserId(req);
    if (!userId) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      return this.sendHtml(
        res,
        400,
        renderSpotifyLinkPage(config.librespot.deviceName, `Spotify odrzuciło żądanie: ${errorParam}`),
      );
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return this.sendHtml(res, 400, renderSpotifyLinkPage(config.librespot.deviceName, "Brak kodu w odpowiedzi Spotify."));
    }
    try {
      const token = await exchangeSpotifyCode({
        clientId: config.spotify.clientId,
        clientSecret: config.spotify.clientSecret,
        redirectUri: this.spotifyRedirectUri(),
        code,
      });
      if (!token.refreshToken) throw new Error("Spotify nie zwróciło refresh tokenu.");
      const profile = await fetchSpotifyProfile(token.accessToken);
      await this.pool.linkSpotifyAccount(userId, profile.id, token.refreshToken, token.accessToken);
    } catch (err) {
      return this.sendHtml(res, 502, renderSpotifyLinkPage(config.librespot.deviceName, (err as Error).message));
    }
    res.writeHead(302, { location: "/" });
    res.end();
  }

  private handleLogout(res: ServerResponse): void {
    res.setHeader("Set-Cookie", this.cookieHeader("", 0));
    res.writeHead(302, { location: "/" });
    res.end();
  }

  private async handleSubmitCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = this.sessionUserId(req);
    if (!userId) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    const slot = this.pool.slotForUser(userId);
    if (!slot) return this.sendHtml(res, 409, renderNoPlayerPage(config.librespot.deviceName));

    let body: string;
    try {
      body = await readBody(req, 8 * 1024);
    } catch {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large");
      return;
    }
    const code = extractAuthCode(new URLSearchParams(body).get("code") ?? "");
    if (!code) {
      return this.sendHtml(
        res,
        400,
        this.panelHtml(userId, "Nie znalazłem code=… w tym co wkleiłeś. Wklej cały adres z paska przeglądarki."),
      );
    }

    if (!slot.isAwaitingCode()) {
      if (slot.isAuthenticated()) return this.sendHtml(res, 200, this.panelHtml(userId));
      return this.sendHtml(
        res,
        409,
        this.panelHtml(userId, "Nie ma teraz aktywnego logowania — wróć na Discorda i uruchom /link ponownie."),
      );
    }

    try {
      await slot.submitAuthCode(code);
    } catch (err) {
      return this.sendHtml(
        res,
        400,
        this.panelHtml(
          userId,
          `Linkowanie nie powiodło się: ${(err as Error).message}. Spróbuj kliknąć link autoryzacji jeszcze raz.`,
        ),
      );
    }
    return this.sendHtml(res, 200, this.panelHtml(userId));
  }

  /** Set `userId`'s channel-status preference and re-render their panel. */
  private async handleSetMode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const userId = this.sessionUserId(req);
    if (!userId) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    let body: string;
    try {
      body = await readBody(req, 1024);
    } catch {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large");
      return;
    }
    const raw = new URLSearchParams(body).get("mode");
    const mode: ChannelStatusMode = raw === "song" || raw === "lyrics" ? raw : "off";
    this.pool.setChannelStatusMode(userId, mode);
    return this.sendHtml(res, 200, this.panelHtml(userId));
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }
}
