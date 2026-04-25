/**
 * Data Service — playlist fetching + cover art/preview enrichment.
 * Keeps the station id on each track so the feed can render per-station meta.
 */
import { demoPlaylist } from '../data/demoPlaylist.js';
import { STATIONS, findStation } from '../data/stations.js';

const iTunesCache = new Map();

// Same-origin everywhere: dev → Vite proxy, prod → Vercel rewrite.
const API_BASE = '';

/**
 * Fetch one station's recent playlist. Returns rows tagged with { stationId, station }.
 */
export async function fetchPlaylist(stationId = 'kink') {
  const st = findStation(stationId);
  const stationName = st?.name || 'Radio';
  try {
    const res = await fetch(`${API_BASE}/api/playlist?station=${encodeURIComponent(stationId)}`);
    if (!res.ok) throw new Error('Proxy unavailable');
    const rows = await res.json();
    if (rows.length > 0) {
      return rows.map(r => ({ ...r, stationId, station: stationName }));
    }
  } catch (e) {
    console.warn(`Proxy unavailable for ${stationId}, falling back to demo:`, e.message);
  }
  return [...demoPlaylist].map(r => ({ ...r, stationId, station: stationName }));
}

/**
 * iTunes search for high-res artwork.
 */
export async function getITunesCoverArt(artist, title) {
  const key = `${artist}:::${title}`.toLowerCase();
  if (iTunesCache.has(key)) return iTunesCache.get(key);
  try {
    const q = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=song&limit=1`);
    const data = await res.json();
    if (data.results?.length > 0) {
      const art = data.results[0].artworkUrl100?.replace('100x100', '600x600') || null;
      iTunesCache.set(key, art);
      return art;
    }
  } catch (e) {
    console.warn('iTunes search failed:', e.message);
  }
  iTunesCache.set(key, null);
  return null;
}

/**
 * Deezer (via backend) for cover art + 30s preview.
 */
export async function getDeezerData(artist, title) {
  try {
    const p = new URLSearchParams({ artist, title });
    const res = await fetch(`${API_BASE}/api/search?${p}`);
    if (!res.ok) throw new Error('Deezer proxy error');
    return await res.json();
  } catch (e) {
    console.warn('Deezer search failed:', e.message);
    return {
      coverArt: null, previewUrl: null, album: null,
      artistName: artist, trackTitle: title, duration: null,
    };
  }
}

export async function enrichTrack(track) {
  const [itunesArt, deezer] = await Promise.all([
    getITunesCoverArt(track.artist, track.title),
    getDeezerData(track.artist, track.title),
  ]);
  return {
    id: `${track.artist}:::${track.title}`.toLowerCase().replace(/[^a-z0-9:]/g, ''),
    artist: deezer.artistName || track.artist,
    title: deezer.trackTitle || track.title,
    album: deezer.album || '',
    coverArt: itunesArt || deezer.coverArt || deezer.coverArtXL || null,
    previewUrl: deezer.previewUrl || null,
    duration: deezer.duration || null,
    deezerLink: deezer.deezerLink || null,
    stationId: track.stationId,
    station: track.station,
  };
}

/**
 * Build a mixed, enriched feed from selected stations.
 * Parallelism + batched enrichment keeps p95 <= 10s (matches v2 target).
 */
export async function buildMosaic(maxTracks = 20) {
  let stations = ['kink'];
  try {
    const saved = JSON.parse(localStorage.getItem('radioflow_stations') || '[]');
    if (saved.length) stations = saved;
  } catch {}

  const playlists = await Promise.all(stations.map(id => fetchPlaylist(id)));
  const combined = playlists.flat();
  const shuffled = shuffle(combined).slice(0, maxTracks);

  const enriched = [];
  for (let i = 0; i < shuffled.length; i += 5) {
    const batch = shuffled.slice(i, i + 5);
    const results = await Promise.all(batch.map(enrichTrack));
    enriched.push(...results);
  }
  return enriched;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
