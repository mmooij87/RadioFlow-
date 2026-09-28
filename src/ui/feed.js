/**
 * The feed — one full-screen song at a time, vertical swipe.
 *
 * Gestures on the cover (each has a tap/keyboard alternative):
 *   tap         play / pause           (also: Space, the play icon)
 *   double-tap  save                   (also: heart button, S key)
 *   long-press  share                  (also: Share in the context menu… and navigator.share)
 *   swipe up    next song              (also: ↓ / J, headphone "next")
 *
 * When a 30-second preview ends, the next song slides in by itself, so it
 * keeps behaving like radio.
 */
import { enrichTrack } from '../services/dataService.js';
import { isFavorite, toggleFavorite, addFavorite, updateFavorite } from '../services/favoritesService.js';
import { playPreview, togglePreview, onAudio } from '../components/audioPlayer.js';
import { findStation } from '../data/stations.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { coverTint } from './color.js';
import { setNowPlaying, setPlaybackState } from './mediaSession.js';
import { SERVICES, getOpenIn, songUrl } from '../services/stationStore.js';

const PREFETCH_AHEAD = 3;
const DOUBLE_TAP_MS = 280;
const LONG_PRESS_MS = 520;
const LEARNED_SWIPE = 'rf_learned_swipe';
const LEARNED_SAVE = 'rf_learned_save';
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const flag = (k) => { try { return !!localStorage.getItem(k); } catch { return true; } };
const setFlag = (k) => { try { localStorage.setItem(k, '1'); } catch {} };

export function createFeed(root, { onTrackChange, onFirstPlay, onReshuffle, isBusy = () => false }) {
  let tracks = [];
  let idx = 0;
  let observer = null;
  let raf = 0;
  let suspended = false;     // true while the Saved sheet borrows the audio
  const audio = document.getElementById('audio-player');

  // ── Audio events → UI ────────────────────────────────────
  onAudio({
    onPlay:  (id) => { if (id === cur()?.id) setPlaying(true); },
    onPause: (id) => { if (id === cur()?.id) setPlaying(false); },
    onEnd:   (id) => {
      if (id !== cur()?.id || suspended) return;
      setPlaying(false);
      // Radio behaviour: roll on to the next song by itself.
      if (audio.ended) setTimeout(() => { if (cur()?.id === id) next(); }, 350);
    },
    onError: ({ id, name }) => {
      if (id !== cur()?.id) return;
      setPlaying(false);
      if (name !== 'NotAllowedError') toast("This preview wouldn't play. Swipe on for the next one.");
    },
  });

  function cur() { return tracks[idx]; }
  function slideAt(i) { return root.querySelector(`.slide[data-i="${i}"]`); }

  // ── Rendering ─────────────────────────────────────────────
  function slideHtml(t, i) {
    const st = findStation(t.stationId) || {};
    const saved = isFavorite(t.id);
    return `
      <section class="slide" data-i="${i}" aria-roledescription="song" aria-label="${esc(t.title)} by ${esc(t.artist)}">
        <div class="slide__stage">
          <button class="art art--loading" aria-label="Play or pause. Double-tap to save.">
            <span class="art__img"></span>
            <span class="art__state">${icon('play', { size: 34 })}</span>
            <span class="art__note">No preview for this one</span>
          </button>
        </div>
        <div class="slide__info">
          <div class="slide__text">
            <h2 class="slide__title">${esc(t.title)}</h2>
            <p class="slide__artist">${esc(t.artist)}<span class="sr-only">, played on ${esc(st.name || t.station)}</span></p>
          </div>
          <button class="save-btn" aria-pressed="${saved}" aria-label="Save song">${icon('heart', { size: 26, filled: saved })}</button>
        </div>
        <div class="slide__bar" aria-hidden="true"><span></span></div>
        <div class="slide__foot">
          <a class="open-link" href="${esc(songUrl(t))}" target="_blank" rel="noopener">${openLabel()} ${icon('external', { size: 16 })}</a>
        </div>
      </section>`;
  }

  const endHtml = () => `
    <section class="slide slide--end" data-end>
      <div class="note">
        <h2>That's the lot</h2>
        <p>You've heard everything we picked from your stations. Shuffle for a fresh mix, or tune in more stations below.</p>
        <button class="pill pill--solid" data-act="reshuffle">${icon('shuffle', { size: 18 })}Shuffle again</button>
      </div>
    </section>`;

  function renderEmpty(kind) {
    teardown();
    tracks = []; idx = 0;
    root.innerHTML = kind === 'no-stations' ? `
      <section class="slide slide--empty">
        <div class="note">
          <h2>What's the world playing?</h2>
          <p>Pick one or more stations on the dial. You'll hear the songs they played in the last 24 hours, one after another.</p>
        </div>
      </section>` : `
      <section class="slide slide--empty">
        <div class="note">
          <h2>Nothing to play yet</h2>
          <p>These stations haven't sent a playlist today. Tune in another station on the dial.</p>
        </div>
      </section>`;
    onTrackChange(null);
  }

  function setTracks(list, { autoplay = true } = {}) {
    teardown();
    tracks = list; idx = 0;
    root.innerHTML = list.map(slideHtml).join('') + endHtml();
    root.scrollTop = 0;
    observeAll();
    activate(0, { autoplay });
    scheduleSwipeHint();
  }

  /** Keep what's been heard + the current song, swap everything after it. */
  function replaceUpcoming(list) {
    if (!tracks.length) { if (list.length) setTracks(list); return; }
    root.querySelectorAll('.slide').forEach(el => {
      const i = el.dataset.i === undefined ? Infinity : +el.dataset.i;
      if (i > idx) el.remove();
    });
    tracks = tracks.slice(0, idx + 1).concat(list);
    root.insertAdjacentHTML('beforeend',
      list.map((t, k) => slideHtml(t, idx + 1 + k)).join('') + endHtml());
    observeAll();
    for (let j = 1; j <= PREFETCH_AHEAD; j++) ensureEnriched(idx + j);
  }

  function observeAll() {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
        if (e.target.dataset.end !== undefined) { onTrackChange(null); pauseQuietly(); continue; }
        const i = +e.target.dataset.i;
        if (i !== idx) activate(i, { autoplay: true });
      }
    }, { root, threshold: 0.6 });
    root.querySelectorAll('.slide').forEach(s => observer.observe(s));
  }

  function teardown() {
    observer?.disconnect(); observer = null;
    cancelAnimationFrame(raf);
  }

  // ── Activation / enrichment ───────────────────────────────
  async function activate(i, { autoplay }) {
    idx = i;
    const t = tracks[i];
    if (!t) return;
    if (i > 0) learnedSwipe();
    onTrackChange(t);
    applyTint(i);
    startProgress();
    const e = await ensureEnriched(i);
    if (i !== idx) return;               // swiped on while loading
    onTrackChange(e);
    if (suspended) return;
    if (e?.previewUrl) {
      setNowPlaying(e);
      if (autoplay) {
        const ok = await playPreview(e.previewUrl, e.id);
        if (ok) onFirstPlay?.();
      } else setPlaying(false);
    } else {
      slideAt(i)?.classList.add('slide--nopreview');
      pauseQuietly();
    }
    for (let j = 1; j <= PREFETCH_AHEAD; j++) ensureEnriched(i + j);
  }

  async function ensureEnriched(i) {
    const t = tracks[i];
    if (!t) return null;
    if (t._enriched) return t;
    if (t._pending) return t._pending;
    t._pending = enrichTrack(t).then(async (e) => {
      const done = { ...e, _enriched: true };
      if (tracks[i]?.id !== t.id) return done;   // list changed meanwhile
      tracks[i] = done;
      paintArt(i, done);
      updateFavorite(done);
      return done;
    });
    return t._pending;
  }

  function paintArt(i, t) {
    const s = slideAt(i);
    if (!s) return;
    const art = s.querySelector('.art');
    const img = s.querySelector('.art__img');
    art.classList.remove('art--loading');
    if (t.coverArt) {
      const pre = new Image();
      pre.onload = () => { img.style.backgroundImage = `url("${t.coverArt}")`; art.classList.add('art--ready'); };
      pre.onerror = () => art.classList.add('art--missing');
      pre.src = t.coverArt;
      coverTint(t.coverArt).then(tint => {
        if (!tint) return;
        s.style.setProperty('--tint', tint);
        if (i === idx) setPageTint(tint);
      });
    } else {
      art.classList.add('art--missing');
    }
    if (!t.previewUrl) s.classList.add('slide--nopreview');
    const link = s.querySelector('.open-link');
    if (link) link.href = songUrl(t);
  }

  function applyTint(i) {
    const tint = slideAt(i)?.style.getPropertyValue('--tint');
    setPageTint(tint || '');
  }

  function setPageTint(tint) {
    document.documentElement.style.setProperty('--page-tint', tint || 'var(--base)');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && tint) meta.content = getComputedStyle(document.body).backgroundColor;
  }

  // ── Playback UI ───────────────────────────────────────────
  function setPlaying(on) {
    const s = slideAt(idx);
    root.querySelectorAll('.slide--playing').forEach(el => { if (el !== s) el.classList.remove('slide--playing'); });
    if (!s) return;
    s.classList.toggle('slide--playing', on);
    const st = s.querySelector('.art__state');
    if (st) st.innerHTML = icon(on ? 'pause' : 'play', { size: 34 });
    setPlaybackState(on ? 'playing' : 'paused');
  }

  function pauseQuietly() { if (!audio.paused) audio.pause(); }

  function startProgress() {
    cancelAnimationFrame(raf);
    root.querySelectorAll('.slide__bar span').forEach(b => { b.style.transform = 'scaleX(0)'; });
    const bar = slideAt(idx)?.querySelector('.slide__bar span');
    const myId = cur()?.id;
    const tick = () => {
      if (cur()?.id !== myId) return;
      const d = audio.duration;
      if (bar && d && isFinite(d) && !suspended) bar.style.transform = `scaleX(${Math.min(1, audio.currentTime / d)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  async function togglePlay() {
    const t = cur();
    if (!t) return;
    const e = t._enriched ? t : await ensureEnriched(idx);
    if (!e?.previewUrl) { toast('No preview for this one. Swipe on.'); return; }
    const src = audio.currentSrc || audio.src;
    if (src !== e.previewUrl) { await playPreview(e.previewUrl, e.id); onFirstPlay?.(); }
    else togglePreview();
    flashState();
  }

  function flashState() {
    const s = slideAt(idx);
    if (!s || reduceMotion()) return;
    s.classList.remove('slide--flash'); void s.offsetWidth; s.classList.add('slide--flash');
  }

  function go(i) {
    const s = slideAt(i) || (i >= tracks.length ? root.querySelector('[data-end]') : null);
    s?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }
  const next = () => go(idx + 1);
  const prev = () => go(Math.max(0, idx - 1));

  // ── Saving ────────────────────────────────────────────────
  function save({ onlyAdd = false, point = null } = {}) {
    const t = cur();
    if (!t) return;
    let saved;
    if (onlyAdd) {
      if (isFavorite(t.id)) { burst(point); return; }   // double-tap never un-saves
      addFavorite(t); saved = true;
    } else {
      saved = toggleFavorite(t);
    }
    const btn = slideAt(idx)?.querySelector('.save-btn');
    if (btn) {
      btn.setAttribute('aria-pressed', String(saved));
      btn.innerHTML = icon('heart', { size: 26, filled: saved });
    }
    if (saved) {
      setFlag(LEARNED_SAVE);
      navigator.vibrate?.(12);
      burst(point);
      flyToSaved();
    }
  }

  function burst(point) {
    if (reduceMotion()) return;
    const art = slideAt(idx)?.querySelector('.art');
    if (!art) return;
    const r = art.getBoundingClientRect();
    const x = point ? point.x : r.left + r.width / 2;
    const y = point ? point.y : r.top + r.height / 2;
    const h = document.createElement('div');
    h.className = 'burst';
    h.innerHTML = icon('heart', { size: 96 });
    h.style.left = `${x}px`; h.style.top = `${y}px`;
    document.body.appendChild(h);
    h.animate([
      { transform: 'translate(-50%,-50%) scale(.3)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.1)', opacity: 1, offset: .35 },
      { transform: 'translate(-50%,-70%) scale(1)', opacity: 0 },
    ], { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.then(() => h.remove());
  }

  /** A tiny copy of the cover arcs into the Saved counter: shows where it went. */
  function flyToSaved() {
    const target = document.getElementById('saved-btn');
    const img = slideAt(idx)?.querySelector('.art__img');
    if (!target || !img || reduceMotion()) return;
    const a = img.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const f = document.createElement('div');
    f.className = 'flyer';
    f.style.backgroundImage = img.style.backgroundImage;
    Object.assign(f.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
    document.body.appendChild(f);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2);
    const dy = b.top + b.height / 2 - (a.top + a.height / 2);
    f.animate([
      { transform: 'translate(0,0) scale(1)', opacity: .9, borderRadius: '10px' },
      { transform: `translate(${dx * .55}px, ${dy * .35 - 60}px) scale(.35)`, opacity: .9, offset: .55 },
      { transform: `translate(${dx}px, ${dy}px) scale(.06)`, opacity: .4, borderRadius: '50%' },
    ], { duration: 620, easing: 'cubic-bezier(.5,0,.3,1)' }).finished.then(() => {
      f.remove();
      target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 280 });
    });
  }

  async function share() {
    const t = cur();
    if (!t) return;
    const text = `${t.title} by ${t.artist}, heard on ${t.station} via RadioFlow`;
    const url = songUrl(t);
    if (navigator.share) {
      navigator.share({ title: `${t.title} by ${t.artist}`, text, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(`${text}\n${url}`).then(() => toast('Link copied')).catch(() => {});
    }
  }

  // ── First-run hints ───────────────────────────────────────
  // The first song teaches the swipe: the song nudges up to reveal the
  // next one while a fingertip traces the gesture, until the listener
  // swipes once. After that, a single nudge about double-tap to save.
  const hintEl = document.getElementById('swipe-hint');
  let hintTimer = 0, peekTimer = 0;

  function scheduleSwipeHint() {
    if (flag(LEARNED_SWIPE) || !hintEl) return;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(showSwipeHint, 1400);
  }

  function showSwipeHint() {
    if (flag(LEARNED_SWIPE) || idx !== 0 || tracks.length < 2) return;
    if (isBusy()) { hintTimer = setTimeout(showSwipeHint, 1500); return; }
    const touch = matchMedia('(pointer: coarse)').matches;
    hintEl.className = 'swipe-hint';
    hintEl.innerHTML = `
      <span class="swipe-hint__finger" aria-hidden="true"><span class="swipe-hint__dot"></span></span>
      <span class="swipe-hint__text">${touch ? 'Swipe up for the next song' : 'Scroll or press ↓ for the next song'}</span>`;
    hintEl.hidden = false;
    peek();
    clearInterval(peekTimer);
    peekTimer = setInterval(() => { if (!isBusy()) peek(); }, 5200);
  }

  function peek() {
    if (reduceMotion() || idx !== 0) return;
    const a = slideAt(0), b = slideAt(1);
    [a, b].forEach(el => { if (!el) return; el.classList.remove('slide--peek'); void el.offsetWidth; el.classList.add('slide--peek'); });
  }

  function learnedSwipe() {
    if (flag(LEARNED_SWIPE)) return;
    setFlag(LEARNED_SWIPE);
    clearTimeout(hintTimer); clearInterval(peekTimer);
    root.querySelectorAll('.slide--peek').forEach(el => el.classList.remove('slide--peek'));
    if (hintEl) hintEl.hidden = true;
    if (!flag(LEARNED_SAVE)) setTimeout(showSaveHint, 2200);
  }

  function showSaveHint() {
    if (flag(LEARNED_SAVE) || !hintEl || isBusy()) return;
    setFlag(LEARNED_SAVE);
    const touch = matchMedia('(pointer: coarse)').matches;
    hintEl.className = 'swipe-hint swipe-hint--save';
    hintEl.innerHTML = `
      <span class="swipe-hint__heart" aria-hidden="true">${icon('heart', { size: 22 })}</span>
      <span class="swipe-hint__text">${touch ? 'Double-tap the cover to save a song' : 'Double-click the cover (or press S) to save a song'}</span>`;
    hintEl.hidden = false;
    setTimeout(() => { if (hintEl.classList.contains('swipe-hint--save')) hintEl.hidden = true; }, 4200);
  }

  // ── Gestures on the cover ─────────────────────────────────
  let press = null;       // { x, y, timer, long }
  let lastTap = null;     // { t, x, y }
  let singleTimer = null;

  root.addEventListener('pointerdown', (e) => {
    const art = e.target.closest('.art');
    if (!art || e.button > 0) return;
    press = { x: e.clientX, y: e.clientY, long: false };
    press.timer = setTimeout(() => {
      press.long = true;
      navigator.vibrate?.(8);
      share();
    }, LONG_PRESS_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
  });
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  root.addEventListener('pointercancel', cancelPress);
  root.addEventListener('scroll', cancelPress, { passive: true });

  root.addEventListener('pointerup', (e) => {
    if (!press) return;
    clearTimeout(press.timer);
    const wasLong = press.long;
    press = null;
    if (wasLong) return;
    if (!e.target.closest('.art')) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(singleTimer); lastTap = null;
      save({ onlyAdd: true, point: { x: e.clientX, y: e.clientY } });
    } else {
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      singleTimer = setTimeout(() => { lastTap = null; togglePlay(); }, DOUBLE_TAP_MS);
    }
  });
  root.addEventListener('contextmenu', (e) => { if (e.target.closest('.art')) e.preventDefault(); });

  root.addEventListener('click', (e) => {
    // Keyboard activation of the cover (Enter/Space) arrives as a click with detail 0.
    if (e.target.closest('.art') && e.detail === 0) { togglePlay(); return; }
    if (e.target.closest('.save-btn')) { save(); return; }
    if (e.target.closest('[data-act="reshuffle"]')) onReshuffle?.();
  });

  return {
    setTracks, replaceUpcoming, renderEmpty, next, prev, togglePlay, save, share,
    playedIds: () => new Set(tracks.slice(0, idx + 1).map(t => t.id)),
    hasTracks: () => tracks.length > 0,
    current: cur,
    suspend() { suspended = true; setPlaying(false); },
    resume(wasPlaying) {
      suspended = false;
      const t = cur();
      if (!t?.previewUrl) return;
      setNowPlaying(t);
      startProgress();
      if (wasPlaying) playPreview(t.previewUrl, t.id);
      else setPlaying(false);
    },
    isPlaying: () => !audio.paused && audio.src === cur()?.previewUrl,
    refreshLinks() {
      root.querySelectorAll('.slide[data-i]').forEach(s => {
        const t = tracks[+s.dataset.i];
        const a = s.querySelector('.open-link');
        if (t && a) { a.href = songUrl(t); a.innerHTML = `${openLabel()} ${icon('external', { size: 16 })}`; }
      });
    },
    refreshSaved() {
      root.querySelectorAll('.slide[data-i]').forEach(s => {
        const t = tracks[+s.dataset.i];
        const btn = s.querySelector('.save-btn');
        if (!t || !btn) return;
        const saved = isFavorite(t.id);
        if (btn.getAttribute('aria-pressed') !== String(saved)) {
          btn.setAttribute('aria-pressed', String(saved));
          btn.innerHTML = icon('heart', { size: 26, filled: saved });
        }
      });
    },
  };
}

function openLabel() { return `Open in ${SERVICES[getOpenIn()].label}`; }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
