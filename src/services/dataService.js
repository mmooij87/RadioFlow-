/**
 * Data Service — playlist fetching + cover art/preview enrichment.
 * Each track keeps its source stationId so the feed UI shows real station meta.
 */
import { findStation } from '../data/stations.js';

const iTunesCache = new Map();

// Same-origin everywhere: dev → Vite proxy, prod → Vercel rewrite.
const API_BASE = '';

/**
 * Fetch one station's recent playlist. Returns rows tagged with { stationId, station }.
 * Returns [] if the station's source is unavailable — never contaminates with foreign tracks.
 */
export async function fetchPlaylist(stationId) {
  const st = findStation(stationId);
  const stationName = st?.name || 'Radio';
  try {
    const res = await fetch(`${API_BASE}/api/playlist?station=${encodeURIComponent(stationId)}`);
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map(r => ({ ...r, stationId, station: stationName }));
  } catch (e) {
    console.warn(`[${stationId}] fetchPlaylist failed:`, e.message);
    return [];
  }
}

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
    id: `${track.stationId}:${track.artist}:${track.title}`.toLowerCase().replace(/[^a-z0-9:]/g, ''),
    artist: deezer.artistName || track.artist,
    title:  deezer.trackTitle  || track.title,
    album:  deezer.album       || '',
    coverArt:   itunesArt || deezer.coverArt || deezer.coverArtXL || null,
    previewUrl: deezer.previewUrl || null,
    duration:   deezer.duration   || null,
    deezerLink: deezer.deezerLink || null,
    stationId:  track.stationId,
    station:    track.station,
  };
}

/**
 * Round-robin merge: pull one track from each station's queue in turn so
 * the final feed is a balanced mix instead of being dominated by whichever
 * station happens to have the longest playlist.
 */
function roundRobin(perStation, max) {
  const queues = perStation.filter(q => q.length > 0).map(q => [...q]);
  const out = [];
  while (out.length < max && queues.some(q => q.length)) {
    for (const q of queues) {
      if (q.length && out.length < max) out.push(q.shift());
    }
  }
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build a mixed, enriched feed from the user's selected stations.
 * - Fetches each station in parallel
 * - Round-robins across stations so each one is represented
 * - Lightly randomizes the start position so successive Generates differ
 * - Dedups by artist+title (cross-station) before enrichment
 */
export async function buildMosaic(maxTracks = 20) {
  let stations = ['kink'];
  try {
    const saved = JSON.parse(localStorage.getItem('radioflow_stations') || '[]');
    if (saved.length) stations = saved;
  } catch {}

  const playlists = await Promise.all(stations.map(id => fetchPlaylist(id)));

  // Random offset per station so consecutive generations don't feel identical.
  const offsetPerStation = playlists.map(p => {
    if (p.length <= 3) return p;
    const start = Math.floor(Math.random() * Math.min(p.length, 10));
    return [...p.slice(start), ...p.slice(0, start)];
  });

  const mixed = roundRobin(offsetPerStation, maxTracks * 2);

  // Cross-station dedup (same song on two stations → keep first occurrence)
  const seen = new Set();
  const deduped = [];
  for (const t of mixed) {
    const key = `${t.artist}:::${t.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  // Light shuffle within the deduped set so the feed isn't always
  // station-A-station-B-station-A-station-B order.
  const final = shuffle(deduped).slice(0, maxTracks);

  const enriched = [];
  for (let i = 0; i < final.length; i += 5) {
    const batch = final.slice(i, i + 5);
    const results = await Promise.all(batch.map(enrichTrack));
    enriched.push(...results);
  }
  return enriched;
}
