/**
 * Data Service.
 *
 * The daily ORB scrape lives in playlists.json with just {artist, title}
 * per track. Cover art + 30-second preview audio are resolved at runtime
 * in the browser via iTunes Search API:
 *
 *   - CORS-friendly (Access-Control-Allow-Origin: *), no auth.
 *   - Returns stable, non-expiring 30-second .m4a preview URLs and
 *     1000x1000 cover art (via the standard `…/1000x1000bb.jpg` upscale).
 *   - Rate-limited per source IP — each user makes their own calls so we
 *     never hit a shared limit (the build-time iTunes calls failed because
 *     all 200+ requests came from one GitHub Actions egress IP).
 *
 * In-memory + localStorage caches keep repeat lookups instant. Successful
 * matches persist for ENRICH_TTL_MS; misses are cached briefly so we don't
 * pound the API for tracks iTunes simply doesn't have.
 */
import { findStation } from '../data/stations.js';

const PER_STATION    = 40;
const ENRICH_TTL_MS  = 24 * 60 * 60 * 1000;   // iTunes URLs are stable; cache for 24h
const NEG_TTL_MS     = 6  * 60 * 60 * 1000;   // re-try unknown tracks after 6h
const LS_PREFIX      = 'rf_enrich_v3:';   // bumped: matching logic changed
const ITUNES_SEARCH  = 'https://itunes.apple.com/search';

let playlistsPromise = null;
const memCache = new Map();              // key → { ts, data }
const inflight = new Map();              // key → Promise (dedupe concurrent fetches)

function loadPlaylists() {
  if (!playlistsPromise) {
    const day = new Date().toISOString().slice(0, 10);
    const url = new URL(`./data/playlists.json?v=${day}`, document.baseURI);
    playlistsPromise = fetch(url, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`playlists.json HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.error('Failed to load playlists.json:', err);
        return { generatedAt: null, stations: {} };
      });
  }
  return playlistsPromise;
}

export function clearPlaylistCache() {
  playlistsPromise = null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function trackKey(artist, title) {
  return `${artist}|||${title}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function trackId(stationId, artist, title) {
  return `${stationId}:${artist}:${title}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
}

function readLs(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function writeLs(key, value) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {/* full / disabled */}
}

// One-time housekeeping: drop old-version keys and expired entries so
// localStorage doesn't grow forever (it's capped at ~5 MB per origin).
(function pruneLs() {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith('rf_enrich_')) continue;
      if (!k.startsWith(LS_PREFIX)) { localStorage.removeItem(k); continue; }
      const e = JSON.parse(localStorage.getItem(k) || 'null');
      const ttl = e?.data ? ENRICH_TTL_MS : NEG_TTL_MS;
      if (!e?.ts || now - e.ts > ttl) localStorage.removeItem(k);
    }
  } catch {/* storage disabled */}
})();

function fresh(entry, ttl) {
  return entry && entry.ts && (Date.now() - entry.ts < ttl);
}

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')          // drop "(Radio Edit)", "[Live]"
    .replace(/\b(feat|ft|featuring)\b.*$/, ' ')  // drop featured artists
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreResult(r, artist, title) {
  const a = norm(artist), t = norm(title);
  const ra = norm(r.artistName), rt = norm(r.trackName);
  let score = 0;
  if (ra === a) score += 4;
  else if (ra && a && (ra.includes(a) || a.includes(ra))) score += 3;
  if (rt === t) score += 3;
  else if (rt && t && (rt.includes(t) || t.includes(rt))) score += 2;
  if (/karaoke|tribute|made famous|in the style of/i.test(`${r.artistName} ${r.collectionName}`)) score -= 5;
  return score;
}

async function itunesLookup(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const url = `${ITUNES_SEARCH}?term=${q}&media=music&entity=song&limit=8`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    console.warn('iTunes fetch error:', e?.message || e);
    return null;
  }
  if (!res.ok) {
    console.warn(`iTunes HTTP ${res.status} for "${artist} - ${title}"`);
    return null;
  }
  let data;
  try { data = await res.json(); } catch { return null; }

  // Pick the best-matching result instead of blindly taking #1, which is
  // often a cover version, karaoke track or a different artist.
  const candidates = (data?.results || [])
    .filter(r => r.previewUrl)
    .map(r => ({ r, s: scoreResult(r, artist, title) }))
    .sort((x, y) => y.s - x.s);
  const best = candidates[0];
  if (!best || best.s < 3) return null;   // no convincing match → no wrong song
  const t = best.r;

  const art = t.artworkUrl100
    ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg')
    : null;
  return {
    coverArt:   art,
    previewUrl: t.previewUrl,
    album:      t.collectionName || '',
    duration:   t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
    deezerLink: null,
    appleLink:  t.trackViewUrl || null,
  };
}

/**
 * Resolve cover + preview for a track. Returns the original track object
 * with `coverArt`, `previewUrl`, `album`, `duration` filled in (or kept
 * null on failure).
 *
 * Concurrent calls for the same track dedupe to a single network request.
 */
export async function enrichTrack(track) {
  if (!track || (track.coverArt && track.previewUrl)) return track;
  const key = trackKey(track.artist, track.title);

  // Memory cache (fastest)
  const mem = memCache.get(key);
  if (mem) {
    if (mem.data && fresh(mem, ENRICH_TTL_MS)) return { ...track, ...mem.data };
    if (!mem.data && fresh(mem, NEG_TTL_MS))   return track;
  }

  // localStorage cache
  const ls = readLs(key);
  if (ls) {
    if (ls.data && fresh(ls, ENRICH_TTL_MS)) {
      memCache.set(key, ls);
      return { ...track, ...ls.data };
    }
    if (!ls.data && fresh(ls, NEG_TTL_MS)) {
      memCache.set(key, ls);
      return track;
    }
  }

  // Dedupe in-flight requests
  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return data ? { ...track, ...data } : track;
  }

  const promise = itunesLookup(track.artist, track.title).then(data => {
    inflight.delete(key);
    const entry = { ts: Date.now(), data: data || null };
    memCache.set(key, entry);
    writeLs(key, entry);
    return data;
  }).catch(() => { inflight.delete(key); return null; });
  inflight.set(key, promise);
  const data = await promise;
  return data ? { ...track, ...data } : track;
}

/**
 * Build a mix for the given station ids.
 *
 * For each station, take up to PER_STATION random tracks (skipping any id
 * in `exclude`, e.g. tracks already heard this session), round-robin across
 * stations, then final-shuffle. Tracks come back un-enriched: covers and
 * previews are fetched on demand by the feed.
 */
export async function buildMix(stationIds, exclude = new Set()) {
  if (!stationIds?.length) return [];
  const all = await loadPlaylists();

  const queues = stationIds
    .map(id => {
      const station = findStation(id);
      const tracks = (all.stations?.[id] || [])
        .map(t => ({
          id:          trackId(id, t.artist, t.title),
          artist:      t.artist,
          title:       t.title,
          album:       '',
          coverArt:    null,
          previewUrl:  null,
          duration:    null,
          deezerLink:  null,
          appleLink:   null,
          spotifyLink: `https://open.spotify.com/search/${encodeURIComponent(`${t.artist} ${t.title}`)}`,
          stationId:   id,
          station:     station?.name || 'Radio',
        }))
        .filter(t => !exclude.has(t.id));
      return { id, queue: shuffle(tracks).slice(0, PER_STATION) };
    })
    .filter(s => s.queue.length > 0);

  const picked = [];
  while (queues.some(s => s.queue.length)) {
    for (const s of queues) {
      if (s.queue.length) picked.push(s.queue.shift());
    }
  }
  return shuffle(picked);
}

/** Back-compat: build from the stations saved in localStorage. */
export async function buildMosaic() {
  let selected = [];
  try { selected = JSON.parse(localStorage.getItem('radioflow_stations') || '[]'); } catch {}
  return buildMix(selected);
}

/** Number of tracks available per station in today's data. */
export async function stationTrackCounts() {
  const all = await loadPlaylists();
  return Object.fromEntries(
    Object.entries(all.stations || {}).map(([id, arr]) => [id, arr.length])
  );
}

export async function feedDiagnostics() {
  const all = await loadPlaylists();
  return {
    generatedAt: all.generatedAt,
    counts: Object.fromEntries(
      Object.entries(all.stations || {}).map(([id, arr]) => [id, arr.length])
    ),
  };
}
