/**
 * Data Service.
 *
 * The daily ORB scrape lives in playlists.json with just {artist, title}
 * per track. Cover art + 30-second preview audio are resolved at runtime
 * in the browser via Deezer's public API:
 *
 *   - CORS-friendly, no auth, generous per-IP rate (50 req / 5s).
 *   - Each user makes their own calls so we never hit a shared limit.
 *   - Preview URLs are signed (expire in ~35 min) but we always use them
 *     within seconds of fetching, so expiry is irrelevant.
 *
 * In-memory + localStorage caches keep repeat lookups instant. Enrichments
 * persist for ENRICH_TTL_MS so revisits within ~25 min reuse cached audio
 * URLs; older entries are discarded and refetched.
 */
import { findStation } from '../data/stations.js';

const PER_STATION    = 40;
const ENRICH_TTL_MS  = 25 * 60 * 1000;     // 25 min — under Deezer's ~35 min preview-URL expiry
const LS_PREFIX      = 'rf_enrich_v1:';
const DEEZER_SEARCH  = 'https://api.deezer.com/search';

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

function fresh(entry) {
  return entry && entry.ts && (Date.now() - entry.ts < ENRICH_TTL_MS);
}

async function deezerLookup(artist, title) {
  // Strict search first (artist:"…" track:"…"); fall back to free-text on miss.
  const tries = [
    `artist:"${artist}" track:"${title}"`,
    `${artist} ${title}`,
  ];
  for (const q of tries) {
    try {
      const url = `${DEEZER_SEARCH}?q=${encodeURIComponent(q)}&limit=1&output=json`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const t = data?.data?.[0];
      if (!t) continue;
      const cover = t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || null;
      if (!t.preview || !cover) continue;
      return {
        coverArt:   cover,
        previewUrl: t.preview,
        album:      t.album?.title || '',
        duration:   t.duration || null,
        deezerLink: t.link || null,
      };
    } catch {/* try next */}
  }
  return null;
}

/**
 * Resolve cover + preview for a track. Returns the original track object
 * with `coverArt`, `previewUrl`, `album`, `duration`, `deezerLink` filled
 * in (or kept null on failure).
 *
 * Concurrent calls for the same track dedupe to a single network request.
 */
export async function enrichTrack(track) {
  if (!track || (track.coverArt && track.previewUrl)) return track;
  const key = trackKey(track.artist, track.title);

  // Memory cache (fastest)
  const mem = memCache.get(key);
  if (fresh(mem)) return { ...track, ...mem.data };

  // localStorage cache
  const ls = readLs(key);
  if (fresh(ls)) {
    memCache.set(key, ls);
    return { ...track, ...ls.data };
  }

  // Dedupe in-flight requests
  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return data ? { ...track, ...data } : track;
  }

  const promise = deezerLookup(track.artist, track.title).then(data => {
    inflight.delete(key);
    if (data) {
      const entry = { ts: Date.now(), data };
      memCache.set(key, entry);
      writeLs(key, entry);
    } else {
      // Negative cache for 6h so we don't pound Deezer for misses
      const entry = { ts: Date.now() - (ENRICH_TTL_MS - 6 * 3600 * 1000), data: null };
      memCache.set(key, entry);
    }
    return data;
  });
  inflight.set(key, promise);
  const data = await promise;
  return data ? { ...track, ...data } : track;
}

/**
 * Build the feed.
 *
 * For each selected station, take up to PER_STATION (40) random tracks.
 * Round-robin across stations, then final-shuffle. Tracks come back
 * un-enriched — covers and previews are fetched on demand by the feed.
 */
export async function buildMosaic() {
  let selected = [];
  try {
    selected = JSON.parse(localStorage.getItem('radioflow_stations') || '[]');
  } catch {}
  if (!selected.length) return [];

  const all = await loadPlaylists();

  const queues = selected
    .map(id => {
      const station = findStation(id);
      const tracks = (all.stations?.[id] || []).map(t => ({
        id:          trackId(id, t.artist, t.title),
        artist:      t.artist,
        title:       t.title,
        album:       '',
        coverArt:    null,
        previewUrl:  null,
        duration:    null,
        deezerLink:  null,
        spotifyLink: `https://open.spotify.com/search/${encodeURIComponent(`${t.artist} ${t.title}`)}`,
        stationId:   id,
        station:     station?.name || 'Radio',
      }));
      return { id, queue: shuffle(tracks).slice(0, PER_STATION) };
    })
    .filter(s => s.queue.length > 0);

  if (!queues.length) return [];

  const picked = [];
  while (queues.some(s => s.queue.length)) {
    for (const s of queues) {
      if (s.queue.length) picked.push(s.queue.shift());
    }
  }

  return shuffle(picked);
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
