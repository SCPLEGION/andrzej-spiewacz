/**
 * Lyrics lookup for the karaoke board. Several providers are queried in priority
 * order so a song missing from one still turns up in another; synced ("karaoke")
 * lyrics are always preferred over plain text. Nothing here touches Discord — it
 * is pure fetching + parsing so it can be unit-tested in isolation.
 */

/** A single timestamped lyric line. */
export interface LrcLine {
  /** Offset from the start of the track, in milliseconds. */
  timeMs: number;
  /** Line text; empty for instrumental gaps. */
  text: string;
}

/** Outcome of a lyrics lookup. `lines` is set only when synced lyrics exist. */
export interface LyricsResult {
  /** Where the lyrics came from — shown in the embed footer ("w rogu"). */
  source: string;
  /** Timestamped lines for karaoke, or null when only plain text was found. */
  lines: LrcLine[] | null;
  /** Full plain-text lyrics, or null when none were found. */
  plain: string | null;
}

/** What we know about the track to look up. */
export interface LyricsQuery {
  artist: string;
  title: string;
  album?: string;
  durationSec?: number;
}

/** Identify ourselves politely to the free lyrics APIs. */
const USER_AGENT = "andrzej-spiewacz (https://github.com/SCPLEGION/andrzej-spiewacz)";

/**
 * Parse an LRC blob into sorted timestamped lines. Handles several timestamps on
 * one line (`[00:10.00][00:40.00]text`), `mm:ss.xx` and `mm:ss:xx` fractions,
 * and ignores metadata tags like `[ar:...]` (no minute:second shape). Untimed
 * lines are dropped.
 */
export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = [];
  const stamp = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const raw of lrc.split(/\r?\n/)) {
    stamp.lastIndex = 0;
    const times: number[] = [];
    let textStart = 0;
    let m: RegExpExecArray | null;
    while ((m = stamp.exec(raw))) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const frac = m[3] ? Number(`0.${m[3]}`) : 0;
      times.push(Math.round((min * 60 + sec + frac) * 1000));
      textStart = stamp.lastIndex;
    }
    if (!times.length) continue;
    const text = raw.slice(textStart).trim();
    for (const t of times) out.push({ timeMs: t, text });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Index of the line that should be highlighted at `posMs`: the last line whose
 * timestamp has already passed. Returns -1 before the first line (intro).
 */
export function currentLineIndex(lines: LrcLine[], posMs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line && line.timeMs <= posMs) idx = i;
    else break;
  }
  return idx;
}

/** Lines shown above / below the active line in the karaoke window. */
const LINES_BEFORE = 2;
const LINES_AFTER = 5;

/**
 * Render a karaoke window as plain Markdown: a few lines of context with the
 * active line bolded and arrow-marked. `current` may be -1 (before the first
 * line). Empty lines render as a music note.
 */
export function renderKaraoke(lines: LrcLine[], current: number): string {
  if (!lines.length) return "♪";
  const start = Math.max(0, current - LINES_BEFORE);
  const end = Math.min(lines.length, Math.max(current, 0) + LINES_AFTER + 1);
  const rows: string[] = [];
  for (let i = start; i < end; i++) {
    const text = lines[i]?.text || "♪";
    rows.push(i === current ? `**▶ ${text}**` : ` ${text}`);
  }
  return rows.join("\n") || "♪";
}

/** Fetch JSON with a short timeout and a UA header; null on any failure. */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

interface LrclibTrack {
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
}

/**
 * Strip "noise" suffixes a streaming service adds to titles (Remastered, Live,
 * feat., versions, bracketed tags) so a too-specific title still matches the
 * canonical lyrics entry. Returns the cleaned title (possibly unchanged).
 */
export function simplifyTitle(title: string): string {
  return title
    .replace(
      /\s*[-–—]\s*(remaster(ed)?|live|radio edit|mono|stereo|acoustic|deluxe|single version|album version)\b.*$/i,
      "",
    )
    .replace(/\s*\((feat\.?|ft\.?|with|remaster(ed)?|live|acoustic|version|edit)[^)]*\)/gi, "")
    .replace(/\s*\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** One LRCLIB search, returning the first hit that actually carries lyrics. */
async function lrclibSearch(title: string, artist: string): Promise<LrclibTrack | null> {
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set("artist_name", artist);
  const hits = await getJson<LrclibTrack[]>(`https://lrclib.net/api/search?${params}`);
  return hits?.find((h) => h.syncedLyrics || h.plainLyrics) ?? null;
}

/**
 * LRCLIB — free, no API key, and the one provider here that returns synced
 * lyrics. Tries an exact get first (best match), then a fuzzy search on the raw
 * title, then on a cleaned-up title so "Song (Remastered 2011)" still resolves.
 */
async function fromLrclib(q: LyricsQuery): Promise<LyricsResult | null> {
  const exact = new URLSearchParams({ artist_name: q.artist, track_name: q.title });
  if (q.album) exact.set("album_name", q.album);
  if (q.durationSec) exact.set("duration", String(q.durationSec));

  let track = q.artist ? await getJson<LrclibTrack>(`https://lrclib.net/api/get?${exact}`) : null;
  if (!track) track = await lrclibSearch(q.title, q.artist);
  if (!track) {
    const simple = simplifyTitle(q.title);
    if (simple && simple !== q.title) track = await lrclibSearch(simple, q.artist);
  }
  if (!track) return null;

  const lines = track.syncedLyrics ? parseLrc(track.syncedLyrics) : [];
  const plain = track.plainLyrics?.trim() || null;
  if (!lines.length && !plain) return null;
  return { source: "LRCLIB", lines: lines.length ? lines : null, plain };
}

/** lyrics.ovh — plain text only, a last resort when LRCLIB has nothing. */
async function fromLyricsOvh(q: LyricsQuery): Promise<LyricsResult | null> {
  // lyrics.ovh matches a single performer, so take the primary artist.
  const artist = (q.artist.split(",")[0] ?? q.artist).trim();
  const data = await getJson<{ lyrics?: string }>(
    `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(q.title)}`,
  );
  const plain = data?.lyrics?.trim();
  if (!plain) return null;
  return { source: "lyrics.ovh", lines: null, plain };
}

/**
 * Look up lyrics across providers in priority order. Synced lyrics win outright;
 * otherwise the first plain-text result found is returned so there's still
 * something to show. Returns null when nothing turns up anywhere.
 */
export async function fetchLyrics(q: LyricsQuery): Promise<LyricsResult | null> {
  const providers = [fromLrclib, fromLyricsOvh];
  let plainFallback: LyricsResult | null = null;
  for (const provider of providers) {
    const result = await provider(q);
    if (result?.lines?.length) return result;
    if (result?.plain && !plainFallback) plainFallback = result;
  }
  return plainFallback;
}
