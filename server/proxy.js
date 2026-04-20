import express from 'express';
import cors from 'cors';
import { parse } from 'node-html-parser';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// ─────────────────────────────────────────────────────────────
// Tiered in-memory cache.
//   playlist: 60s  (a station's recent plays rarely change faster)
//   search:   30m  (track → cover/preview lookups are stable)
// Matches the v2 architecture's "edge cache" model.
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

// ─── Station registry ────────────────────────────────────────
// id → OnlineRadioBox playlist URL. Add a station by appending a row.
// The ids must match src/data/stations.js.
const STATION_URLS = {
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

// ─── GET /api/playlist ───────────────────────────────────────
app.get('/api/playlist', async (req, res) => {
  try {
    const stationId = req.query.station || 'kink';
    const target = STATION_URLS[stationId] || STATION_URLS.kink;
    const cacheKey = `playlist_${stationId}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const response = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await response.text();
    const root = parse(html);

    const trackLinks = root.querySelectorAll('a[href*="/track/"]');
    const tracks = [];
    const seen = new Set();
    for (const link of trackLinks) {
      const text = link.textContent.trim();
      const parts = text.split(' - ');
      if (parts.length >= 2) {
        const artist = parts[0].trim();
        const title = parts.slice(1).join(' - ').trim();
        const key = `${artist}:::${title}`.toLowerCase();
        if (!seen.has(key) && artist && title) {
          seen.add(key);
          tracks.push({ artist, title });
        }
      }
    }

    if (tracks.length > 0) setCache(cacheKey, tracks, 60 * 1000);
    res.json(tracks);
  } catch (err) {
    console.error('Playlist fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
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
    const response = await fetch(`https://api.deezer.com/search?q=${q}&limit=1`);
    const data = await response.json();

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
// List of station ids the backend knows about. Handy for the client to
// verify a station is scrapeable.
app.get('/api/stations', (_req, res) => {
  res.json(Object.keys(STATION_URLS));
});

app.listen(PORT, () => {
  console.log(`RadioFlow v2 proxy running at http://localhost:${PORT}`);
});
