/**
 * Data layer.
 *
 * Station song lists come from the nightly OnlineRadioBox scrape
 * (public/data/playlists.json) for built-in stations, and live from the
 * Worker for stations the listener added. Covers and 30-second previews
 * are found by ./previewService.js.
 */
import { fetchOrbPlaylist } from './orbApi.js';
import { resolveSong, forget } from './previewService.js';

const PER_STATION    = 40;

let playlistsPromise = null;

function loadPlaylists() {
  if (!playlistsPromise) {
    const day = new Date().toISOString().slice(0, 10);
    const url = new URL(`./data/playlists.json?v=${day}`, document.baseURI);
    playlistsPromise = fetch(url, { cache: 'no-cache' })
      .then(r => {
        if (!r.ok) throw new Error(`playlists.json HTTP ${r.status}`);
        return r.json();
      })
      .catch(err => {
        console.error('Failed to load playlists.json:', err);
        return { generatedAt: null, stations: {} };
      });
  }
  return playlistsPromise;
}

export function clearPlaylistCache() {
  playlistsPromise = null;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function trackId(stationId, artist, title) {
  return `${stationId}:${artist}:${title}`.toLowerCase().replace(/[^a-z0-9:]/g, '');
}

/** Add cover + preview to a track. Returns the track unchanged if none is known. */
export async function enrichTrack(track) {
  if (!track || (track.coverArt && track.previewUrl)) return track;
  const rec = await resolveSong(track.artist, track.title).catch(() => null);
  return rec?.status === 'found' ? withPreview(track, rec) : track;
}

/** A preview failed to play (e.g. an expired link): look the song up afresh. */
export async function reresolve(track) {
  forget(track.artist, track.title);
  const rec = await resolveSong(track.artist, track.title, { fresh: true }).catch(() => null);
  return rec?.status === 'found' ? withPreview({ ...track, previewUrl: null, coverArt: null }, rec) : null;
}

function withPreview(track, rec) {
  return {
    ...track,
    coverArt:   rec.cover || null,
    previewUrl: rec.preview,
    album:      rec.album || '',
    duration:   rec.duration || null,
    appleLink:  rec.appleLink || null,
    deezerLink: rec.deezerLink || null,
    source:     rec.source,
  };
}

const counts = {};

/**
 * Songs for one station. Built-in stations read the nightly JSON and fall
 * back to the live Worker when tonight's scrape came up empty; added
 * stations always come live from the Worker.
 */
export async function getStationTracks(station) {
  let list = [];
  if (station.source !== 'orb') {
    const all = await loadPlaylists();
    list = all.stations?.[station.id] || [];
  }
  if (!list.length && station.orb) list = await fetchOrbPlaylist(station.orb);
  counts[station.id] = list.length;
  return list;
}

/** Track counts seen so far this session, by station id. */
export const knownCounts = () => ({ ...counts });

/**
 * Build a mix from station objects.
 *
 * For each station, take up to PER_STATION random tracks (skipping ids in
 * `exclude`, e.g. songs already heard), round-robin across stations, then
 * final-shuffle. Tracks come back un-enriched: covers and previews are
 * fetched on demand by the feed.
 */
function toTrack(st, t) {
  return {
    id:          trackId(st.id, t.artist, t.title),
    artist:      t.artist,
    title:       t.title,
    album:       '',
    coverArt:    null,
    previewUrl:  null,
    duration:    null,
    deezerLink:  null,
    appleLink:   null,
    stationId:   st.id,
    station:     st.name || 'Radio',
  };
}

/** A station's songs in playlist order (most recently played first). */
export async function stationSongs(station) {
  const list = await getStationTracks(station).catch(() => []);
  const seen = new Set();
  return list.map(t => toTrack(station, t)).filter(t => !seen.has(t.id) && seen.add(t.id));
}

export async function buildMix(stations, exclude = new Set()) {
  if (!stations?.length) return [];
  const lists = await Promise.all(stations.map(st => getStationTracks(st).catch(() => [])));

  const queues = stations
    .map((st, k) => {
      const tracks = lists[k]
        .map(t => toTrack(st, t))
        .filter(t => !exclude.has(t.id));
      return { queue: shuffle(tracks).slice(0, PER_STATION) };
    })
    .filter(s => s.queue.length > 0);

  const picked = [];
  while (queues.some(s => s.queue.length)) {
    for (const s of queues) {
      if (s.queue.length) picked.push(s.queue.shift());
    }
  }
  return shuffle(picked);
}

/** Number of tracks available per station in today's data. */
export async function stationTrackCounts() {
  const all = await loadPlaylists();
  return Object.fromEntries(
    Object.entries(all.stations || {}).map(([id, arr]) => [id, arr.length])
  );
}

export async function feedDiagnostics() {
  const all = await loadPlaylists();
  return {
    generatedAt: all.generatedAt,
    counts: Object.fromEntries(
      Object.entries(all.stations || {}).map(([id, arr]) => [id, arr.length])
    ),
  };
}
