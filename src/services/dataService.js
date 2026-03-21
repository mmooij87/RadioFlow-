/**
 * Data Service — handles playlist fetching, cover art enrichment, and preview URLs
 */
import { demoPlaylist } from '../data/demoPlaylist.js';

const iTunesCache = new Map();

// Base URL for API calls. In dev, it's relative (handled by Vite proxy).
// In production, it points to the Render backend URL.
const API_BASE = import.meta.env.PROD 
  ? 'https://radioflow-c6zh.onrender.com' 
  : '';

/**
 * Fetch the playlist from the proxy server.
 * Falls back to demo data if unavailable.
 */
export async function fetchPlaylist(stationId = 'main') {
  try {
    const res = await fetch(`${API_BASE}/api/playlist?station=${stationId}`);
    if (!res.ok) throw new Error('Proxy unavailable');
    const tracks = await res.json();
    if (tracks.length > 0) {
      const names = {
        'main': 'Kink FM', 'pinguin': 'Pinguin Radio', 'bbc6': 'BBC Radio 6',
        'fluxfm': 'Flux FM', 'npo3fm': 'NPO 3FM', 'nporadio2': 'NPO Radio 2'
      };
      return tracks.map(t => ({ ...t, station: names[stationId] || 'Radio' }));
    }
  } catch (e) {
    console.warn('Proxy unavailable, using demo playlist:', e.message);
  }
  return [...demoPlaylist].map(t => ({ ...t, station: 'Kink FM' }));
}

/**
 * Search iTunes for cover art (client-side, no CORS issues).
 * Returns high-res artwork URL or null.
 */
export async function getITunesCoverArt(artist, title) {
  const key = `${artist}:::${title}`.toLowerCase();
  if (iTunesCache.has(key)) return iTunesCache.get(key);

  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${query}&media=music&entity=song&limit=1`);
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      // Replace 100x100 with 600x600 for high-res
      const artUrl = data.results[0].artworkUrl100?.replace('100x100', '600x600') || null;
      iTunesCache.set(key, artUrl);
      return artUrl;
    }
  } catch (e) {
    console.warn('iTunes search failed:', e.message);
  }

  iTunesCache.set(key, null);
  return null;
}

/**
 * Search Deezer (via proxy) for 30s preview URL and cover art.
 */
export async function getDeezerData(artist, title) {
  try {
    const params = new URLSearchParams({ artist, title });
    const res = await fetch(`${API_BASE}/api/search?${params}`);
    if (!res.ok) throw new Error('Deezer proxy error');
    return await res.json();
  } catch (e) {
    console.warn('Deezer search failed:', e.message);
    return {
      coverArt: null,
      previewUrl: null,
      album: null,
      artistName: artist,
      trackTitle: title,
      duration: null,
    };
  }
}

/**
 * Enrich a single track with cover art and preview URL.
 * Tries iTunes first (better art quality), falls back to Deezer.
 */
export async function enrichTrack(track) {
  // Run both in parallel
  const [itunesArt, deezerData] = await Promise.all([
    getITunesCoverArt(track.artist, track.title),
    getDeezerData(track.artist, track.title),
  ]);

  return {
    id: `${track.artist}:::${track.title}`.toLowerCase().replace(/[^a-z0-9:]/g, ''),
    artist: deezerData.artistName || track.artist,
    title: deezerData.trackTitle || track.title,
    album: deezerData.album || '',
    coverArt: itunesArt || deezerData.coverArt || deezerData.coverArtXL || null,
    previewUrl: deezerData.previewUrl || null,
    duration: deezerData.duration || null,
    deezerLink: deezerData.deezerLink || null,
    genre: guessGenre(track.artist),
    station: track.station,
  };
}

/**
 * Build a complete enriched mosaic from the playlist.
 * Processes tracks in batches to avoid hammering APIs.
 */
export async function buildMosaic(maxTracks = 50) {
  let stations = ['main'];
  try {
    const stored = localStorage.getItem('radioflow_stations');
    if (stored) stations = JSON.parse(stored);
  } catch (e) {}

  // Fetch all selected stations in parallel
  const playlists = await Promise.all(stations.map(id => fetchPlaylist(id)));
  
  // Combine all tracks and explicitly clear old cache if feed rebuilds
  const combined = playlists.flat();
  const shuffled = shuffleArray(combined).slice(0, maxTracks);

  // Process in batches of 5
  const enriched = [];
  for (let i = 0; i < shuffled.length; i += 5) {
    const batch = shuffled.slice(i, i + 5);
    const results = await Promise.all(batch.map(enrichTrack));
    enriched.push(...results);
  }

  return enriched;
}

/**
 * Rough genre guessing based on artist (for demo display).
 */
function guessGenre(artist) {
  const genres = {
    rock: ['nirvana', 'foo fighters', 'pearl jam', 'led zeppelin', 'queens of the stone age', 'royal blood', 'papa roach', 'van halen', 'thin lizzy', 'audioslave', 'linkin park', 'muse', 'stereophonics', 'volbeat', 'bruce springsteen'],
    alternative: ['arctic monkeys', 'the killers', 'radiohead', 'nothing but thieves', 'the strokes', 'editors', 'the cure', 'blur', 'oasis', 'coldplay', 'the cranberries', 'snow patrol', 'wet leg', 'the smashing pumpkins', 'kasabian', 'fontaines d.c.'],
    indie: ['florence the machine', 'vance joy', 'mumford and sons', 'imagine dragons', 'kings of leon', 'gorillaz', 'weezer', 'inhaler'],
    punk: ['ramones', 'green day', 'the jam'],
    grunge: ['alice in chains', 'garbage'],
    electronic: ['depeche mode', 'talking heads'],
    metal: ['within temptation', 'faith no more'],
    classic: ['david bowie', 'u2', 'red hot chili peppers', 'k\'s choice', 'anouk'],
  };

  const lower = artist.toLowerCase();
  for (const [genre, artists] of Object.entries(genres)) {
    if (artists.some(a => lower.includes(a))) return genre;
  }
  return 'rock';
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
