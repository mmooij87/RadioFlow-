/**
 * Daily ORB scrape.
 *
 * For each station:
 *   1. Scrape onlineradiobox.com pages /playlist/1, /2, /3.
 *   2. Dedupe across pages.
 *   3. Keep up to 80 candidate {artist, title} pairs per station.
 *
 * Output: public/data/playlists.json — read by the SPA at runtime.
 *
 * Audio previews + cover art are resolved client-side via the iTunes
 * Search API, so this script never talks to iTunes / Deezer at build time.
 * That keeps us clear of the shared-IP rate limit on GitHub Actions.
 *
 * Safety nets:
 *   - Jingles / promos / station IDs are filtered out.
 *   - Stations whose ORB page is thin get a station-specific fallback
 *     source (currently KCRW's own tracklist API).
 *   - If a station still comes back (nearly) empty, yesterday's list is
 *     kept instead of wiping the station from the app.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const PER_STATION   = 80;
const PAGES         = [1, 2, 3];
const PAGE_DELAY_MS = 400;
const STATION_DELAY_MS = 1500;
const MIN_USEFUL    = 15;   // below this, try a fallback / keep previous data

const ORB_BASES = {
  kink:          'https://onlineradiobox.com/nl/kink',
  nporadio2:     'https://onlineradiobox.com/nl/radio2',
  pinguin:       'https://onlineradiobox.com/nl/pinguinr',
  bbc6:          'https://onlineradiobox.com/uk/bbcradio6',
  fluxfm:        'https://onlineradiobox.com/de/fluxfm1006',   // was /nl/flux (a Dutch oldies station)
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

// Jingles, promos, station IDs, ad breaks and other non-songs.
const JUNK_RE = /\b(promo|jingle|advert\w*|reclame|pinguinklap|station ?id|sweeper|commercial|\[break\])\b/i;
function isJunk(artist, title) {
  if (!/^[\p{L}\p{N}]/u.test(artist)) return true;          // "* 6am", "@", …
  if (JUNK_RE.test(artist) || JUNK_RE.test(title)) return true;
  if (/^(pinguin|kink|kexp|kcrw|willy|bbc|npo)\b/i.test(artist) && !/\s/.test(artist)) return true;
  return false;
}

const SCOPES = [
  'table.tablelist-schedule a[href*="/track/"]',
  'table.tablelist a[href*="/track/"]',
  '.station__playlist a[href*="/track/"]',
  '#playlist a[href*="/track/"]',
  'main a[href*="/track/"]',
  'a[href*="/track/"]',
];

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
    return { ok: false, status: 0, tracks: [], err: e.message };
  }
  if (!res.ok) return { ok: false, status: res.status, tracks: [] };
  const html = await res.text();
  const root = parse(html);

  let links = [];
  let usedScope = null;
  for (const sel of SCOPES) {
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
    if (isJunk(artist, title)) continue;
    const key = `${artist}:::${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ artist, title });
  }
  return { ok: true, status: res.status, tracks, scope: usedScope, htmlLen: html.length };
}

async function scrapeStation(id, baseUrl) {
  const all = [];
  const seen = new Set();
  let lastReport = null;
  for (const page of PAGES) {
    if (all.length >= PER_STATION) break;
    const url = `${baseUrl}/playlist/${page}`;
    const r = await scrapePage(id, url);
    lastReport = r;
    if (!r.ok) {
      console.warn(`[${id}] page ${page}: HTTP ${r.status}${r.err ? ' (' + r.err + ')' : ''}`);
      continue;
    }
    let added = 0;
    for (const t of r.tracks) {
      const k = `${t.artist}:::${t.title}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(t);
      added++;
      if (all.length >= PER_STATION) break;
    }
    console.log(`[${id}] page ${page}: html ${(r.htmlLen/1024).toFixed(0)}kB, ${r.tracks.length} parsed, +${added} new (scope=${r.scope || 'none'})`);
    await sleep(PAGE_DELAY_MS);
  }
  if (!all.length) {
    console.warn(`[${id}] WARNING: zero candidates. Last status=${lastReport?.status}`);
  }
  return all;
}

// ─── Station-specific fallbacks ─────────────────────────────
// KCRW's ORB page rarely carries a playlist, but KCRW publishes its own.
async function kcrwFallback() {
  const tracks = [];
  const seen = new Set();
  for (let back = 0; back < 2 && tracks.length < PER_STATION; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
    for (const channel of ['Simulcast', 'Music']) {
      const url = `https://tracklist-api.kcrw.com/${channel}/date/${ymd}?page_size=200`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
        if (!res.ok) { console.warn(`[kcrw] ${channel} ${ymd}: HTTP ${res.status}`); continue; }
        const data = await res.json();
        const rows = Array.isArray(data) ? data : (data?.items || data?.results || []);
        for (const r of rows) {
          const artist = clean(r.artist);
          const title  = clean(r.title);
          if (!artist || !title || isJunk(artist, title)) continue;
          const k = `${artist}:::${title}`.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          tracks.push({ artist, title });
          if (tracks.length >= PER_STATION) break;
        }
        console.log(`[kcrw] fallback ${channel} ${ymd}: ${rows.length} rows, total ${tracks.length}`);
      } catch (e) {
        console.warn(`[kcrw] fallback ${channel} ${ymd} failed: ${e.message}`);
      }
      if (tracks.length >= PER_STATION) break;
    }
  }
  return tracks;
}

const FALLBACKS = { kcrw: kcrwFallback };

async function readPrevious(target) {
  try {
    return JSON.parse(await fs.readFile(target, 'utf8'));
  } catch {
    return { stations: {} };
  }
}

async function main() {
  const target = path.resolve('public/data/playlists.json');
  const previous = await readPrevious(target);
  const out = { generatedAt: new Date().toISOString(), stations: {} };

  for (const [id, base] of Object.entries(ORB_BASES)) {
    console.log(`\n=== ${id} ===`);
    let tracks = await scrapeStation(id, base);

    if (tracks.length < MIN_USEFUL && FALLBACKS[id]) {
      console.log(`[${id}] only ${tracks.length} from ORB, trying fallback`);
      const fb = await FALLBACKS[id]();
      if (fb.length > tracks.length) tracks = fb;
    }

    // Keep yesterday's list rather than shipping an empty station.
    const prev = (previous.stations?.[id] || []).filter(t => !isJunk(t.artist, t.title));
    if (tracks.length < MIN_USEFUL && prev.length > tracks.length) {
      console.warn(`[${id}] only ${tracks.length} fresh tracks, keeping previous ${prev.length}`);
      tracks = prev;
    }

    out.stations[id] = tracks;
    console.log(`[${id}] kept ${out.stations[id].length}`);
    await sleep(STATION_DELAY_MS);
  }

  console.log('\n=== Summary ===');
  for (const [id, arr] of Object.entries(out.stations)) {
    console.log(`  ${id.padEnd(15)} ${String(arr.length).padStart(3)} tracks`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${target}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
