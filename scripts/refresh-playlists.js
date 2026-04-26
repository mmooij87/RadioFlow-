/**
 * Daily playlist refresh.
 *
 * For each station listed below:
 *   1. Scrape onlineradiobox.com for the most recent ~60 plays.
 *   2. Enrich each candidate via Deezer (cover + 30s preview).
 *   3. Drop tracks where cover or preview is missing.
 *   4. Keep up to 40 fully-functional tracks per station.
 *   5. Always attach a Spotify search URL (constructible from artist+title).
 *
 * Output: public/data/playlists.json — read directly by the SPA at runtime.
 *
 * Designed to run from a GitHub Action once a day. No backend required at runtime.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'node-html-parser';

const TARGET_PER_STATION = 40;
const SCRAPE_LIMIT       = 80;   // candidates pulled before enrichment
const ITUNES_DELAY_MS    = 220;  // be polite to iTunes Search (~5 req/s)

const ORB_URLS = {
  kink:          'https://onlineradiobox.com/nl/kink/playlist/1',
  nporadio2:     'https://onlineradiobox.com/nl/radio2/playlist/1',
  pinguin:       'https://onlineradiobox.com/nl/pinguinr/playlist/1',
  bbc6:          'https://onlineradiobox.com/uk/bbcradio6/playlist/1',
  fluxfm:        'https://onlineradiobox.com/nl/flux/playlist/1',
  triplej:       'https://onlineradiobox.com/au/abctriplej/playlist/1',
  radioswiss:    'https://onlineradiobox.com/ch/radioswissjazz/playlist/1',
  kexp:          'https://onlineradiobox.com/us/kexpfm/playlist/1',
  willy:         'https://onlineradiobox.com/be/willy/playlist/1',
  wxpn:          'https://onlineradiobox.com/us/wxpn/playlist/1',
  kcrw:          'https://onlineradiobox.com/us/kcrwhd2/playlist/1',
  radioparadise: 'https://onlineradiobox.com/us/radioparadise/playlist/1',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function scrape(stationId, url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const root = parse(await res.text());

  const scopes = [
    'table.tablelist-schedule a[href*="/track/"]',
    'table.tablelist a[href*="/track/"]',
    '.station__playlist a[href*="/track/"]',
    '#playlist a[href*="/track/"]',
  ];
  let links = [];
  for (const sel of scopes) {
    const found = root.querySelectorAll(sel);
    if (found.length) { links = found; break; }
  }
  if (!links.length) {
    links = root.querySelectorAll('main a[href*="/track/"]');
  }

  const out = [];
  const seen = new Set();
  for (const link of links) {
    if (out.length >= SCRAPE_LIMIT) break;
    const text = clean(link.textContent);
    const idx = text.indexOf(' - ');
    if (idx < 1) continue;
    const artist = clean(text.slice(0, idx));
    const title  = clean(text.slice(idx + 3));
    if (!artist || !title) continue;
    const key = `${artist}:::${title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ artist, title });
  }
  return out;
}

/**
 * Look up the track on iTunes Search API.
 * iTunes returns stable, non-expiring 30-second .m4a preview URLs and
 * 100x100 artwork that we upscale to 1000x1000bb. Both URLs are static,
 * which is exactly what we need for a once-a-day prebuild — Deezer's
 * preview URLs are signed (`hdnea=exp=...`) and expire ~35 min after
 * issue, so they're useless for a daily snapshot.
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
      artist:     t.artistName    || artist,
      title:      t.trackName     || title,
      album:      t.collectionName || '',
      coverArt:   art,
      previewUrl: t.previewUrl,
      duration:   t.trackTimeMillis ? Math.round(t.trackTimeMillis / 1000) : null,
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

async function refreshStation(stationId, url) {
  console.log(`[${stationId}] scraping…`);
  let candidates = [];
  try {
    candidates = await scrape(stationId, url);
  } catch (e) {
    console.warn(`[${stationId}] scrape failed: ${e.message}`);
    return [];
  }
  console.log(`[${stationId}] ${candidates.length} candidates → enriching…`);

  const enriched = [];
  for (const c of candidates) {
    if (enriched.length >= TARGET_PER_STATION) break;
    const e = await enrich(stationId, c.artist, c.title);
    if (e) enriched.push(e);
    await sleep(ITUNES_DELAY_MS);
  }
  console.log(`[${stationId}] ${enriched.length} kept`);
  return enriched;
}

async function main() {
  const out = {
    generatedAt: new Date().toISOString(),
    stations: {},
  };

  for (const [id, url] of Object.entries(ORB_URLS)) {
    out.stations[id] = await refreshStation(id, url);
  }

  const totals = Object.entries(out.stations)
    .map(([id, arr]) => `${id}=${arr.length}`)
    .join(' ');
  console.log(`Done. ${totals}`);

  const target = path.resolve('public/data/playlists.json');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(out, null, 2));
  console.log(`Wrote ${target}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
