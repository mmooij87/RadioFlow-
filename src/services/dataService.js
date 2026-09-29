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
import { fetchOrbPlaylist, workerLookup, apiReady } from './orbApi.js';

const PER_STATION    = 40;
const ENRICH_TTL_MS  = 24 * 60 * 60 * 1000;   // iTunes URLs are stable; cache for 24h
const NEG_TTL_MS     = 6  * 60 * 60 * 1000;   // re-try unknown tracks after 6h
const LS_PREFIX      = 'rf_enrich_v4:';   // bumped: v3 held false 'not found' entries from rate limits
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

// Apple allows roughly 20 searches a minute per visitor. Stay under it and
// hand the rest to the Worker instead of getting refused.
const ITUNES_BUDGET = 18;
const itunesCalls = [];
function itunesHasBudget() {
  const now = Date.now();
  while (itunesCalls.length && now - itunesCalls[0] > 60000) itunesCalls.shift();
  return itunesCalls.length < ITUNES_BUDGET;
}

/** → { status: 'ok', data } | { status: 'miss' } | { status: 'fail' } */
async function itunesLookup(artist, title) {
  itunesCalls.push(Date.now());
  const q = encodeURIComponent(`${artist} ${title}`);
  const url = `${ITUNES_SEARCH}?term=${q}&media=music&entity=song&limit=8`;
  let res;
  try {
    res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    return { status: 'fail' };        // network error or blocked: not a verdict on the song
  }
  if (!res.ok) {
    // 403/429 = Apple says "slow down": sit out the rest of the minute.
    if (res.status === 403 || res.status === 429) while (itunesCalls.length < ITUNES_BUDGET) itunesCalls.push(Date.now());
    return { status: 'fail' };
  }
  let data;
  try { data = await res.json(); } catch { return { status: 'fail' }; }

  // Pick the best-matching result instead of blindly taking #1, which is
  // often a cover version, karaoke track or a different artist.
  const candidates = (data?.results || [])
    .filter(r => r.previewUrl)
    .map(r => ({ r, s: scoreResult(r, artist, title) }))
    .sort((x, y) => y.s - x.s);
  const best = candidates[0];
  if (!best || best.s < 3) return { status: 'miss' };   // no convincing match → no wrong song
  const t = best.r;

  const art = t.artworkUrl100
    ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg')
    : null;
  return { status: 'ok', data: {
    coverArt:   art,
    previewUrl: t.previewUrl,
    album:      t.collectionName || '',
    duration:   t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
    deezerLink: null,
    appleLink:  t.trackViewUrl || null,
  } };
}

/**
 * Find a preview: iTunes first while we're within Apple's limit, then the
 * Worker (Deezer, then iTunes from Cloudflare's side). Only a real "no
 * match" is remembered; a refused or failed request is simply retried later.
 */
async function lookupPreview(artist, title) {
  let first = { status: 'fail' };
  if (itunesHasBudget()) first = await itunesLookup(artist, title);
  if (first.status === 'ok') return { ...first, keep: true };
  if (apiReady()) {
    const w = await workerLookup(artist, title);
    if (w.status === 'ok') return { ...w, keep: w.data.source !== 'deezer' };   // Deezer links expire
    if (w.status === 'miss') return { status: 'miss' };
  }
  return first;
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
    const ttl = mem.data?.source === 'deezer' ? 30 * 60 * 1000 : ENRICH_TTL_MS;   // Deezer links expire
    if (mem.data && fresh(mem, ttl)) return { ...track, ...mem.data };
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

  const promise = lookupPreview(track.artist, track.title).then(r => {
    inflight.delete(key);
    if (r.status === 'fail') return null;                 // don't remember: try again next time
    const entry = { ts: Date.now(), data: r.status === 'ok' ? r.data : null };
    memCache.set(key, entry);
    if (r.status === 'miss' || r.keep) writeLs(key, entry);
    return entry.data;
  }).catch(() => { inflight.delete(key); return null; });
  inflight.set(key, promise);
  const data = await promise;
  return data ? { ...track, ...data } : track;
}

const counts = {};

/**
 * Songs for one station. Built-in stations read the nightly JSON and fall
 * back to the live Worker when tonight's scrape came up empty; added
 * stations always come live from the Worker.
 */
export async function getStationTracks(station) {
  let list = [];
  if (station.source !== 'orb') {
    const all = await loadPlaylists();
    list = all.stations?.[station.id] || [];
  }
  if (!list.length && station.orb) list = await fetchOrbPlaylist(station.orb);
  counts[station.id] = list.length;
  return list;
}

/** Track counts seen so far this session, by station id. */
export const knownCounts = () => ({ ...counts });

/**
 * Build a mix from station objects.
 *
 * For each station, take up to PER_STATION random tracks (skipping ids in
 * `exclude`, e.g. songs already heard), round-robin across stations, then
 * final-shuffle. Tracks come back un-enriched: covers and previews are
 * fetched on demand by the feed.
 */
function toTrack(st, t) {
  return {
    id:          trackId(st.id, t.artist, t.title),
    artist:      t.artist,
    title:       t.title,
    album:       '',
    coverArt:    null,
    previewUrl:  null,
    duration:    null,
    deezerLink:  null,
    appleLink:   null,
    stationId:   st.id,
    station:     st.name || 'Radio',
  };
}

/** A station's songs in playlist order (most recently played first). */
export async function stationSongs(station) {
  const list = await getStationTracks(station).catch(() => []);
  const seen = new Set();
  return list.map(t => toTrack(station, t)).filter(t => !seen.has(t.id) && seen.add(t.id));
}

export async function buildMix(stations, exclude = new Set()) {
  if (!stations?.length) return [];
  const lists = await Promise.all(stations.map(st => getStationTracks(st).catch(() => [])));

  const queues = stations
    .map((st, k) => {
      const tracks = lists[k]
        .map(t => toTrack(st, t))
        .filter(t => !exclude.has(t.id));
      return { queue: shuffle(tracks).slice(0, PER_STATION) };
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
