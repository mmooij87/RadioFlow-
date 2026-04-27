/**
 * Daily playlist refresh.
 *
 * For each station:
 *   1. Scrape onlineradiobox.com — pages /playlist/1, /2, /3 — gathering
 *      up to ~150 candidate plays.
 *   2. Look each candidate up on iTunes Search (stable URLs, no expiry).
 *   3. Drop tracks that iTunes can't fully match (no preview or no art).
 *   4. Keep up to 40 fully-functional tracks per station.
 *   5. Always attach a Spotify search URL.
 *
 * Output: public/data/playlists.json — read directly by the SPA at runtime.
 *
 * Designed to run from a GitHub Action once a day. No backend at runtime.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const TARGET_PER_STATION = 40;
const SCRAPE_PAGES       = [1, 2, 3];   // /playlist/1, /2, /3
const SCRAPE_LIMIT       = 200;         // hard cap on candidates per station
const ITUNES_DELAY_MS    = 220;         // ~5 req/s, polite to iTunes
const PAGE_DELAY_MS      = 400;         // between pages of the same station

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
 */
async function lookupITunes(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const url = `https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const t = data?.results?.[0];
    if (!t || !t.previewUrl) return null;
    const art = t.artworkUrl100
      ? t.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg')
      : null;
    if (!art) return null;
    return {
      artist:       t.artistName    || artist,
      title:        t.trackName     || title,
      album:        t.collectionName || '',
      coverArt:     art,
      previewUrl:   t.previewUrl,
      duration:     t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
      trackViewUrl: t.trackViewUrl || null,
    };
  } catch {
    return null;
  }
}

async function enrich(stationId, artist, title) {
  const lookup = await lookupITunes(artist, title);
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

async function refreshStation(stationId, baseUrl) {
  const candidates = await scrapeStation(stationId, baseUrl);
  console.log(`[${stationId}] ${candidates.length} candidates total → enriching…`);

  const enriched = [];
  let dropped = 0;
  for (const c of candidates) {
    if (enriched.length >= TARGET_PER_STATION) break;
    const e = await enrich(stationId, c.artist, c.title);
    if (e) enriched.push(e);
    else dropped++;
    await sleep(ITUNES_DELAY_MS);
  }
  console.log(`[${stationId}] ${enriched.length} kept, ${dropped} dropped (no iTunes match)`);
  return enriched;
}

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    stations: {},
  };

  for (const [id, baseUrl] of Object.entries(ORB_BASES)) {
    console.log(`\n=== ${id} ===`);
    out.stations[id] = await refreshStation(id, baseUrl);
  }

  console.log('\n=== Summary ===');
  for (const [id, arr] of Object.entries(out.stations)) {
    console.log(`  ${id.padEnd(15)} ${String(arr.length).padStart(3)} tracks`);
  }

  const target = path.resolve('public/data/playlists.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${target}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
