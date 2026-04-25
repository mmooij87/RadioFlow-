import express from 'express';
import cors from 'cors';
import { parse } from 'node-html-parser';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// ─────────────────────────────────────────────────────────────
// Tiered in-memory cache.
//   playlist: 45s  (each station's recent plays change at most 1x/min)
//   search:   30m  (track → cover/preview lookups are stable)
// ─────────────────────────────────────────────────────────────
const cache = new Map();

function getCached(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.time < e.ttl) return e.data;
  return null;
}
function setCache(key, data, ttlMs) {
  cache.set(key, { data, time: Date.now(), ttl: ttlMs });
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────
// Per-station fetchers. Each returns [{ artist, title }, ...] (newest first).
// Where a station has a real public API we use it; ORB scrape is fallback.
// ─────────────────────────────────────────────────────────────

async function kexp() {
  const data = await fetchJson('https://api.kexp.org/v2/plays/?limit=30');
  return (data.results || [])
    .filter(p => p.play_type === 'trackplay' && p.artist && p.song)
    .map(p => ({ artist: clean(p.artist), title: clean(p.song) }));
}

async function abc(station) {
  const url = `https://music.abcradio.net.au/api/v1/plays/search.json?station=${station}&limit=30`;
  const data = await fetchJson(url);
  return (data.items || [])
    .map(it => {
      const rec = it.recording || {};
      const artist = (rec.artists || []).map(a => a.name).filter(Boolean).join(', ');
      return { artist: clean(artist), title: clean(rec.title) };
    })
    .filter(t => t.artist && t.title);
}

async function bbc(service) {
  const url = `https://rms.api.bbc.co.uk/v2/services/${service}/segments/latest?limit=30`;
  const data = await fetchJson(url);
  return (data.data || [])
    .map(s => ({
      artist: clean(s.titles?.primary),
      title:  clean(s.titles?.secondary),
    }))
    .filter(t => t.artist && t.title);
}

async function radioFrance(station) {
  const url = `https://www.radiofrance.fr/api/v2.1/stations/${station}/live`;
  const data = await fetchJson(url);
  const out = [];
  const song = data?.now?.song;
  if (song?.title && song?.interpreters?.length) {
    out.push({ artist: clean(song.interpreters.join(', ')), title: clean(song.title) });
  }
  const prev = data?.now?.previousTracks || data?.previousTracks || [];
  for (const p of prev) {
    if (p.title && p.interpreters?.length) {
      out.push({ artist: clean(p.interpreters.join(', ')), title: clean(p.title) });
    }
  }
  return out;
}

async function npo(stationSlug) {
  const url = `https://radio.poms.omroep.nl/api/now/${stationSlug}`;
  const data = await fetchJson(url);
  return (data.data || data.tracks || [])
    .map(t => ({ artist: clean(t.artist), title: clean(t.title) }))
    .filter(t => t.artist && t.title);
}

async function kcrw(channel = 'Simulcast') {
  const url = `https://tracklist-api.kcrw.com/${channel}`;
  const data = await fetchJson(url);
  if (data?.title && data?.artist) return [{ artist: clean(data.artist), title: clean(data.title) }];
  return [];
}

async function radioSwissJazz() {
  const url = 'https://www.radioswissjazz.ch/songhistory/last24hours.json';
  const data = await fetchJson(url);
  const arr = Array.isArray(data) ? data : (data.songs || data.history || []);
  return arr
    .map(t => ({ artist: clean(t.artist?.name || t.artist), title: clean(t.title) }))
    .filter(t => t.artist && t.title);
}

// ─── OnlineRadioBox fallback (with tighter selector) ─────────
const ORB_URLS = {
  kink:       'https://onlineradiobox.com/nl/kink/playlist/',
  nporadio2:  'https://onlineradiobox.com/nl/radio2/playlist/',
  npo3fm:     'https://onlineradiobox.com/nl/npo3fm/playlist/',
  pinguin:    'https://onlineradiobox.com/nl/pinguinr/playlist/',
  bbc6:       'https://onlineradiobox.com/uk/bbcradio6/playlist/',
  nts1:       'https://onlineradiobox.com/uk/nts1/playlist/',
  fip:        'https://onlineradiobox.com/fr/fip/playlist/',
  rinsefr:    'https://onlineradiobox.com/fr/rinsefrance/playlist/',
  fluxfm:     'https://onlineradiobox.com/de/fluxfm1006/playlist/',
  byte:       'https://onlineradiobox.com/de/bytefm/playlist/',
  kexp:       'https://onlineradiobox.com/us/kexp/playlist/',
  kcrw:       'https://onlineradiobox.com/us/kcrw/playlist/',
  triplej:    'https://onlineradiobox.com/au/triplej/playlist/',
  radioswiss: 'https://onlineradiobox.com/ch/swissjazz/playlist/',
};

async function orb(stationId) {
  const target = ORB_URLS[stationId];
  if (!target) return [];
  const res = await fetch(target, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`ORB ${stationId} → ${res.status}`);
  const root = parse(await res.text());

  // Tight selector: only links *inside* the actual playlist table, not the
  // "popular tracks" sidebar that pollutes results across stations.
  const scopes = [
    'table.tablelist-schedule a[href*="/track/"]',
    'table.tablelist a[href*="/track/"]',
    '.station__playlist a[href*="/track/"]',
    '#playlist a[href*="/track/"]',
  ];
  let trackLinks = [];
  for (const sel of scopes) {
    const found = root.querySelectorAll(sel);
    if (found.length) { trackLinks = found; break; }
  }
  if (!trackLinks.length) {
    trackLinks = root.querySelectorAll('main a[href*="/track/"], .station-info a[href*="/track/"]');
  }

  const out = [];
  const seen = new Set();
  for (const link of trackLinks) {
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

// ─── Station registry: prefer real API, fall back to ORB ─────
const FETCHERS = {
  kexp:       () => kexp(),
  triplej:    () => abc('triplej'),
  bbc6:       () => bbc('bbc_6music'),
  fip:        () => radioFrance('fip'),
  nporadio2:  () => npo('radio2'),
  npo3fm:     () => npo('3fm'),
  kcrw:       () => kcrw('Simulcast'),
  radioswiss: () => radioSwissJazz(),
  // No reliable native API — use ORB scrape:
  kink:       () => orb('kink'),
  pinguin:    () => orb('pinguin'),
  nts1:       () => orb('nts1'),
  rinsefr:    () => orb('rinsefr'),
  fluxfm:     () => orb('fluxfm'),
  byte:       () => orb('byte'),
};

// ─── GET /api/playlist?station=ID ────────────────────────────
app.get('/api/playlist', async (req, res) => {
  const stationId = req.query.station || 'kink';
  const cacheKey = `playlist:${stationId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  const primary = FETCHERS[stationId];
  let tracks = [];
  let source = 'none';

  if (primary) {
    try {
      tracks = await primary();
      source = 'native';
    } catch (e) {
      console.warn(`[${stationId}] primary fetcher failed:`, e.message);
    }
  }

  // Native fetcher empty/failed → ORB fallback (for stations that have a real API)
  if (!tracks.length && ORB_URLS[stationId] && primary !== FETCHERS.kink) {
    try {
      tracks = await orb(stationId);
      source = 'orb';
    } catch (e) {
      console.warn(`[${stationId}] ORB fallback failed:`, e.message);
    }
  }

  if (tracks.length) setCache(cacheKey, tracks, 45 * 1000);
  console.log(`[${stationId}] ${tracks.length} tracks (${source})`);
  res.json(tracks);
});

// ─── GET /api/search?artist=X&title=Y ────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const { artist, title } = req.query;
    if (!artist || !title) return res.status(400).json({ error: 'artist and title required' });

    const cacheKey = `search:${artist}:${title}`.toLowerCase();
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const q = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const data = await fetchJson(`https://api.deezer.com/search?q=${q}&limit=1`);

    if (data.data && data.data.length > 0) {
      const track = data.data[0];
      const result = {
        coverArt: track.album?.cover_big || track.album?.cover_medium || track.album?.cover || null,
        coverArtXL: track.album?.cover_xl || track.album?.cover_big || null,
        previewUrl: track.preview || null,
        album: track.album?.title || null,
        artistName: track.artist?.name || artist,
        trackTitle: track.title || title,
        duration: track.duration || null,
        deezerLink: track.link || null,
      };
      setCache(cacheKey, result, 30 * 60 * 1000);
      res.json(result);
    } else {
      res.json({
        coverArt: null, previewUrl: null, album: null,
        artistName: artist, trackTitle: title, duration: null, deezerLink: null,
      });
    }
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── GET /api/stations ──────────────────────────────────────
app.get('/api/stations', (_req, res) => {
  res.json(Object.keys(FETCHERS));
});

app.listen(PORT, () => {
  console.log(`RadioFlow v2 proxy running at http://localhost:${PORT}`);
});
