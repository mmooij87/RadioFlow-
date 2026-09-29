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
 *   GET /lookup?artist=…&title=…  → 30-second preview + cover (Deezer, then iTunes)
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
const CACHE_VERSION = '4';   // bump to invalidate everything cached by older versions

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
      if (url.pathname === '/lookup') {
        const artist = (url.searchParams.get('artist') || '').trim().slice(0, 120);
        const title = (url.searchParams.get('title') || '').trim().slice(0, 160);
        if (!artist || !title) return json({ error: 'artist and title required' }, 400);
        // Short cache: Deezer preview links carry an expiry.
        return cached(request, ctx, 15 * 60, () => lookup(artist, title));
      }
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

// ─── Preview lookup ──────────────────────────────────────────
async function lookup(artist, title) {
  const deezer = await deezerLookup(artist, title).catch(() => null);
  if (deezer) return deezer;
  const itunes = await itunesLookup(artist, title).catch(() => null);
  if (itunes) return itunes;
  return { found: false };
}

async function deezerLookup(artist, title) {
  const q = `artist:"${clip(artist)}" track:"${clip(title)}"`;
  let rows = await deezerSearch(q);
  if (!rows.length) rows = await deezerSearch(`${artist} ${title}`);
  const best = pick(rows.map(r => ({
    r, s: score(r.artist?.name, r.title_short || r.title, artist, title), ok: !!r.preview,
  })));
  if (!best) return null;
  const r = best.r;
  return {
    found: true, source: 'deezer',
    previewUrl: r.preview,
    coverArt: r.album?.cover_xl || r.album?.cover_big || null,
    album: r.album?.title || '',
    duration: r.duration || null,
    deezerLink: r.link || null,
    appleLink: null,
  };
}

async function deezerSearch(q) {
  const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=8`, { cf: { cacheTtl: 900 } });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  return Array.isArray(data?.data) ? data.data : [];
}

async function itunesLookup(artist, title) {
  const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&media=music&entity=song&limit=8`,
    { cf: { cacheTtl: 86400 } });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const best = pick((data?.results || []).map(r => ({
    r, s: score(r.artistName, r.trackName, artist, title) - (/karaoke|tribute|in the style of/i.test(`${r.artistName} ${r.collectionName}`) ? 5 : 0),
    ok: !!r.previewUrl,
  })));
  if (!best) return null;
  const r = best.r;
  return {
    found: true, source: 'itunes',
    previewUrl: r.previewUrl,
    coverArt: r.artworkUrl100 ? r.artworkUrl100.replace(/\/\d+x\d+(bb)?\.(jpg|png)$/i, '/1000x1000bb.jpg') : null,
    album: r.collectionName || '',
    duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : null,
    deezerLink: null,
    appleLink: r.trackViewUrl || null,
  };
}

function pick(cands) {
  const best = cands.filter(c => c.ok).sort((a, b) => b.s - a.s)[0];
  return best && best.s >= 3 ? best : null;   // no convincing match → nothing, not a wrong song
}
function clip(s) { return String(s).replace(/"/g, '').replace(/\(.*?\)|\[.*?\]/g, '').trim(); }
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b(feat|ft|featuring)\b.*$/, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
function score(ra, rt, artist, title) {
  const a = norm(artist), t = norm(title), xa = norm(ra), xt = norm(rt);
  let s = 0;
  if (xa === a) s += 4; else if (xa && a && (xa.includes(a) || a.includes(xa))) s += 3;
  if (xt === t) s += 3; else if (xt && t && (xt.includes(t) || t.includes(xt))) s += 2;
  return s;
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(), ...extra },
  });
}
