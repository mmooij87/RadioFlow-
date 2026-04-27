/**
 * Daily playlist refresh.
 *
 * For each station:
 *   1. Scrape onlineradiobox.com — pages /playlist/1, /2, /3.
 *   2. For each candidate, consult the persistent track-cache; only call
 *      iTunes Search for cache misses (or expired entries).
 *   3. Drop tracks that iTunes never matched.
 *   4. Keep up to 40 fully-functional tracks per station.
 *
 * Outputs (both committed by the workflow):
 *   - public/data/playlists.json    — read by the SPA at runtime
 *   - data/track-cache.json         — iTunes lookup cache, persisted
 *
 * The cache is the key to staying under iTunes' ~20 req/min rate limit.
 * After the first build, subsequent daily runs only lookup the day's
 * new tracks (typically tens, not hundreds).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const TARGET_PER_STATION = 40;
const SCRAPE_PAGES       = [1, 2, 3];
const SCRAPE_LIMIT       = 200;
const ITUNES_DELAY_MS    = 1500;        // 40 req/min — safer for iTunes
const ITUNES_MAX_PER_STN = 80;          // hard cap on iTunes calls per station per run
const ITUNES_ABORT_STREAK = 5;          // consecutive non-OK → assume rate-limited
const PAGE_DELAY_MS      = 400;

// Cache TTL: re-validate "no match" entries weekly so misspellings or
// late-added tracks get a second chance, but successful matches never expire.
const CACHE_NEGATIVE_TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_PATH = 'data/track-cache.json';

// Each entry is the *base* URL — pages are appended as `/playlist/N`.
const ORB_BASES = {
  kink:          'https://onlineradiobox.com/nl/kink',
  nporadio2:     'https://onlineradiobox.com/nl/radio2',
  pinguin:       'https://onlineradiobox.com/nl/pinguinr',
  bbc6:          'https://onlineradiobox.com/uk/bbcradio6',
  fluxfm:        'https://onlineradiobox.com/nl/flux',
  triplej:       'https://onlineradiobox.com/au/abctriplej',
  radioswiss:    'https://onlineradiobox.com/ch/radioswissjazz',
  kexp:          'https://onlineradiobox.com/us/kexpfm',
  willy:         'https://onlineradiobox.com/be/willy',
  wxpn:          'https://onlineradiobox.com/us/wxpn',
  kcrw:          'https://onlineradiobox.com/us/kcrwhd2',
  radioparadise: 'https://onlineradiobox.com/us/radioparadise',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Pull tracks out of a single ORB page. Returns { ok, status, html, tracks }.
 */
async function scrapePage(stationId, url) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
  } catch (e) {
    return { ok: false, status: 0, htmlLen: 0, tracks: [], err: e.message };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, htmlLen: 0, tracks: [] };
  }
  const html = await res.text();
  const root = parse(html);

  // Try the most specific selector first; fall back to wider scopes.
  const scopes = [
    'table.tablelist-schedule a[href*="/track/"]',
    'table.tablelist a[href*="/track/"]',
    '.station__playlist a[href*="/track/"]',
    '#playlist a[href*="/track/"]',
    'main a[href*="/track/"]',
    'a[href*="/track/"]',  // last resort: every track link on the page
  ];
  let links = [];
  let usedScope = null;
  for (const sel of scopes) {
    const found = root.querySelectorAll(sel);
    if (found.length) { links = found; usedScope = sel; break; }
  }

  const tracks = [];
  const seen = new Set();
  for (const link of links) {
    const text = clean(link.textContent);
    const idx = text.indexOf(' - ');
    if (idx < 1) continue;
    const artist = clean(text.slice(0, idx));
    const title  = clean(text.slice(idx + 3));
    if (!artist || !title) continue;
    const key = `${artist}:::${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ artist, title });
  }
  return { ok: true, status: res.status, htmlLen: html.length, scope: usedScope, tracks };
}

/**
 * Scrape multiple pages for one station, deduping across pages.
 */
async function scrapeStation(stationId, baseUrl) {
  const all = [];
  const seen = new Set();
  let lastReport = null;
  for (const page of SCRAPE_PAGES) {
    if (all.length >= SCRAPE_LIMIT) break;
    const url = `${baseUrl}/playlist/${page}`;
    const r = await scrapePage(stationId, url);
    lastReport = r;
    if (!r.ok) {
      console.warn(`[${stationId}] page ${page}: HTTP ${r.status}${r.err ? ' (' + r.err + ')' : ''}`);
      continue;
    }
    let added = 0;
    for (const t of r.tracks) {
      const key = `${t.artist}:::${t.title}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(t);
      added++;
      if (all.length >= SCRAPE_LIMIT) break;
    }
    console.log(`[${stationId}] page ${page}: html ${(r.htmlLen/1024).toFixed(0)}kB, ${r.tracks.length} parsed, +${added} new (scope=${r.scope || 'none'})`);
    await sleep(PAGE_DELAY_MS);
  }
  if (!all.length) {
    console.warn(`[${stationId}] WARNING: zero candidates after all pages. Last status=${lastReport?.status}, scope=${lastReport?.scope}`);
  }
  return all;
}

/**
 * iTunes Search: stable preview + 1000x1000 art.
 *
 * Returns { ok, status, data } so the caller can distinguish "no match"
 * (200 with empty results) from "rate-limited" (4xx/5xx). The latter
 * triggers the abort-streak so we stop wasting calls on a closed door.
 */
async function lookupITunes(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`;
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  } catch (e) {
    return { ok: false, status: 0, err: e.message };
  }
  if (!res.ok) return { ok: false, status: res.status };

  let data;
  try { data = await res.json(); } catch { return { ok: false, status: res.status, err: 'json' }; }
  const t = data?.results?.[0];
  if (!t || !t.previewUrl) return { ok: true, status: 200, data: null };
  const art = t.artworkUrl100
    ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg')
    : null;
  if (!art) return { ok: true, status: 200, data: null };
  return {
    ok: true, status: 200,
    data: {
      artist:       t.artistName    || artist,
      title:        t.trackName     || title,
      album:        t.collectionName || '',
      coverArt:     art,
      previewUrl:   t.previewUrl,
      duration:     t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
      trackViewUrl: t.trackViewUrl || null,
    },
  };
}

function cacheKey(artist, title) {
  return `${artist}|||${title}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const data = JSON.parse(raw);
    const entries = Object.keys(data.entries || {}).length;
    console.log(`Loaded ${entries} cached lookups from ${CACHE_PATH}`);
    return data;
  } catch {
    console.log(`No existing cache at ${CACHE_PATH}; starting fresh`);
    return { updated: null, entries: {} };
  }
}

async function saveCache(cache) {
  cache.updated = new Date().toISOString();
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

/**
 * Look the candidate up — preferring the persistent cache. Returns
 *   { lookup, status, source }
 *   - lookup === iTunes data | null (no match) | undefined (cache miss handled by caller)
 *   - status === 200 always for cached entries; HTTP code for fresh calls
 *   - source === 'cache' | 'cache-neg' | 'fresh'
 */
async function getEnrichment(cache, artist, title) {
  const key = cacheKey(artist, title);
  const hit = cache.entries[key];
  if (hit) {
    if (hit.data) return { lookup: hit.data, status: 200, source: 'cache' };
    // Negative cache: skip unless old enough to retry.
    if (Date.now() - (hit.ts || 0) < CACHE_NEGATIVE_TTL_MS) {
      return { lookup: null, status: 200, source: 'cache-neg' };
    }
  }
  const r = await lookupITunes(artist, title);
  if (!r.ok) return { lookup: null, status: r.status, source: 'fresh' };
  cache.entries[key] = { ts: Date.now(), data: r.data || null };
  return { lookup: r.data, status: 200, source: 'fresh' };
}

function buildTrack(stationId, lookup) {
  if (!lookup) return null;
  const finalArtist = lookup.artist;
  const finalTitle  = lookup.title;
  const id = `${stationId}:${finalArtist}:${finalTitle}`
    .toLowerCase()
    .replace(/[^a-z0-9:]/g, '');
  return {
    id,
    artist:       finalArtist,
    title:        finalTitle,
    album:        lookup.album,
    coverArt:     lookup.coverArt,
    previewUrl:   lookup.previewUrl,
    duration:     lookup.duration,
    appleLink:    lookup.trackViewUrl,
    spotifyLink:  `https://open.spotify.com/search/${encodeURIComponent(`${finalArtist} ${finalTitle}`)}`,
    stationId,
  };
}

async function refreshStation(stationId, baseUrl, cache) {
  const candidates = await scrapeStation(stationId, baseUrl);
  console.log(`[${stationId}] ${candidates.length} candidates total → enriching…`);

  const enriched = [];
  let cached = 0, fresh = 0, freshDropped = 0, cachedNeg = 0;
  let consecutiveFailures = 0;
  const statusCounts = {};

  for (const c of candidates) {
    if (enriched.length >= TARGET_PER_STATION) break;
    if (fresh >= ITUNES_MAX_PER_STN) {
      console.log(`[${stationId}] hit ITUNES_MAX_PER_STN (${ITUNES_MAX_PER_STN}) fresh calls; stopping early`);
      break;
    }
    if (consecutiveFailures >= ITUNES_ABORT_STREAK) {
      console.warn(`[${stationId}] aborting: ${ITUNES_ABORT_STREAK} consecutive iTunes failures (likely rate-limited)`);
      break;
    }

    const { lookup, status, source } = await getEnrichment(cache, c.artist, c.title);
    statusCounts[`${source}/${status}`] = (statusCounts[`${source}/${status}`] || 0) + 1;

    const track = buildTrack(stationId, lookup);
    if (track) {
      enriched.push(track);
      consecutiveFailures = 0;
    } else {
      if (source === 'cache-neg') cachedNeg++;
      else if (source === 'cache') {/* shouldn't happen — null cache + null data */}
      else freshDropped++;
      if (source === 'fresh' && status !== 200) consecutiveFailures++;
      else consecutiveFailures = 0;
    }

    if (source === 'cache' || source === 'cache-neg') cached++;
    else { fresh++; await sleep(ITUNES_DELAY_MS); }
  }
  const breakdown = Object.entries(statusCounts).map(([s, n]) => `${s}:${n}`).join(' ');
  console.log(`[${stationId}] ${enriched.length} kept · ${cached} from cache · ${fresh} fresh (${freshDropped} dropped) · neg ${cachedNeg} · ${breakdown}`);
  return enriched;
}

async function main() {
  const cache = await loadCache();
  const out = {
    generatedAt: new Date().toISOString(),
    stations: {},
  };

  for (const [id, baseUrl] of Object.entries(ORB_BASES)) {
    console.log(`\n=== ${id} ===`);
    out.stations[id] = await refreshStation(id, baseUrl, cache);
    // Save cache after each station so a mid-run abort still preserves progress.
    await saveCache(cache);
    // Pause between stations so iTunes' per-IP rate window gets a chance to reset.
    await sleep(2000);
  }

  console.log('\n=== Summary ===');
  for (const [id, arr] of Object.entries(out.stations)) {
    console.log(`  ${id.padEnd(15)} ${String(arr.length).padStart(3)} tracks`);
  }

  const target = path.resolve('public/data/playlists.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${target}`);

  const cacheEntries = Object.keys(cache.entries).length;
  console.log(`Cache: ${cacheEntries} total entries (committed at ${CACHE_PATH})`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
