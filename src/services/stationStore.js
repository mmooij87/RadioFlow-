/**
 * The listener's own dial: which stations are on it, which are switched
 * on, and where songs should open. Everything lives in localStorage.
 *
 * Stations are either
 *   - built-in  { id: 'kink', source: 'builtin', … }  (nightly JSON)
 *   - added     { id: 'orb:nl/kink', orb: 'nl/kink', source: 'orb', … }  (live via the Worker)
 */
import { STATIONS, flagOf } from '../data/stations.js';

const LIST_KEY = 'rf_my_stations_v1';
const OPEN_KEY = 'rf_open_in';
const SOLO_KEY = 'rf_solo';                 // id of the station tuned in alone, if any

// Retire the per-station on/off state of earlier versions: every station on
// your dial now plays, unless you've tuned in to one of them alone.
try { localStorage.removeItem('radioflow_stations'); localStorage.removeItem('rf_solo_prev'); } catch {}

export const SERVICES = {
  spotify: { label: 'Spotify' },
  ytmusic: { label: 'YouTube Music' },
  apple:   { label: 'Apple Music' },
};

const listeners = new Set();
const emit = (what) => listeners.forEach(fn => fn(what));
export const onStoreChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const read = (k, fallback) => { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

function builtin(id) {
  const st = STATIONS.find(s => s.id === id);
  return st ? { ...st, source: 'builtin' } : null;
}

// ── Station list ───────────────────────────────────────────
export function getMyStations() {
  const raw = read(LIST_KEY, null);
  if (!Array.isArray(raw)) return STATIONS.map(s => ({ ...s, source: 'builtin' }));
  return raw
    .map(e => (e.source === 'orb' ? e : builtin(e.id)))
    .filter(Boolean);
}

function saveList(list) {
  write(LIST_KEY, list.map(s => (s.source === 'orb'
    ? { id: s.id, orb: s.orb, source: 'orb', name: s.name, city: s.city, country: s.country,
        cc: s.cc, code: s.code, genre: s.genre, freq: s.freq, logo: s.logo }
    : { id: s.id, source: 'builtin' })));
}

export function findMyStation(id) { return getMyStations().find(s => s.id === id) || null; }

/** Is this ORB station already on the dial (added, or as a built-in)? */
export function hasOrb(orbId) { return getMyStations().some(s => s.orb === orbId); }

export function addStation(st) {
  const list = getMyStations();
  if (list.some(s => s.id === st.id || (st.orb && s.orb === st.orb))) return false;
  list.push(st);
  saveList(list);
  clearSolo();
  emit('stations');
  return true;
}

export function removeStation(id) {
  if (getSolo() === id) clearSolo();
  saveList(getMyStations().filter(s => s.id !== id));
  emit('stations');
}

export function resetStations() {
  try { localStorage.removeItem(LIST_KEY); localStorage.removeItem(SOLO_KEY); } catch {}
  emit('stations');
}

// ── Playing: all stations, or one tuned in alone ─────────
/** The station tuned in alone, or null when everything plays. */
export function getSolo() {
  const id = read(SOLO_KEY, null);
  return id && getMyStations().some(s => s.id === id) ? id : null;
}

/** Ids of the stations currently feeding the mix. */
export function getSelected() {
  const solo = getSolo();
  return solo ? new Set([solo]) : new Set(getMyStations().map(s => s.id));
}

export function soloStation(id) {
  write(SOLO_KEY, id);
  emit('selection');
}

/** Back to every station on the dial. */
export function restoreFromSolo() {
  if (!getSolo()) return;
  clearSolo();
  emit('selection');
}

function clearSolo() { try { localStorage.removeItem(SOLO_KEY); } catch {} }

// ── Where songs open ───────────────────────────────────────
export function getOpenIn() {
  const v = read(OPEN_KEY, 'spotify');
  return SERVICES[v] ? v : 'spotify';
}
export function setOpenIn(v) {
  if (!SERVICES[v]) return;
  write(OPEN_KEY, v);
  emit('openIn');
}

export function songUrl(track, service = getOpenIn()) {
  const q = encodeURIComponent(`${track.artist} ${track.title}`);
  if (service === 'ytmusic') return `https://music.youtube.com/search?q=${q}`;
  if (service === 'apple') return track.appleLink || `https://music.apple.com/search?term=${q}`;
  return `https://open.spotify.com/search/${q}`;
}

// ── Display helpers ────────────────────────────────────────
export function stationTopLine(st) { return st.freq || st.genre || (st.code || st.cc || '').toUpperCase(); }
export function stationPlace(st) {
  const flag = st.source === 'orb' ? flagOf(st.code) : st.cc;
  return `${flag ? flag + '\u2009' : ''}${st.city || st.country || ''}`;
}
