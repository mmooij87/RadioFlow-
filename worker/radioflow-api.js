/**
 * RadioFlow API — Cloudflare Worker
 *
 * Gives the RadioFlow web app access to OnlineRadioBox's catalogue of
 * 100,000+ stations and their "what was played" lists, which a browser
 * can't read directly (no CORS).
 *
 *   GET /search?q=jazz            → stations matching a name, city or genre
 *   GET /search?q=&c=nl           → optional country filter (ISO code)
 *   GET /playlist?id=nl/kink      → [{artist,title}] from roughly the last 24h
 *   GET  /songs?k=key&k=key       → shared song catalogue: preview + cover per song key
 *   POST /songs                   → a browser reports what it found for a song
 *   GET  /lookup?artist=…&title=… → server-side lookup (last resort), stored in the catalogue
 *
 * The song catalogue (optional, strongly recommended) lives in a Cloudflare
 * D1 database bound as DB. Every song is looked up once for everyone.
 *   GET /health                   → { ok: true }
 *
 * Responses are cached at Cloudflare's edge (search 12h, playlists 20 min),
 * so OnlineRadioBox sees very little traffic even with many listeners.
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker →
 * paste this file → Deploy. No settings or secrets needed.
 */

const ORB = 'https://onlineradiobox.com';
const UA = 'Mozilla/5.0 (compatible; RadioFlow/1.0; +https://mmooij87.github.io/RadioFlow-/)';
const MAX_TRACKS = 80;
const CACHE_VERSION = '5';   // bump to invalidate everything cached by older versions

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/debug') return json(await debug(url));
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        const c = (url.searchParams.get('c') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
        if (!q && !c) return json({ error: 'q or c required' }, 400);
        return cached(request, ctx, 12 * 3600, () => search(q, c));
      }
      if (url.pathname === '/songs' && request.method === 'GET') {
        const keys = url.searchParams.getAll('k').slice(0, 25).map(k => k.slice(0, 200));
        return json(await getSongs(env, keys), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/songs' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        return json(await putSong(env, body), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/lookup') {
        const artist = (url.searchParams.get('artist') || '').trim().slice(0, 120);
        const title = (url.searchParams.get('title') || '').trim().slice(0, 160);
        if (!artist || !title) return json({ error: 'artist and title required' }, 400);
        return json(await serverLookup(env, artist, title), 200, { 'Cache-Control': 'no-store' });
      }
      if (url.pathname === '/stats') return json(await stats(env), 200, { 'Cache-Control': 'no-store' });
      if (url.pathname === '/playlist') {
        const id = (url.searchParams.get('id') || '').toLowerCase();
        if (!/^[a-z]{2}\/[a-z0-9_.-]{1,60}$/.test(id)) return json({ error: 'id must look like "nl/kink"' }, 400);
        return cached(request, ctx, 20 * 60, () => playlist(id));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e?.message || e) }, 502);
    }
  },
};

// ─── Search ──────────────────────────────────────────────────
async function search(q, c) {
  const params = new URLSearchParams({ lang: 'en' });
  if (q) params.set('q', q);
  if (c) params.set('c', c);
  const html = await get(`${ORB}/search?${params}`);
  return parseSearch(html);
}

export function parseSearch(html) {
  // Every result tile starts with a link to /<cc>/<slug>/ and, unlike the
  // "Recommended" sidebar, carries a country filter link (search?c=xx).
  const anchor = /<a\b[^>]*href=["'](?:(?:https?:)?\/\/(?:www\.)?onlineradiobox\.com)?\/([a-z]{2})\/([a-z0-9_.-]+)\/?(?:\?[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  while ((m = anchor.exec(html))) hits.push({ cc: m[1], slug: m[2], inner: m[3], start: m.index, end: anchor.lastIndex });

  const out = [];
  const seen = new Set();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const tail = html.slice(h.end, hits[i + 1]?.start ?? h.end + 3000);
    // Country link: search?c=xx, with its name in a title attribute
    // (before or after the href). Result tiles have one; sidebars don't.
    const cm = /<a\b[^>]*[?&]c=([a-z]{2})(?=["'&])[^>]*>/i.exec(tail);
    const country = cm && [cm[0], cm[1], /title=["']([^"']*)["']/i.exec(cm[0])?.[1] || ''];
    if (!country) continue;                       // not a result tile
    const id = `${h.cc}/${h.slug}`;
    if (seen.has(id) || ['genre', 'search', 'playlist', 'app'].includes(h.slug)) continue;
    seen.add(id);

    const alt = /\balt=["']([^"']+)["']/i.exec(h.inner)?.[1] || /\btitle=["']([^"']+)["']/i.exec(h.inner)?.[1];
    let name = decode(alt || text(h.inner));
    // Tiles often print the name twice (logo alt + caption): keep one.
    const half = name.length / 2;
    if (Number.isInteger(half) && name.slice(0, half).trim() === name.slice(half).trim()) name = name.slice(0, half).trim();
    if (!name) continue;

    const logoSrc = /\b(?:data-src|src)=["']([^"']*\/img\/l\/[^"']+)["']/i.exec(h.inner)?.[1];
    const genres = [...tail.matchAll(/(?:[?&]|&amp;)s=[^"']*["'][^>]*>([^<]{1,30})</gi)].map(g => decode(g[1]).trim()).filter(Boolean);
    const city = /[?&](?:amp;)?ct=\d+[^"']*["'][^>]*>([^<]+)</i.exec(tail)?.[1];

    out.push({
      id,
      name,
      cc: h.cc,
      country: country[2] ? decode(country[2]) : h.cc.toUpperCase(),
      city: city ? decode(city).trim() : '',
      genres: [...new Set(genres)].slice(0, 3),
      logo: logoSrc ? (logoSrc.startsWith('//') ? `https:${logoSrc}` : logoSrc) : null,
    });
    if (out.length >= 30) break;
  }
  return out;
}

// ─── Song matching (verbatim copy of src/lib/songMatch.js) ─────
// "(Remastered 2011)", "[Live]", "(feat. X)", "(Radio Edit)" …
const NOISE_BRACKETS = /\s*[([][^)\]]*\b(remaster\w*|re-master\w*|radio|edit|version|mix|live|mono|stereo|deluxe|bonus|single|album|explicit|clean|acoustic|demo|feat|ft|with|from)\b[^)\]]*[)\]]/gi;
// "Song - 2011 Remaster", "Song - Radio Edit", "Song - Live at …"
const NOISE_DASH = /\s+[-–]\s+(\d{4}\s+)?(remaster\w*|radio edit|single version|album version|edit|mix|live|mono|stereo|acoustic|demo)\b.*$/i;

function cleanTitle(t) {
  const s = String(t || '');
  const out = s.replace(NOISE_BRACKETS, '').replace(NOISE_DASH, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  return out || s.trim();
}

/** First credited artist: "A feat. B", "A & B", "A, B", "A x B" → "A". */
function primaryArtist(a) {
  const s = String(a || '');
  return s.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[,&;/+]\s*|\s+and\s+/i)[0].trim() || s.trim();
}

function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

/** Stable key for a song, used by every cache and the shared catalogue. */
function songKey(artist, title) {
  return `${norm(primaryArtist(artist))}|${norm(cleanTitle(title))}`.slice(0, 200);
}

/** Share of the shorter name's words found in the other name (0..1). */
function overlap(a, b) {
  const A = new Set(norm(a).split(' ').filter(Boolean));
  const B = new Set(norm(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const FAKE = /karaoke|tribute|in the style of|made famous|cover version|as made famous|originally performed/i;

/**
 * Does a catalogue result match the song we want?
 * → { ok, score }. ok needs both artist and title to agree.
 */
function matchScore(cand, want) {
  if (FAKE.test(`${cand.artist} ${cand.album || ''} ${cand.title}`)) return { ok: false, score: 0 };
  const artist = Math.max(
    overlap(cand.artist, want.artist),
    overlap(primaryArtist(cand.artist), primaryArtist(want.artist)),
  );
  const title = Math.max(
    overlap(cleanTitle(cand.title), cleanTitle(want.title)),
    overlap(cand.title, want.title),
  );
  const exactA = norm(primaryArtist(cand.artist)) === norm(primaryArtist(want.artist)) ? 0.5 : 0;
  const exactT = norm(cleanTitle(cand.title)) === norm(cleanTitle(want.title)) ? 0.5 : 0;
  return { ok: artist >= 0.5 && title >= 0.6, score: artist * 2 + title * 2 + exactA + exactT };
}

/** Progressively looser search phrases; results are always verified. */
function searchQueries(artist, title) {
  const pa = primaryArtist(artist), ct = cleanTitle(title);
  return [...new Set([`${artist} ${title}`, `${pa} ${ct}`, ct])];
}

function pickBest(cands, want) {
  let best = null;
  for (const c of cands) {
    if (!c.preview) continue;
    const m = matchScore(c, want);
    if (m.ok && (!best || m.score > best.score)) best = { ...c, score: m.score };
  }
  return best;
}

// ─── Song catalogue (D1) ─────────────────────────────────────
// status: 'found' (with preview) or 'missing' (every catalogue answered
// "no such song"). A lookup that was throttled or failed is never stored.
const MISSING_TTL = 3 * 86400;          // re-check "missing" songs after 3 days
let schemaReady = false;

async function db(env) {
  if (!env?.DB) return null;
  if (!schemaReady) {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS songs (
      key TEXT PRIMARY KEY, status TEXT NOT NULL, source TEXT, preview TEXT, cover TEXT,
      album TEXT, duration INTEGER, apple_link TEXT, deezer_link TEXT, deezer_id INTEGER,
      checked_at INTEGER NOT NULL, hits INTEGER DEFAULT 0)`).run();
    schemaReady = true;
  }
  return env.DB;
}

const now = () => Math.floor(Date.now() / 1000);

function rowToRec(r) {
  if (!r) return null;
  if (r.status === 'missing') return now() - r.checked_at > MISSING_TTL ? null : { status: 'missing' };
  return {
    status: 'found', source: r.source, preview: r.preview, cover: r.cover, album: r.album || '',
    duration: r.duration || null, appleLink: r.apple_link || null, deezerLink: r.deezer_link || null,
    deezerId: r.deezer_id || null,
  };
}

async function getSongs(env, keys) {
  const out = Object.fromEntries(keys.map(k => [k, null]));
  const d = await db(env);
  if (!d || !keys.length) return out;
  const rows = await d.prepare(`SELECT * FROM songs WHERE key IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  let refreshes = 0;
  for (const r of rows.results || []) {
    let rec = rowToRec(r);
    // Deezer preview links expire: renew a few per request, from here.
    if (rec?.status === 'found' && rec.source === 'deezer' && expired(rec.preview) && rec.deezerId && refreshes < 5) {
      refreshes++;
      const fresh = await deezerTrack(rec.deezerId).catch(() => null);
      if (fresh) { rec.preview = fresh; await store(env, r.key, rec); }
      else rec.stale = true;       // the browser can renew it itself
    }
    out[r.key] = rec;
  }
  return out;
}

// Only accept media from the catalogues we actually use.
const OK_MEDIA = /^https:\/\/([a-z0-9-]+\.)*(mzstatic\.com|apple\.com|dzcdn\.net|deezer\.com)\//i;

async function putSong(env, body) {
  const key = String(body?.key || '').slice(0, 200);
  const rec = body?.rec;
  if (!key.includes('|') || !rec) return { ok: false };
  if (songKey(body.artist || '', body.title || '') !== key) return { ok: false, error: 'key mismatch' };
  if (rec.status === 'found') {
    if (!OK_MEDIA.test(rec.preview || '') || (rec.cover && !OK_MEDIA.test(rec.cover))) return { ok: false };
  } else if (rec.status !== 'missing') return { ok: false };
  const d = await db(env);
  if (!d) return { ok: false, error: 'no catalogue' };
  if (rec.status === 'missing') {
    // Never let a "missing" report overwrite a song someone did find.
    const cur = await d.prepare('SELECT status FROM songs WHERE key = ?').bind(key).first();
    if (cur?.status === 'found') return { ok: true, kept: 'found' };
  }
  await store(env, key, rec);
  return { ok: true };
}

async function store(env, key, rec) {
  const d = await db(env);
  if (!d) return;
  await d.prepare(`INSERT INTO songs (key, status, source, preview, cover, album, duration, apple_link, deezer_link, deezer_id, checked_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET status=excluded.status, source=excluded.source, preview=excluded.preview,
      cover=excluded.cover, album=excluded.album, duration=excluded.duration, apple_link=excluded.apple_link,
      deezer_link=excluded.deezer_link, deezer_id=excluded.deezer_id, checked_at=excluded.checked_at`)
    .bind(key, rec.status, rec.source || null, rec.preview || null, rec.cover || null, (rec.album || '').slice(0, 200),
      rec.duration || null, rec.appleLink || null, rec.deezerLink || null, rec.deezerId || null, now()).run();
}

async function stats(env) {
  const d = await db(env);
  if (!d) return { catalogue: false };
  const r = await d.prepare(`SELECT status, source, COUNT(*) n FROM songs GROUP BY status, source`).all();
  return { catalogue: true, songs: r.results };
}

function expired(url) {
  const m = /exp=(\d{9,})/.exec(url || '');
  return m ? Number(m[1]) - 300 < now() : false;
}

// ─── Server-side lookup (last resort) ────────────────────────
async function serverLookup(env, artist, title) {
  const key = songKey(artist, title);
  const known = (await getSongs(env, [key]))[key];
  if (known) return known;
  const it = await itunesSearch(artist, title);
  let rec = it.status === 'found' ? it.rec : null;
  let dz = { status: 'skipped' };
  if (!rec) { dz = await deezerSearch(artist, title); if (dz.status === 'found') rec = dz.rec; }
  if (rec) { await store(env, key, rec); return rec; }
  if (it.status === 'missing' && dz.status === 'missing') {
    await store(env, key, { status: 'missing' });
    return { status: 'missing' };
  }
  return { status: 'retry' };      // throttled or failed somewhere: don't conclude anything
}

async function itunesSearch(artist, title) {
  const want = { artist, title };
  let sawRetry = false;
  for (const q of searchQueries(artist, title)) {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=10`).catch(() => null);
    if (!res || !res.ok) { sawRetry = true; break; }          // iTunes throttles with 403
    const data = await res.json().catch(() => null);
    if (!data) { sawRetry = true; break; }
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
  return { status: sawRetry ? 'retry' : 'missing' };
}

async function deezerSearch(artist, title) {
  const want = { artist, title };
  const qs = [`artist:"${primaryArtist(artist).replace(/"/g, '')}" track:"${cleanTitle(title).replace(/"/g, '')}"`, ...searchQueries(artist, title)];
  let sawRetry = false;
  for (const q of qs) {
    const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`).catch(() => null);
    if (!res || !res.ok) { sawRetry = true; break; }
    const data = await res.json().catch(() => null);
    // Deezer reports "quota exceeded" inside a 200 response.
    if (!data || data.error) { sawRetry = true; break; }
    const best = pickBest((data.data || []).map(r => ({
      artist: r.artist?.name, title: r.title_short || r.title, album: r.album?.title, preview: r.preview, raw: r,
    })), want);
    if (best) return { status: 'found', rec: deezerRec(best.raw) };
  }
  return { status: sawRetry ? 'retry' : 'missing' };
}

function deezerRec(r) {
  return {
    status: 'found', source: 'deezer', preview: r.preview,
    cover: r.album?.cover_xl || r.album?.cover_big || null, album: r.album?.title || '',
    duration: r.duration || null, deezerLink: r.link || null, deezerId: r.id || null,
  };
}

async function deezerTrack(id) {
  const res = await fetch(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
  const data = await res.json().catch(() => null);
  return data && !data.error && data.preview ? data.preview : null;
}

// ─── Diagnostics: /debug?q=jazz  or  /debug?id=de/fluxfm1006 ───
async function debug(url) {
  const id = url.searchParams.get('id');
  const q = url.searchParams.get('q') || 'jazz';
  const target = id ? `${ORB}/${id}/playlist/?lang=en` : `${ORB}/search?${new URLSearchParams({ lang: 'en', q })}`;
  const res = await fetch(target, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.8' } });
  const html = await res.text();
  const around = (needle, n = 700) => {
    const i = html.indexOf(needle);
    return i < 0 ? null : html.slice(Math.max(0, i - n), i + 300).replace(/\s+/g, ' ');
  };
  return {
    target,
    status: res.status,
    finalUrl: res.url,
    bytes: html.length,
    title: /<title>([^<]*)/i.exec(html)?.[1] || null,
    counts: {
      countryLinks: (html.match(/[?&]c=[a-z]{2}["'&]/gi) || []).length,
      stationLinks: (html.match(/href=["'][^"']*\/[a-z]{2}\/[a-z0-9_.-]+\/?["']/gi) || []).length,
      trackLinks: (html.match(/\/track\//g) || []).length,
      tables: (html.match(/<table/gi) || []).length,
      rows: (html.match(/<tr\b/gi) || []).length,
    },
    parsed: id ? parsePlaylist(html).slice(0, 5) : parseSearch(html).slice(0, 5),
    sample: id ? around('/track/') || around('<table') : around('c=us') || around('c=') || html.slice(0, 1500).replace(/\s+/g, ' '),
  };
}

// ─── Playlist ────────────────────────────────────────────────
async function playlist(id) {
  // Today's page plus yesterday's gives a full 24 hours at any time of day.
  const pages = await Promise.allSettled([
    get(`${ORB}/${id}/playlist/?lang=en`),
    get(`${ORB}/${id}/playlist/1?lang=en`),
  ]);
  const tracks = [];
  const seen = new Set();
  for (const p of pages) {
    if (p.status !== 'fulfilled') continue;
    for (const t of parsePlaylist(p.value)) {
      const k = `${t.artist}:::${t.title}`.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      tracks.push(t);
      if (tracks.length >= MAX_TRACKS) return tracks;
    }
  }
  if (!tracks.length && pages.every(p => p.status === 'rejected')) throw new Error('station not found');
  return tracks;
}

export function parsePlaylist(html) {
  // The playlist is a table of rows: [time] [Artist - Title]. Titles are
  // linked when ORB knows the track and plain text when it doesn't: we
  // want both, so read the last cell of every row.
  const table = /<table[^>]*class="[^"]*tablelist-schedule[^"]*"[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]
    || /<table[^>]*>((?:(?!<\/table>)[\s\S])*?\/track\/[\s\S]*?)<\/table>/i.exec(html)?.[1]
    || '';
  const out = [];
  for (const row of table.split(/<tr\b/i).slice(1)) {
    const cells = row.split(/<td\b/i).slice(1);
    if (!cells.length) continue;
    const line = decode(text('<x' + cells[cells.length - 1])).replace(/\s+/g, ' ').trim();
    const i = line.indexOf(' - ');
    if (i < 1) continue;
    const artist = line.slice(0, i).trim();
    const title = line.slice(i + 3).trim();
    if (!artist || !title || isJunk(artist, title)) continue;
    out.push({ artist, title });
  }
  return out;
}

const JUNK = /\b(promo|jingle|advert\w*|reclame|station ?id|sweeper|commercial|\[break\])\b/i;
function isJunk(artist, title) {
  if (!/^[\p{L}\p{N}]/u.test(artist)) return true;
  if (/^(the )?(news|nieuws|nachrichten|journaal|weather|verkeer)\b/i.test(artist)) return true;
  return JUNK.test(artist) || JUNK.test(title);
}

// ─── Helpers ─────────────────────────────────────────────────
async function get(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.8' },
    cf: { cacheTtl: 600 },
  });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return res.text();
}

async function cached(request, ctx, ttl, produce) {
  const cache = caches.default;
  const u = new URL(request.url);
  u.searchParams.set('_v', CACHE_VERSION);
  const key = new Request(u.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const data = await produce();
  // Never keep an empty answer for long: it's usually a hiccup upstream.
  const keep = Array.isArray(data) && data.length === 0 ? 60 : ttl;
  const res = json(data, 200, { 'Cache-Control': `public, max-age=${keep}` });
  if (keep > 60) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function text(html) { return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
const NAMED = {
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euml: 'ë', iuml: 'ï',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Eacute: 'É', agrave: 'à', egrave: 'è',
  ograve: 'ò', acirc: 'â', ecirc: 'ê', ocirc: 'ô', ntilde: 'ñ', ccedil: 'ç', oslash: 'ø', Oslash: 'Ø',
  aring: 'å', Aring: 'Å', aelig: 'æ', AElig: 'Æ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', hellip: '…',
};
function decode(s) {
  return String(s)
    .replace(/&([a-zA-Z]+);/g, (m, n) => NAMED[n] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(), ...extra },
  });
}
