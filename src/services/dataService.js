/**
 * Data Service — reads pre-built playlists.json (refreshed daily by GH Action).
 *
 * No live network calls per Generate: feed is sourced from a single static
 * JSON the workflow already enriched with cover + preview + Spotify link.
 * Tracks missing any of those were filtered out at build time so anything
 * the UI sees is guaranteed playable + viewable + handoff-able.
 */
import { findStation } from '../data/stations.js';

const PER_STATION = 40;

let cachePromise = null;

function loadPlaylists() {
  if (!cachePromise) {
    // Cache-bust with a daily-rotating query param so installed PWAs and
    // mobile browsers don't keep serving yesterday's JSON (which may
    // contain audio URLs from a now-overwritten build). The workflow
    // refreshes once per day, so a YYYY-MM-DD stamp is the right cadence.
    // `cache: 'no-cache'` forces a conditional GET on top of that.
    const day = new Date().toISOString().slice(0, 10);
    const url = new URL(`./data/playlists.json?v=${day}`, document.baseURI);
    cachePromise = fetch(url, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`playlists.json HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.error('Failed to load playlists.json:', err);
        return { generatedAt: null, stations: {} };
      });
  }
  return cachePromise;
}

export function clearPlaylistCache() {
  cachePromise = null;
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
 * Build the feed.
 *
 * For each selected station, take up to PER_STATION (40) random tracks.
 * Round-robin across stations so they're evenly distributed in the result,
 * then final-shuffle so the feed isn't strict A-B-A-B-A-B alternation.
 *
 * Returns [] if no stations are selected. The feed grows linearly with
 * selection: 1 station → 40 tracks, 3 stations → 120, 12 stations → 480.
 */
export async function buildMosaic() {
  let selected = [];
  try {
    selected = JSON.parse(localStorage.getItem('radioflow_stations') || '[]');
  } catch {}
  if (!selected.length) return [];

  const all = await loadPlaylists();

  const queues = selected
    .map(id => {
      const tracks = all.stations?.[id] || [];
      const station = findStation(id);
      const tagged = tracks.map(t => ({
        ...t,
        stationId: id,
        station: station?.name || 'Radio',
      }));
      // Take up to PER_STATION at random.
      return { id, queue: shuffle(tagged).slice(0, PER_STATION) };
    })
    .filter(s => s.queue.length > 0);

  if (!queues.length) return [];

  // Round-robin pull across stations.
  const picked = [];
  while (queues.some(s => s.queue.length)) {
    for (const s of queues) {
      if (s.queue.length) picked.push(s.queue.shift());
    }
  }

  return shuffle(picked);
}

/**
 * Diagnostic: how many tracks are loaded per selected station.
 */
export async function feedDiagnostics() {
  const all = await loadPlaylists();
  return {
    generatedAt: all.generatedAt,
    counts: Object.fromEntries(
      Object.entries(all.stations || {}).map(([id, arr]) => [id, arr.length])
    ),
  };
}
