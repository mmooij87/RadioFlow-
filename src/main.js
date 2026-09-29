/**
 * RadioFlow — one screen: the song, and the dial.
 */
import './styles/app.css';
import { buildMix, knownCounts, stationTrackCounts, stationSongs } from './services/dataService.js';
import { getFavorites, onFavoritesChange } from './services/favoritesService.js';
import {
  getMyStations, getSelected, onStoreChange, findMyStation,
  getSolo, soloStation, restoreFromSolo,
} from './services/stationStore.js';
import { primeAudio, playPreview, stopPreview } from './components/audioPlayer.js';
import { createDial } from './ui/dial.js';
import { createFeed } from './ui/feed.js';
import { createSavedSheet } from './ui/savedSheet.js';
import { createSettingsSheet } from './ui/settingsSheet.js';
import { initMediaSession } from './ui/mediaSession.js';
import { hydrateIcons } from './ui/icons.js';
import { toast } from './ui/toast.js';

hydrateIcons();

let savedSheet = null;
let settings = null;
const anySheetOpen = () => !!(savedSheet?.isOpen || settings?.isOpen);
const onStations = () => getMyStations().filter(s => getSelected().has(s.id));

// ── Feed ────────────────────────────────────────────────────
const feed = createFeed(document.getElementById('feed'), {
  onTrackChange: (t) => dial.setNeedle(t?.stationId || null),
  onReshuffle: () => rebuild({ fresh: true }),
  getStationSongs: songsOf,
  isBusy: anySheetOpen,
});

// A station's playlist, for swiping sideways through it. Cached per session.
const songCache = new Map();
function songsOf(stationId) {
  if (!songCache.has(stationId)) {
    const st = findMyStation(stationId);
    songCache.set(stationId, st ? stationSongs(st) : Promise.resolve([]));
  }
  return songCache.get(stationId);
}

// ── Dial ────────────────────────────────────────────────────
const dial = createDial(document.getElementById('dial'), {
  // Tap a station: hear only that one. Tap it again: everything plays.
  onTune(id) {
    primeAudio();     // a tap is a user gesture: unlock mobile audio right now
    if (getSolo() === id) { restoreFromSolo(); return; }
    const st = findMyStation(id);
    if (knownCounts()[id] === 0) { toast(`${st?.name || 'This station'} hasn't shared a song list today`); return; }
    jumpToStation = id;             // leave the current song if it's from elsewhere
    soloStation(id);
    if (!hasLearned(SOLO_TIP)) {
      learned(SOLO_TIP);
      setTimeout(() => toast(`Only ${st?.name || 'this station'} now. Swipe the dial to hear all stations again.`, 4200), 500);
    }
  },
  onUnsolo() { primeAudio(); restoreFromSolo(); },
  onAdd: () => settings.openSearch(),
});

// One-time explainer the first time someone tunes in to a single station.
const SOLO_TIP = 'rf_learned_solo';
const learned = (k) => { try { localStorage.setItem(k, '1'); } catch {} };
const hasLearned = (k) => { try { return !!localStorage.getItem(k); } catch { return true; } };
let jumpToStation = null;

function syncDial() {
  dial.setStations(getMyStations(), getSelected());
  dial.setSolo(getSolo());
  dial.setCounts(knownCounts());
}

// Rebuild the upcoming songs whenever the dial changes.
let rebuildTimer = 0;
onStoreChange((what) => {
  if (what === 'openIn') { feed.refreshLinks(); return; }
  if (what === 'stations') { songCache.clear(); syncDial(); }
  else { dial.setSelected(getSelected()); dial.setSolo(getSolo()); }
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => rebuild({ fresh: !feed.hasTracks() }), 150);
});

async function rebuild({ fresh }) {
  const stations = onStations();
  if (!stations.length) {
    if (!feed.hasTracks() || fresh) { stopPreview(); feed.renderEmpty('no-stations'); }
    else feed.replaceUpcoming([]);   // keep the current song, drop what's queued
    return;
  }
  const mix = await buildMix(stations, fresh ? new Set() : feed.playedIds());
  dial.setCounts(knownCounts());
  if (fresh || !feed.hasTracks()) {
    if (mix.length) feed.setTracks(mix);
    else feed.renderEmpty('no-data');
  } else {
    feed.replaceUpcoming(mix);
    // Soloing a station: don't make the listener sit out a song from elsewhere.
    if (jumpToStation && feed.current()?.stationId !== jumpToStation && mix.length) feed.next();
  }
  jumpToStation = null;
}

// ── Sheets ──────────────────────────────────────────────────
let wasPlaying = false;
savedSheet = createSavedSheet(document.getElementById('saved-sheet'), {
  onPreview(track) {
    if (track) { feed.suspend(); playPreview(track.previewUrl, `saved:${track.id}`); }
    else stopPreview();
  },
  onClose() {
    feed.resume(wasPlaying);
    if (location.hash === '#saved') history.replaceState(null, '', location.pathname + location.search);
  },
});
settings = createSettingsSheet(document.getElementById('settings-sheet'), {
  onClose() {},
});

const savedBtn = document.getElementById('saved-btn');
savedBtn.addEventListener('click', () => { wasPlaying = feed.isPlaying(); savedSheet.open(); });
document.getElementById('settings-btn').addEventListener('click', () => settings.open());

function syncCount() {
  const n = getFavorites().length;
  document.getElementById('saved-count').textContent = String(n);
  savedBtn.classList.toggle('saved-btn--has', n > 0);
  savedBtn.setAttribute('aria-label', `Saved songs: ${n}`);
  feed.refreshSaved();
}
onFavoritesChange(syncCount);
syncCount();

// ── Keyboard ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (anySheetOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea')) return;
  const k = e.key;
  if (k === ' ' && !e.target.closest('button, a')) { e.preventDefault(); feed.togglePlay(); }
  else if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); feed.next(); }
  else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); feed.prev(); }
  else if (k === 'ArrowRight') { e.preventDefault(); feed.browse(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); feed.browse(-1); }
  else if (k === 's' || k === 'l') feed.save();
});

// ── Lock screen / headphones ───────────────────────────────
initMediaSession({
  onPlay: () => feed.togglePlay(),
  onPause: () => feed.togglePlay(),
  onNext: () => feed.next(),
  onPrev: () => feed.prev(),
});

// ── Boot ────────────────────────────────────────────────────
(async () => {
  syncDial();
  dial.setCounts(await stationTrackCounts());
  if (location.hash === '#saved' || location.hash === '#/liked') { wasPlaying = false; savedSheet.open(); }
  await rebuild({ fresh: true });
})();
