/**
 * Client for the RadioFlow Worker (see worker/radioflow-api.js):
 * station search across OnlineRadioBox and live song lists.
 */
import { API_BASE } from '../config.js';
import { flagOf } from '../data/stations.js';

const PL_TTL = 20 * 60 * 1000;
const mem = new Map();

export const apiReady = () => !!API_BASE;
const base = () => API_BASE.replace(/\/+$/, '');

async function getJson(path, { signal } = {}) {
  const res = await fetch(`${base()}${path}`, { signal });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

/** Search stations. Returns station objects ready for the dial. */
export async function searchStations(q, { signal } = {}) {
  if (!apiReady()) throw new Error('not-configured');
  const rows = await getJson(`/search?q=${encodeURIComponent(q)}`, { signal });
  return (Array.isArray(rows) ? rows : []).map(r => ({
    id: `orb:${r.id}`,
    orb: r.id,
    source: 'orb',
    name: r.name,
    city: r.city || '',
    country: r.country || '',
    code: r.cc,
    cc: flagOf(r.cc),
    genre: r.genres?.[0] || '',
    genres: r.genres || [],
    freq: '',
    logo: r.logo || null,
  }));
}

/** Song list for an ORB station id like "nl/kink". Cached ~20 min. */
export async function fetchOrbPlaylist(orbId) {
  if (!apiReady() || !orbId) return [];
  const hit = mem.get(orbId);
  if (hit && Date.now() - hit.ts < PL_TTL) return hit.data;
  try {
    const ss = JSON.parse(sessionStorage.getItem(`rf_pl:${orbId}`) || 'null');
    if (ss && Date.now() - ss.ts < PL_TTL) { mem.set(orbId, ss); return ss.data; }
  } catch {}
  const p = getJson(`/playlist?id=${encodeURIComponent(orbId)}`)
    .then(data => (Array.isArray(data) ? data : []))
    .catch(() => []);
  const data = await p;
  const entry = { ts: Date.now(), data };
  mem.set(orbId, entry);
  try { sessionStorage.setItem(`rf_pl:${orbId}`, JSON.stringify(entry)); } catch {}
  return data;
}
