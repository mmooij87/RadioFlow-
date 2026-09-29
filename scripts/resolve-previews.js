/**
 * Nightly: find a 30-second preview + cover for every song of the built-in
 * stations, so browsers don't have to look anything up for them.
 *
 * Reads  public/data/playlists.json
 * Writes public/data/previews.json  { updatedAt, songs: { [songKey]: record } }
 *
 * Songs already resolved are kept (iTunes links are stable), so after the
 * first night only the handful of newly played songs is looked up. Runs
 * politely: ~18 iTunes searches a minute, backing off on a 403, with
 * Deezer as the second source. Stops after MAX_MINUTES and carries on the
 * next night.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { songKey, searchQueries, pickBest, primaryArtist, cleanTitle } from '../src/lib/songMatch.js';

const PLAYLISTS = path.resolve('public/data/playlists.json');
const OUT = path.resolve('public/data/previews.json');
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 20);
const ITUNES_GAP_MS = Number(process.env.ITUNES_GAP_MS || 3400);
const DEEZER_GAP_MS = Number(process.env.DEEZER_GAP_MS || 150);
const MISSING_RECHECK_DAYS = 7;
const FORGET_AFTER_DAYS = 21;

const today = new Date().toISOString().slice(0, 10);
const daysSince = (d) => (d ? (Date.now() - Date.parse(d)) / 86400e3 : Infinity);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const deadline = Date.now() + MAX_MINUTES * 60e3;

let lastItunes = 0, lastDeezer = 0;
async function paced(kind) {
  const gap = kind === 'itunes' ? ITUNES_GAP_MS : DEEZER_GAP_MS;
  const last = kind === 'itunes' ? lastItunes : lastDeezer;
  const wait = last + gap - Date.now();
  if (wait > 0) await sleep(wait);
  if (kind === 'itunes') lastItunes = Date.now(); else lastDeezer = Date.now();
}

async function itunes(artist, title) {
  const want = { artist, title };
  for (const q of searchQueries(artist, title)) {
    await paced('itunes');
    let res;
    try { res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=10`); }
    catch { return { status: 'retry' }; }
    if (res.status === 403 || res.status === 429) { console.warn('  iTunes says slow down, pausing'); await sleep(Number(process.env.BACKOFF_MS || 60e3)); return { status: 'retry' }; }
    if (!res.ok) return { status: 'retry' };
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

async function deezer(artist, title) {
  const want = { artist, title };
  const qs = [`artist:"${primaryArtist(artist).replace(/"/g, '')}" track:"${cleanTitle(title).replace(/"/g, '')}"`, ...searchQueries(artist, title)];
  for (const q of qs) {
    await paced('deezer');
    let data;
    try { data = await (await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=10`)).json(); }
    catch { return { status: 'retry' }; }
    if (!data || data.error) { await sleep(5e3); return { status: 'retry' }; }   // quota error inside a 200
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

async function main() {
  const playlists = JSON.parse(await fs.readFile(PLAYLISTS, 'utf8'));
  let prev = { songs: {} };
  try { prev = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch {}
  const songs = prev.songs || {};

  // Every song currently on a built-in station.
  const wanted = new Map();
  for (const list of Object.values(playlists.stations || {})) {
    for (const t of list) {
      const key = songKey(t.artist, t.title);
      if (!wanted.has(key)) wanted.set(key, t);
    }
  }

  const todo = [], upgrades = [];
  for (const [key, t] of wanted) {
    const s = songs[key];
    if (s) s.seen = today;
    if (s?.status === 'found') {
      // Deezer links expire; swap to an iTunes link when one exists.
      if (s.source === 'deezer' && !s.itunesTried) upgrades.push([key, t]);
      continue;
    }
    if (s?.status === 'missing' && daysSince(s.checked) < MISSING_RECHECK_DAYS) continue;
    todo.push([key, t]);
  }
  console.log(`${wanted.size} songs on the built-in stations: ${todo.length} to look up, ${upgrades.length} to upgrade (max ${MAX_MINUTES} min).`);

  // iTunes is slow (~18/min), Deezer fast. Use iTunes while there's time for
  // it, then fall back to Deezer only, so every song is covered tonight.
  const itunesUntil = Date.now() + MAX_MINUTES * 60e3 * 0.7;
  let found = 0, missing = 0, retry = 0, done = 0;
  for (const [key, t] of todo) {
    if (Date.now() > deadline) { console.log('Time budget reached; continuing tomorrow.'); break; }
    const useItunes = Date.now() < itunesUntil;
    let r = useItunes ? await itunes(t.artist, t.title) : { status: 'skipped' };
    if (r.status !== 'found') {
      const d = await deezer(t.artist, t.title);
      if (d.status === 'found') r = { ...d, rec: { ...d.rec, itunesTried: useItunes && r.status === 'missing' } };
      else if (r.status === 'missing' && d.status === 'missing') r = { status: 'missing' };
      else r = { status: 'retry' };
    }
    done++;
    if (r.status === 'found') { songs[key] = { ...r.rec, seen: today, checked: today }; found++; }
    else if (r.status === 'missing') { songs[key] = { status: 'missing', seen: today, checked: today }; missing++; }
    else retry++;                                   // unknown: ask again next night
    if (done % 25 === 0) console.log(`  ${done}/${todo.length}: ${found} found, ${missing} missing, ${retry} to retry`);
  }

  let upgraded = 0;
  for (const [key, t] of upgrades) {
    if (Date.now() > deadline) break;
    const r = await itunes(t.artist, t.title);
    if (r.status === 'found') { songs[key] = { ...r.rec, seen: today, checked: today }; upgraded++; }
    else if (r.status === 'missing') songs[key].itunesTried = true;
  }
  if (upgrades.length) console.log(`Upgraded ${upgraded} Deezer songs to iTunes links.`);

  // Forget songs no built-in station has played for a while.
  let pruned = 0;
  for (const [key, s] of Object.entries(songs)) {
    if (daysSince(s.seen) > FORGET_AFTER_DAYS) { delete songs[key]; pruned++; }
  }

  const all = Object.values(songs);
  const coverage = wanted.size ? [...wanted.keys()].filter(k => songs[k]?.status === 'found').length / wanted.size : 0;
  await fs.writeFile(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), songs }));
  console.log(`Done: ${found} found, ${missing} missing, ${retry} retry, ${pruned} pruned.`);
  console.log(`previews.json: ${all.length} songs; ${(coverage * 100).toFixed(1)}% of today's songs playable.`);
}

main().catch(e => { console.error(e); process.exit(1); });
