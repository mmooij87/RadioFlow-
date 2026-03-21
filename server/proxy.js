import express from 'express';
import cors from 'cors';
import { parse } from 'node-html-parser';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// In-memory cache
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// ─── GET /api/playlist ────────────────────────────────────────────
// Scrapes playlist from OnlineRadioBox
app.get('/api/playlist', async (req, res) => {
  try {
    const stationId = req.query.station || 'main';
    const stationUrls = {
      'main': 'https://onlineradiobox.com/nl/kink/playlist/',
      'pinguin': 'https://onlineradiobox.com/nl/pinguinr/playlist/',
      'bbc6': 'https://onlineradiobox.com/uk/bbcradio6/playlist/',
      'fluxfm': 'https://onlineradiobox.com/de/fluxfm1006/playlist/',
      'npo3fm': 'https://onlineradiobox.com/nl/npo3fm/playlist/',
      'nporadio2': 'https://onlineradiobox.com/nl/radio2/playlist/',
    };
    
    const targetUrl = stationUrls[stationId] || stationUrls['main'];
    const cacheKey = `playlist_${stationId}`;

    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const html = await response.text();
    const root = parse(html);

    // Playlist tracks are in anchor links with format "Artist - Title"
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

    if (tracks.length > 0) {
      setCache(cacheKey, tracks);
    }

    res.json(tracks);
  } catch (err) {
    console.error('Playlist fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

// ─── GET /api/search?artist=X&title=Y ────────────────────────────
// Proxies to Deezer API for cover art + preview
app.get('/api/search', async (req, res) => {
  try {
    const { artist, title } = req.query;
    if (!artist || !title) {
      return res.status(400).json({ error: 'artist and title required' });
    }

    const cacheKey = `search:${artist}:${title}`.toLowerCase();
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const query = encodeURIComponent(`artist:"${artist}" track:"${title}"`);
    const response = await fetch(`https://api.deezer.com/search?q=${query}&limit=1`);
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
      setCache(cacheKey, result);
      res.json(result);
    } else {
      res.json({
        coverArt: null,
        previewUrl: null,
        album: null,
        artistName: artist,
        trackTitle: title,
        duration: null,
        deezerLink: null,
      });
    }
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🎸 RadioFlow proxy running at http://localhost:${PORT}`);
});
