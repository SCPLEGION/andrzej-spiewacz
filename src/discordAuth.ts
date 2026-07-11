import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Minimal Discord user profile from GET /users/@me — only what we need. */
export interface DiscordUser {
  id: string;
  username: string;
}

/** The "Login with Discord" authorize URL (identify scope only — just enough
 *  to know who's logged in, no email/guilds/anything else). */
export function discordAuthorizeUrl(clientId: string, redirectUri: string): string {
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  return url.toString();
}

/** Exchange an OAuth code for an access token (server-side; needs the client secret). */
export async function exchangeDiscordCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<string> {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(`Discord token exchange failed: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token;
}

/** Fetch the logged-in user's Discord profile with their access token. */
export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = (await res.json()) as { id?: string; username?: string; message?: string };
  if (!res.ok || !body.id) {
    throw new Error(`Couldn't fetch Discord profile: ${body.message || res.status}`);
  }
  return { id: body.id, username: body.username ?? body.id };
}

/**
 * Signs and verifies session cookie values binding a browser to a Discord
 * user id. The signing secret is a fresh random value per process — a restart
 * naturally invalidates every existing session rather than needing an
 * explicit expiry or a persisted secret.
 */
export class SessionSigner {
  private readonly secret: Buffer;

  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret;
  }

  /** `payload.signature`, both base64url. */
  sign(userId: string): string {
    const payload = Buffer.from(userId, "utf8").toString("base64url");
    return `${payload}.${this.hmac(payload)}`;
  }

  /** The userId a valid, unmodified cookie value encodes, or null. */
  verify(value: string | undefined | null): string | null {
    if (!value) return null;
    const dot = value.indexOf(".");
    if (dot === -1) return null;
    const payload = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    const expected = this.hmac(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      return Buffer.from(payload, "base64url").toString("utf8");
    } catch {
      return null;
    }
  }

  private hmac(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url");
  }
}

/** Parse a raw `Cookie` request header into a name→value map (pure). */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
