/**
 * OAuth against OUR OWN Spotify Developer app — used to authenticate a real
 * Spotify Connect session via go-librespot's `spotify_token` credential type,
 * bypassing go-librespot's built-in interactive OAuth client (which Spotify
 * currently rejects with `invalid_scope` — a scope restriction on that shared
 * client we cannot configure around, verified by inspecting the binary).
 */

/** The Spotify authorize URL for our own app. */
export function spotifyAuthorizeUrl(clientId: string, redirectUri: string): string {
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "streaming user-read-email user-read-private");
  return url.toString();
}

export interface SpotifyTokenResult {
  accessToken: string;
  /** Present on the initial code exchange; Spotify may also rotate it on refresh. */
  refreshToken?: string;
  expiresIn: number;
}

async function postToken(
  clientId: string,
  clientSecret: string,
  body: URLSearchParams,
): Promise<SpotifyTokenResult> {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body,
  });
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`Spotify token request failed: ${json.error_description || json.error || res.status}`);
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresIn: json.expires_in ?? 3600 };
}

/** Exchange an authorization code for an access + refresh token pair. */
export function exchangeSpotifyCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<SpotifyTokenResult> {
  return postToken(
    opts.clientId,
    opts.clientSecret,
    new URLSearchParams({ grant_type: "authorization_code", code: opts.code, redirect_uri: opts.redirectUri }),
  );
}

/** Mint a fresh access token from a stored refresh token. Spotify may rotate
 *  the refresh token itself — callers must persist `refreshToken` if present. */
export function refreshSpotifyToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<SpotifyTokenResult> {
  return postToken(
    opts.clientId,
    opts.clientSecret,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: opts.refreshToken }),
  );
}

export interface SpotifyProfile {
  id: string;
  displayName: string;
}

/** Fetch the logged-in user's Spotify profile — `id` is what go-librespot's
 *  `spotify_token` credential type wants as `username`. */
export async function fetchSpotifyProfile(accessToken: string): Promise<SpotifyProfile> {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = (await res.json()) as { id?: string; display_name?: string; error?: { message?: string } };
  if (!res.ok || !body.id) {
    throw new Error(`Couldn't fetch Spotify profile: ${body.error?.message || res.status}`);
  }
  return { id: body.id, displayName: body.display_name ?? body.id };
}
