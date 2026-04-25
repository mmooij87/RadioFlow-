/**
 * Data Service — reads pre-built playlists.json (refreshed daily by GH Action).
 *
 * No live network calls per Generate: feed is sourced from a single static
 * JSON the workflow already enriched with cover + preview + Spotify link.
 * Tracks missing any of those were filtered out at build time so anything
 * the UI sees is guaranteed playable + viewable + handoff-able.
 */
import { findStation } from '../data/stations.js';

const FEED_MAX = 60;

let cachePromise = null;

function loadPlaylists() {
  if (!cachePromise) {
    // Resolve relative to the page (works under Vercel's `/` base and
    // GitHub Pages' `/RadioFlow-/` base alike since vite uses `base: './'`).
    cachePromise = fetch(new URL('./data/playlists.json', document.baseURI))
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
 * Build the feed: pull random tracks from each selected station, evenly
 * distributed, up to FEED_MAX (60) total.
 */
export async function buildMosaic(maxTracks = FEED_MAX) {
  const cap = Math.min(maxTracks || FEED_MAX, FEED_MAX);

  let selected = [];
  try {
    selected = JSON.parse(localStorage.getItem('radioflow_stations') || '[]');
  } catch {}
  if (!selected.length) selected = ['kink'];

  const all = await loadPlaylists();

  // For each selected station: shuffle its tracks (so each Generate differs)
  // and tag with station meta so the feed UI can show country / freq / name.
  const queues = selected
    .map(id => {
      const tracks = all.stations?.[id] || [];
      const station = findStation(id);
      const tagged = tracks.map(t => ({
        ...t,
        stationId: id,
        station: station?.name || 'Radio',
      }));
      return { id, queue: shuffle(tagged) };
    })
    .filter(s => s.queue.length > 0);

  if (!queues.length) return [];

  // Round-robin pull across stations until we hit the cap.
  const picked = [];
  while (picked.length < cap) {
    let progressed = false;
    for (const s of queues) {
      if (s.queue.length === 0) continue;
      picked.push(s.queue.shift());
      progressed = true;
      if (picked.length >= cap) break;
    }
    if (!progressed) break;
  }

  // Final shuffle so the feed order isn't strict A-B-A-B-A-B station alternation.
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
