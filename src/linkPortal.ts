import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { extractAuthCode } from "./librespot.js";
import { escapeHtml, toTrackView, type TrackView } from "./panel.js";
import type { PlayerPool } from "./pool.js";
import type { ChannelStatusMode } from "./channelStatusPrefs.js";

/** How long a /link session stays valid, whether or not it's finished. */
const SESSION_TTL_MS = 30 * 60 * 1000;

/** A pending or completed link session: one user's in-flight OAuth flow. */
export interface LinkSession {
  userId: string;
  authUrl: string;
  createdAt: number;
}

/** Cryptographically random, URL-safe token — knowledge of it IS the auth. */
export function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * In-memory store of link-portal sessions, one per in-flight /link. `now` is
 * threaded through every lookup so expiry is deterministically testable
 * without real sleeps. A user has at most one live session — a fresh /link
 * invalidates whatever token they had pending before.
 */
export class LinkSessionStore {
  private readonly byToken = new Map<string, LinkSession>();
  private readonly byUser = new Map<string, string>();

  /** Start a new session for `userId`, invalidating any previous pending one. */
  create(userId: string, authUrl: string, now: number): string {
    const previous = this.byUser.get(userId);
    if (previous) this.byToken.delete(previous);
    const token = generateToken();
    this.byToken.set(token, { userId, authUrl, createdAt: now });
    this.byUser.set(userId, token);
    return token;
  }

  /** The session for `token`, or undefined if it doesn't exist or has expired. */
  get(token: string, now: number): LinkSession | undefined {
    const session = this.byToken.get(token);
    if (!session) return undefined;
    if (now - session.createdAt > SESSION_TTL_MS) {
      this.byToken.delete(token);
      if (this.byUser.get(session.userId) === token) this.byUser.delete(session.userId);
      return undefined;
    }
    return session;
  }
}

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
</style>
</head>
<body><div class="wrap"><h1>${escapeHtml(deviceName)} // LINK</h1><div class="card">${body}</div></div></body>
</html>
`;
}

/** Shown for a missing/expired/already-consumed token. */
export function renderExpiredPage(deviceName: string): string {
  return pageShell("Link expired", deviceName, `
    <p>Ten link wygasł albo jest nieprawidłowy.</p>
    <p class="muted">Uruchom <code>/link</code> jeszcze raz na Discordzie, żeby dostać nowy.</p>
  `);
}

/** The two-step "authorize, then paste the redirect URL" form. */
export function renderLinkForm(opts: {
  token: string;
  authUrl: string;
  deviceName: string;
  error?: string;
}): string {
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
    <form method="POST" action="/link/${encodeURIComponent(opts.token)}">
      <input type="text" name="code" placeholder="http://127.0.0.1:.../login?code=..." required autofocus />
      <button class="btn" type="submit">Zakończ linkowanie</button>
    </form>
    <p class="muted">Po zakończeniu wybierz <b>${escapeHtml(opts.deviceName)}</b> w Spotify → Urządzenia.</p>
  `);
}

const MODE_LABELS: Record<ChannelStatusMode, string> = {
  off: "Wyłączony",
  song: "Nazwa piosenki",
  lyrics: "Teksty na żywo (karaoke)",
};

/** Shown once the account is linked — a small, user-scoped status view. */
export function renderStatusPage(opts: {
  token: string;
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
      <form method="POST" action="/link/${encodeURIComponent(opts.token)}/mode">
        ${modeInputs}
      </form>
    </div>
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
 * Public web page that replaces `/code`: `/link` in Discord sends the caller a
 * one-time link here instead of the raw authorize URL. The page shows the
 * "authorize Spotify" button and a box to paste the resulting (broken,
 * 127.0.0.1) redirect URL — submitting it does what `/code` used to do. Once
 * linked, revisiting the same link shows the caller's own status.
 */
export class LinkPortal {
  private server: Server | null = null;
  private readonly sessions = new LinkSessionStore();

  constructor(private readonly pool: PlayerPool) {}

  /** Begin a new link session for `userId`, returning the public URL to send them. */
  beginSession(userId: string, authUrl: string): string {
    const token = this.sessions.create(userId, authUrl, Date.now());
    return `${config.linkPortal.baseUrl.replace(/\/$/, "")}/link/${token}`;
  }

  start(): void {
    if (!config.linkPortal.enabled) {
      console.log("[link-portal] disabled (LINK_PORTAL_ENABLED=false)");
      return;
    }
    if (!config.linkPortal.baseUrl) {
      console.warn(
        "[link-portal] LINK_PORTAL_BASE_URL is not set, so /link can't produce a usable link. " +
          "Link portal is NOT running for this session.",
      );
      return;
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const modeMatch = url.pathname.match(/^\/link\/([^/]+)\/mode$/);
    if (modeMatch?.[1]) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed");
        return;
      }
      return this.handleSetMode(decodeURIComponent(modeMatch[1]), req, res);
    }

    const match = url.pathname.match(/^\/link\/([^/]+)$/);
    if (!match?.[1]) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const token = decodeURIComponent(match[1]);

    if (req.method === "GET") return this.handleGet(token, res);
    if (req.method === "POST") return this.handlePost(token, req, res);
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("method not allowed");
  }

  private handleGet(token: string, res: ServerResponse): void {
    const session = this.sessions.get(token, Date.now());
    if (!session) return this.sendHtml(res, 404, renderExpiredPage(config.librespot.deviceName));

    const slot = this.pool.slotForUser(session.userId);
    if (slot?.isAuthenticated()) {
      return this.sendHtml(res, 200, this.statusPageFor(token, session.userId, slot));
    }
    return this.sendHtml(
      res,
      200,
      renderLinkForm({
        token,
        authUrl: session.authUrl,
        deviceName: slot?.deviceName ?? config.librespot.deviceName,
      }),
    );
  }

  /** Set `userId`'s channel-status preference and re-render their status page. */
  private async handleSetMode(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.sessions.get(token, Date.now());
    if (!session) return this.sendHtml(res, 404, renderExpiredPage(config.librespot.deviceName));

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
    this.pool.setChannelStatusMode(session.userId, mode);

    const slot = this.pool.slotForUser(session.userId);
    return this.sendHtml(res, 200, this.statusPageFor(token, session.userId, slot));
  }

  /** Assemble the status page for `userId`, reading their current mode from the pool. */
  private statusPageFor(token: string, userId: string, slot: ReturnType<PlayerPool["slotForUser"]>): string {
    return renderStatusPage({
      token,
      deviceName: slot?.deviceName ?? config.librespot.deviceName,
      track: toTrackView(slot?.getTrack() ?? null),
      channelStatusMode: this.pool.getChannelStatusMode(userId),
    });
  }

  private async handlePost(token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const session = this.sessions.get(token, Date.now());
    if (!session) return this.sendHtml(res, 404, renderExpiredPage(config.librespot.deviceName));

    const slot = this.pool.slotForUser(session.userId);
    if (!slot) {
      return this.sendHtml(
        res,
        409,
        renderLinkForm({
          token,
          authUrl: session.authUrl,
          deviceName: config.librespot.deviceName,
          error: "Twój odtwarzacz już nie działa — wróć na Discorda i uruchom /link ponownie.",
        }),
      );
    }

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
        renderLinkForm({
          token,
          authUrl: session.authUrl,
          deviceName: slot.deviceName,
          error: "Nie znalazłem code=… w tym co wkleiłeś. Wklej cały adres z paska przeglądarki.",
        }),
      );
    }

    if (!slot.isAwaitingCode()) {
      if (slot.isAuthenticated()) {
        return this.sendHtml(res, 200, this.statusPageFor(token, session.userId, slot));
      }
      return this.sendHtml(
        res,
        409,
        renderLinkForm({
          token,
          authUrl: session.authUrl,
          deviceName: slot.deviceName,
          error: "Nie ma teraz aktywnego logowania — wróć na Discorda i uruchom /link ponownie.",
        }),
      );
    }

    try {
      await slot.submitAuthCode(code);
    } catch (err) {
      return this.sendHtml(
        res,
        400,
        renderLinkForm({
          token,
          authUrl: session.authUrl,
          deviceName: slot.deviceName,
          error: `Linkowanie nie powiodło się: ${(err as Error).message}. Spróbuj kliknąć link autoryzacji jeszcze raz.`,
        }),
      );
    }
    return this.sendHtml(res, 200, this.statusPageFor(token, session.userId, slot));
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  }
}
