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
const LS_PREFIX      = 'rf_enrich_v2:';
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

function fresh(entry, ttl) {
  return entry && entry.ts && (Date.now() - entry.ts < ttl);
}

async function itunesLookup(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const url = `${ITUNES_SEARCH}?term=${q}&media=music&entity=song&limit=1`;
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
  const t = data?.results?.[0];
  if (!t || !t.previewUrl) return null;
  const art = t.artworkUrl100
    ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg')
    : null;
  if (!art) return null;
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
        appleLink:   null,
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
