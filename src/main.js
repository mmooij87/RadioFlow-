/**
 * RadioFlow — one screen: the song, and the dial.
 */
import './styles/app.css';
import { STATIONS, findStation } from './data/stations.js';
import { buildMix, stationTrackCounts } from './services/dataService.js';
import { getFavorites, onFavoritesChange } from './services/favoritesService.js';
import { primeAudio, playPreview, stopPreview } from './components/audioPlayer.js';
import { createDial } from './ui/dial.js';
import { createFeed } from './ui/feed.js';
import { createSavedSheet } from './ui/savedSheet.js';
import { initMediaSession } from './ui/mediaSession.js';
import { hydrateIcons } from './ui/icons.js';
import { toast } from './ui/toast.js';

const SELECTED_KEY = 'radioflow_stations';
const COACH_KEY = 'rf_coach_swipe_v1';

// ── State ───────────────────────────────────────────────────
const known = new Set(STATIONS.map(s => s.id));
let selected;
try { selected = new Set(JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]').filter(id => known.has(id))); }
catch { selected = new Set(); }
const persist = () => { try { localStorage.setItem(SELECTED_KEY, JSON.stringify([...selected])); } catch {} };
let counts = {};

hydrateIcons();

// ── Feed ────────────────────────────────────────────────────
const feed = createFeed(document.getElementById('feed'), {
  onTrackChange: (t) => dial.setNeedle(t?.stationId || null),
  onFirstPlay: maybeCoach,
  onReshuffle: () => rebuild({ fresh: true }),
});

// ── Dial ────────────────────────────────────────────────────
const dial = createDial(document.getElementById('dial'), {
  stations: STATIONS,
  selected,
  onToggle(id, on) {
    // This tap is a user gesture: unlock audio for mobile browsers now,
    // synchronously, before any await.
    primeAudio();
    if (on) selected.add(id); else selected.delete(id);
    persist();
    dial.render();
    const st = findStation(id);
    if (on && counts[id] === 0) toast(`${st.name} hasn't sent a playlist today`);
    rebuild({ fresh: !feed.hasTracks() });
  },
});

async function rebuild({ fresh }) {
  if (!selected.size) {
    if (!feed.hasTracks() || fresh) { stopPreview(); feed.renderEmpty('no-stations'); }
    else feed.replaceUpcoming([]);   // keep the current song, drop what's queued
    return;
  }
  const mix = await buildMix([...selected], fresh ? new Set() : feed.playedIds());
  if (fresh || !feed.hasTracks()) {
    if (mix.length) feed.setTracks(mix);
    else feed.renderEmpty('no-data');
  } else {
    feed.replaceUpcoming(mix);
  }
}

// ── Saved sheet ─────────────────────────────────────────────
let wasPlaying = false;
const sheet = createSavedSheet(document.getElementById('saved-sheet'), {
  onPreview(track) {
    if (track) { feed.suspend(); playPreview(track.previewUrl, `saved:${track.id}`); }
    else stopPreview();
  },
  onClose() {
    feed.resume(wasPlaying);
    if (location.hash === '#saved') history.replaceState(null, '', location.pathname + location.search);
  },
});
const savedBtn = document.getElementById('saved-btn');
savedBtn.addEventListener('click', openSaved);
function openSaved() {
  wasPlaying = feed.isPlaying();
  sheet.open();
}

function syncCount() {
  const n = getFavorites().length;
  const el = document.getElementById('saved-count');
  el.textContent = String(n);
  savedBtn.classList.toggle('saved-btn--has', n > 0);
  savedBtn.setAttribute('aria-label', `Saved songs: ${n}`);
  feed.refreshSaved();
}
onFavoritesChange(syncCount);
syncCount();

// ── Keyboard ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (sheet.isOpen || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, .dial')) return;
  const k = e.key;
  if (k === ' ' && !e.target.closest('button, a')) { e.preventDefault(); feed.togglePlay(); }
  else if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); feed.next(); }
  else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); feed.prev(); }
  else if (k === 's' || k === 'l') feed.save();
});

// ── Lock screen / headphones ───────────────────────────────
initMediaSession({
  onPlay: () => feed.togglePlay(),
  onPause: () => feed.togglePlay(),
  onNext: () => feed.next(),
  onPrev: () => feed.prev(),
});

// ── One-time gesture coach ─────────────────────────────────
function maybeCoach() {
  try { if (localStorage.getItem(COACH_KEY)) return; } catch { return; }
  const coach = document.getElementById('coach');
  const touch = matchMedia('(pointer: coarse)').matches;
  coach.innerHTML = touch
    ? '<span data-icon="up" data-size="18"></span>Swipe up for the next song. Double-tap to save.'
    : '<span data-icon="up" data-size="18"></span>Scroll or press ↓ for the next song. Double-click to save.';
  hydrateIcons(coach);
  setTimeout(() => { coach.hidden = false; }, 1600);
  const done = () => {
    coach.hidden = true;
    try { localStorage.setItem(COACH_KEY, '1'); } catch {}
    document.getElementById('feed').removeEventListener('scroll', done);
  };
  document.getElementById('feed').addEventListener('scroll', done, { passive: true, once: true });
  setTimeout(done, 9000);
}

// ── Boot ────────────────────────────────────────────────────
(async () => {
  counts = await stationTrackCounts();
  dial.setCounts(counts);
  if (location.hash === '#saved' || location.hash === '#/liked') openSaved();
  await rebuild({ fresh: true });
})();
