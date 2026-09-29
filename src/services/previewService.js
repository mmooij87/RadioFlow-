/**
 * Finding a 30-second preview (and cover) for a song, built to scale:
 *
 *   1. this browser's cache
 *   2. the nightly pre-resolved list for the built-in stations
 *   3. the shared song catalogue in the Worker (one lookup, for everyone)
 *   4. this browser asks iTunes, then Deezer (JSONP), using the visitor's
 *      own rate limits, and reports the result back to the catalogue
 *   5. the Worker looks it up itself (last resort)
 *
 * The one rule everything hangs on: "the catalogues say this song has no
 * preview" is remembered; "we got throttled / couldn't ask" never is.
 */
import { API_BASE } from '../config.js';
import { songKey, searchQueries, pickBest, primaryArtist, cleanTitle } from '../lib/songMatch.js';

const LS = 'rf_song_v5:';
const FOUND_TTL = 14 * 86400e3;
const MISSING_TTL = 3 * 86400e3;
const api = () => API_BASE.replace(/\/+$/, '');

const mem = new Map();        // key → { ts, rec }
const inflight = new Map();   // key → Promise<rec|null>

// Clear caches from earlier versions (they held false "not found" answers).
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('rf_enrich_')) localStorage.removeItem(k);
  }
} catch {}

// ── Local cache ──────────────────────────────────────────────
function readCache(key) {
  let e = mem.get(key);
  if (!e) { try { e = JSON.parse(localStorage.getItem(LS + key) || 'null'); } catch {} }
  if (!e) return undefined;
  const ttl = e.rec?.status === 'found' ? FOUND_TTL : MISSING_TTL;
  if (Date.now() - e.ts > ttl) return undefined;
  mem.set(key, e);
  return e.rec;
}
function writeCache(key, rec) {
  const e = { ts: Date.now(), rec };
  mem.set(key, e);
  try { localStorage.setItem(LS + key, JSON.stringify(e)); } catch {}
}
export function forget(artist, title) {
  const key = songKey(artist, title);
  mem.delete(key);
  try { localStorage.removeItem(LS + key); } catch {}
}

// ── Nightly pre-resolved list (built-in stations) ────────────
let prebaked = null;
function loadPrebaked() {
  if (!prebaked) {
    const day = new Date().toISOString().slice(0, 10);
    prebaked = fetch(new URL(`./data/previews.json?v=${day}`, document.baseURI), { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : {})).then(j => j.songs || {}).catch(() => ({}));
  }
  return prebaked;
}

// ── Shared catalogue (batched) ───────────────────────────────
let batch = [];
let batchTimer = 0;
function catalogueGet(key) {
  if (!API_BASE) return Promise.resolve(null);
  return new Promise(resolve => {
    batch.push({ key, resolve });
    clearTimeout(batchTimer);
    batchTimer = setTimeout(flushBatch, batch.length >= 20 ? 0 : 40);
  });
}
async function flushBatch() {
  const items = batch.splice(0, 25);
  if (batch.length) batchTimer = setTimeout(flushBatch, 0);
  if (!items.length) return;
  try {
    const qs = items.map(i => `k=${encodeURIComponent(i.key)}`).join('&');
    const res = await fetch(`${api()}/songs?${qs}`);
    const data = res.ok ? await res.json() : {};
    items.forEach(i => i.resolve(data[i.key] || null));
  } catch {
    items.forEach(i => i.resolve(null));
  }
}
function cataloguePut(artist, title, rec) {
  if (!API_BASE) return;
  fetch(`${api()}/songs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: songKey(artist, title), artist, title, rec }),
    keepalive: true,
  }).catch(() => {});
}

// ── iTunes, from this browser ────────────────────────────────
// Apple allows roughly 20 searches a minute per visitor, and says "slow
// down" with a 403 rather than a 429.
const ITUNES_BUDGET = 18;
const itunesCalls = [];
function itunesBudget() {
  const t = Date.now();
  while (itunesCalls.length && t - itunesCalls[0] > 60000) itunesCalls.shift();
  return itunesCalls.length < ITUNES_BUDGET;
}
async function itunesSearch(artist, title) {
  const want = { artist, title };
  for (const q of searchQueries(artist, title)) {
    if (!itunesBudget()) return { status: 'retry' };
    itunesCalls.push(Date.now());
    let res;
    try { res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=10`); }
    catch { return { status: 'retry' }; }
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) while (itunesCalls.length < ITUNES_BUDGET) itunesCalls.push(Date.now());
      return { status: 'retry' };
    }
    const data = await res.json().catch(() => null);
    if (!data) return { status: 'retry' };
    const best = pickBest((data.results || []).map(r => ({
      artist: r.artistName, title: r.trackName, album: r.collectionName, preview: r.previewUrl, raw: r,
    })), want);
    if (best) {
      const r = best.raw;
      return { status: 'found', rec: {
        status: 'found', source: 'itunes', preview: r.previewUrl,
        cover: r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg') : null,
        album: r.collectionName || '', duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
        appleLink: r.trackViewUrl || null,
      } };
    }
  }
  return { status: 'missing' };
}

// ── Deezer, from this browser (JSONP: Deezer sends no CORS headers) ──
let jsonpN = 0;
function jsonp(url, timeout = 7000) {
  return new Promise((resolve, reject) => {
    const cb = `__rfdz${Date.now().toString(36)}${jsonpN++}`;
    const s = document.createElement('script');
    const done = (fn, v) => { clearTimeout(t); delete window[cb]; s.remove(); fn(v); };
    const t = setTimeout(() => done(reject, new Error('timeout')), timeout);
    window[cb] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error('network'));
    s.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${cb}`;
    document.head.appendChild(s);
  });
}
const DZ_WINDOW = 5000, DZ_BUDGET = 40;
const dzCalls = [];
function dzBudget() {
  const t = Date.now();
  while (dzCalls.length && t - dzCalls[0] > DZ_WINDOW) dzCalls.shift();
  return dzCalls.length < DZ_BUDGET;
}
async function deezerSearch(artist, title) {
  const want = { artist, title };
  const qs = [`artist:"${primaryArtist(artist).replace(/"/g, '')}" track:"${cleanTitle(title).replace(/"/g, '')}"`, ...searchQueries(artist, title)];
  for (const q of qs) {
    if (!dzBudget()) return { status: 'retry' };
    dzCalls.push(Date.now());
    let data;
    try { data = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`); }
    catch { return { status: 'retry' }; }
    if (!data || data.error) return { status: 'retry' };   // quota errors hide in a 200 body
    const best = pickBest((data.data || []).map(r => ({
      artist: r.artist?.name, title: r.title_short || r.title, album: r.album?.title, preview: r.preview, raw: r,
    })), want);
    if (best) {
      const r = best.raw;
      return { status: 'found', rec: {
        status: 'found', source: 'deezer', preview: r.preview,
        cover: r.album?.cover_xl || r.album?.cover_big || null, album: r.album?.title || '',
        duration: r.duration || null, deezerLink: r.link || null, deezerId: r.id || null,
      } };
    }
  }
  return { status: 'missing' };
}

/** Deezer preview links carry an expiry (…exp=1700000000…). */
function expired(url) {
  const m = /exp=(\d{9,})/.exec(url || '');
  return m ? Number(m[1]) * 1000 - 5 * 60e3 < Date.now() : false;
}
async function renewDeezer(rec) {
  if (!rec?.deezerId) return rec;
  try {
    const d = await jsonp(`https://api.deezer.com/track/${rec.deezerId}`);
    if (d && !d.error && d.preview) return { ...rec, preview: d.preview, stale: false };
  } catch {}
  return rec;
}

async function workerLookup(artist, title) {
  if (!API_BASE) return null;
  try {
    const res = await fetch(`${api()}/lookup?artist=${encodeURIComponent(artist)}&title=${encodeURIComponent(title)}`);
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// ── The resolver ─────────────────────────────────────────────
/**
 * → { status: 'found', preview, cover, … } | { status: 'missing' } | null (unknown for now)
 */
export function resolveSong(artist, title, { fresh = false } = {}) {
  const key = songKey(artist, title);
  if (!fresh && inflight.has(key)) return inflight.get(key);
  const p = resolve(key, artist, title, fresh).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function resolve(key, artist, title, fresh) {
  // 1. this browser
  if (!fresh) {
    const c = readCache(key);
    if (c !== undefined) return c?.source === 'deezer' && expired(c.preview) ? keep(key, artist, title, await renewDeezer(c), true) : c;
  }
  // 2. nightly list for the built-in stations
  const pre = (await loadPrebaked())[key];
  if (pre && !fresh) {
    const rec = pre.source === 'deezer' && expired(pre.preview) ? await renewDeezer(pre) : pre;
    if (!expired(rec.preview)) { writeCache(key, rec); return rec; }
  }
  // 3. shared catalogue
  let cat = await catalogueGet(key);
  if (cat?.status === 'found' && (cat.stale || expired(cat.preview))) cat = await keep(key, artist, title, await renewDeezer(cat), true);
  if (cat && !(fresh && cat.status === 'missing')) { writeCache(key, cat); return cat; }
  // 4. this browser asks the catalogues itself
  const it = await itunesSearch(artist, title);
  if (it.status === 'found') return keep(key, artist, title, it.rec, true);
  const dz = await deezerSearch(artist, title);
  if (dz.status === 'found') return keep(key, artist, title, dz.rec, true);
  if (it.status === 'missing' && dz.status === 'missing') return keep(key, artist, title, { status: 'missing' }, true);
  // 5. throttled here: let the Worker try
  const w = await workerLookup(artist, title);
  if (w?.status === 'found' || w?.status === 'missing') { writeCache(key, w); return w; }
  return null;      // unknown for now: remember nothing
}

function keep(key, artist, title, rec, share) {
  if (!rec || expired(rec.preview)) return rec;
  const { stale, ...clean } = rec;
  writeCache(key, clean);
  if (share) cataloguePut(artist, title, clean);
  return clean;
}
