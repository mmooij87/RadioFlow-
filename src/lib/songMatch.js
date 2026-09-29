/**
 * Song matching, shared by the browser, the nightly script and (as a
 * verbatim copy) the Cloudflare Worker. Keep the three in sync: the song
 * key must come out identical everywhere or the shared catalogue splits.
 *
 * Radio playlists and music catalogues credit the same recording
 * differently ("The Beatles" / "Beatles", "Song - 2011 Remaster",
 * "A feat. B" / "A & B"), so we compare cleaned-up words, not strings,
 * and only accept a result when BOTH the artist and the title agree.
 */

// "(Remastered 2011)", "[Live]", "(feat. X)", "(Radio Edit)" …
const NOISE_BRACKETS = /\s*[([][^)\]]*\b(remaster\w*|re-master\w*|radio|edit|version|mix|live|mono|stereo|deluxe|bonus|single|album|explicit|clean|acoustic|demo|feat|ft|with|from)\b[^)\]]*[)\]]/gi;
// "Song - 2011 Remaster", "Song - Radio Edit", "Song - Live at …"
const NOISE_DASH = /\s+[-–]\s+(\d{4}\s+)?(remaster\w*|radio edit|single version|album version|edit|mix|live|mono|stereo|acoustic|demo)\b.*$/i;

export function cleanTitle(t) {
  const s = String(t || '');
  const out = s.replace(NOISE_BRACKETS, '').replace(NOISE_DASH, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '').trim();
  return out || s.trim();
}

/** First credited artist: "A feat. B", "A & B", "A, B", "A x B" → "A". */
export function primaryArtist(a) {
  const s = String(a || '');
  return s.split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[,&;/+]\s*|\s+and\s+/i)[0].trim() || s.trim();
}

export function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^the\s+/, '')
    .trim();
}

/** Stable key for a song, used by every cache and the shared catalogue. */
export function songKey(artist, title) {
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
export function matchScore(cand, want) {
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
export function searchQueries(artist, title) {
  const pa = primaryArtist(artist), ct = cleanTitle(title);
  return [...new Set([`${artist} ${title}`, `${pa} ${ct}`, ct])];
}

export function pickBest(cands, want) {
  let best = null;
  for (const c of cands) {
    if (!c.preview) continue;
    const m = matchScore(c, want);
    if (m.ok && (!best || m.score > best.score)) best = { ...c, score: m.score };
  }
  return best;
}
