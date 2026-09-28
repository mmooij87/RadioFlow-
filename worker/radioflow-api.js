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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        const c = (url.searchParams.get('c') || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
        if (!q && !c) return json({ error: 'q or c required' }, 400);
        return cached(request, ctx, 12 * 3600, () => search(q, c));
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
  const anchor = /<a\b[^>]*href="(?:https?:\/\/onlineradiobox\.com)?\/([a-z]{2})\/([a-z0-9_.-]+)\/"[^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  while ((m = anchor.exec(html))) hits.push({ cc: m[1], slug: m[2], inner: m[3], start: m.index, end: anchor.lastIndex });

  const out = [];
  const seen = new Set();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const tail = html.slice(h.end, hits[i + 1]?.start ?? h.end + 3000);
    const country = /search\?c=([a-z]{2})"[^>]*title="([^"]*)"/i.exec(tail) || /search\?c=([a-z]{2})"/i.exec(tail);
    if (!country) continue;                       // not a result tile
    const id = `${h.cc}/${h.slug}`;
    if (seen.has(id) || ['genre', 'search'].includes(h.slug)) continue;
    seen.add(id);

    const alt = /\balt="([^"]+)"/i.exec(h.inner)?.[1] || /\btitle="([^"]+)"/i.exec(h.inner)?.[1];
    let name = decode(alt || text(h.inner));
    // Tiles often print the name twice (logo alt + caption): keep one.
    const half = name.length / 2;
    if (Number.isInteger(half) && name.slice(0, half).trim() === name.slice(half).trim()) name = name.slice(0, half).trim();
    if (!name) continue;

    const logoSrc = /\b(?:data-src|src)="([^"]*\/img\/l\/[^"]+)"/i.exec(h.inner)?.[1];
    const genres = [...tail.matchAll(/search\?s=[^"]*"[^>]*>([^<]{1,30})</gi)].map(g => decode(g[1]).trim()).filter(Boolean);
    const city = /search\?c=[a-z]{2}&(?:amp;)?ct=\d+[^"]*"[^>]*>([^<]+)</i.exec(tail)?.[1];

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
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const data = await produce();
  const res = json(data, 200, { 'Cache-Control': `public, max-age=${ttl}` });
  ctx.waitUntil(cache.put(key, res.clone()));
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
