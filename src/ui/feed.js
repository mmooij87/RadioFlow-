/**
 * The feed — one full-screen song at a time, vertical swipe.
 *
 * Gestures on the cover (each has a tap/keyboard alternative):
 *   tap         play / pause           (also: Space, the play icon)
 *   double-tap  save                   (also: heart button, S key)
 *   long-press  share                  (also: Share in the context menu… and navigator.share)
 *   swipe up    next song in the mix   (also: ↓ / J, headphone "next")
 *   swipe side  more from this station (also: ← / →)
 *
 * When a 30-second preview ends, the next song slides in by itself, so it
 * keeps behaving like radio.
 */
import { enrichTrack, reresolve } from '../services/dataService.js';
import { isFavorite, toggleFavorite, addFavorite, updateFavorite } from '../services/favoritesService.js';
import { playPreview, togglePreview, onAudio } from '../components/audioPlayer.js';
import { findStation } from '../data/stations.js';
import { icon } from './icons.js';
import { toast } from './toast.js';
import { coverTint } from './color.js';
import { setNowPlaying, setPlaybackState } from './mediaSession.js';
import { SERVICES, getOpenIn, songUrl } from '../services/stationStore.js';

const PREFETCH_AHEAD = 4;
const TOP_UP_AT = 8;         // songs left before the mix tops itself up
const DOUBLE_TAP_MS = 280;
const LONG_PRESS_MS = 520;
const LEARNED_SWIPE = 'rf_learned_swipe';
const LEARNED_SAVE = 'rf_learned_save';
const LEARNED_SIDE = 'rf_learned_side';
const DRAG_START = 12;       // px before a sideways drag takes over
const DRAG_COMMIT = 70;      // px (or a fast flick) to move to the next song
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const flag = (k) => { try { return !!localStorage.getItem(k); } catch { return true; } };
const setFlag = (k) => { try { localStorage.setItem(k, '1'); } catch {} };

export function createFeed(root, { onTrackChange, onFirstPlay, onReshuffle, onNeedMore, getStationSongs, isBusy = () => false }) {
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
    onError: async ({ id, name }) => {
      if (id !== cur()?.id) return;
      setPlaying(false);
      if (name === 'NotAllowedError') return;       // autoplay blocked: the play button handles it
      // Most often an expired preview link: look it up afresh once, else skip it.
      const i = idx, t = tracks[i];
      if (t && !t._retried) {
        const fresh = await reresolve(t);
        if (fresh?.previewUrl && tracks[i]?.id === t.id) {
          tracks[i] = { ...fresh, _enriched: true, _retried: true };
          if (i === idx) { playPreview(fresh.previewUrl, fresh.id); return; }
        }
      }
      if (i === idx) hideSlide(i);
    },
  });

  function cur() { return tracks[idx]; }
  function slideAt(i) { return root.querySelector(`.slide[data-i="${i}"]`); }

  // ── Rendering ─────────────────────────────────────────────
  function slideHtml(t, i) {
    return `
      <section class="slide" data-i="${i}" aria-roledescription="song" aria-label="${esc(t.title)} by ${esc(t.artist)}">
        ${slideInner(t)}
      </section>`;
  }

  function slideInner(t) {
    const st = findStation(t.stationId) || {};
    const saved = isFavorite(t.id);
    return `
        <div class="slide__stage">
          <button class="art art--loading" aria-label="Play or pause. Double-tap to save.">
            <span class="art__img"></span>
            <span class="art__state">${icon('play', { size: 34 })}</span>
            <span class="art__note">No preview for this one</span>
          </button>
        </div>
        <div class="slide__info">
          <div class="slide__text">
            <p class="slide__from"><span class="slide__from-name">${esc(st.name || t.station)}</span><span class="slide__pos"></span></p>
            <h2 class="slide__title">${esc(t.title)}</h2>
            <p class="slide__artist">${esc(t.artist)}</p>
          </div>
          <button class="save-btn" aria-pressed="${saved}" aria-label="Save song">${icon('heart', { size: 26, filled: saved })}</button>
        </div>
        <div class="slide__bar" aria-hidden="true"><span></span></div>
        <div class="slide__foot">
          <a class="open-link" href="${esc(songUrl(t))}" target="_blank" rel="noopener">${openLabel()} ${icon('external', { size: 16 })}</a>
        </div>`;
  }

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
    root.innerHTML = list.map(slideHtml).join('');
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
    root.insertAdjacentHTML('beforeend', list.map((t, k) => slideHtml(t, idx + 1 + k)).join(''));
    observeAll();
    prefetchAhead(idx);
  }

  /** Endless: when the mix runs low, add a fresh round after it. */
  let toppingUp = false;
  async function topUp() {
    if (toppingUp || !onNeedMore) return;
    const left = tracks.slice(idx + 1).filter(t => !t._gone).length;
    if (left > TOP_UP_AT) return;
    toppingUp = true;
    try {
      const more = await onNeedMore();
      if (!more?.length) return;
      // Don't repeat the song that's on right now as the very next one.
      if (more[0]?.id === tracks[tracks.length - 1]?.id) more.push(more.shift());
      const start = tracks.length;
      tracks = tracks.concat(more);
      root.insertAdjacentHTML('beforeend', more.map((t, k) => slideHtml(t, start + k)).join(''));
      root.querySelectorAll('.slide[data-i]').forEach(el => { if (+el.dataset.i >= start) observer?.observe(el); });
    } finally {
      toppingUp = false;
    }
  }

  function prefetchAhead(from) {
    let n = 0;
    for (let j = from + 1; j < tracks.length && n < PREFETCH_AHEAD; j++) {
      if (tracks[j]._gone) continue;
      ensureEnriched(j); n++;
    }
  }

  function observeAll() {
    observer?.disconnect();
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || e.intersectionRatio < 0.6) continue;
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
    setTimeout(maybeSideHint, 1800);
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
      // Nothing to hear: take it out of the list and move on.
      pauseQuietly();
      hideSlide(i);
    }
    prefetchAhead(i);
    topUp();
    prefetchNeighbours(e || t);
  }

  /** Take a song with no preview out of the list. */
  function hideSlide(i) {
    const s = slideAt(i);
    if (!s || !tracks[i] || i < idx) return;     // never shift what's above the listener
    tracks[i]._gone = true;
    s.hidden = true;
    if (i === idx) {
      // The next song now sits where this one was; make it the current one.
      const j = nextVisible(i, 1);
      if (j !== null) requestAnimationFrame(() => { slideAt(j)?.scrollIntoView({ block: 'start' }); activate(j, { autoplay: true }); });
      else topUp();
    }
  }

  function nextVisible(from, dir) {
    for (let j = from + dir; j >= 0 && j < tracks.length; j += dir) if (!tracks[j]?._gone) return j;
    return null;
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
    if (!t.previewUrl && i > idx) { hideSlide(i); return; }
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
    slideAt(i)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  }
  const next = () => { const j = nextVisible(idx, 1); if (j !== null) go(j); else topUp().then(() => { const k = nextVisible(idx, 1); if (k !== null) go(k); }); };
  const prev = () => { const j = nextVisible(idx, -1); if (j !== null) go(j); };

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

  let songsSeen = 0;
  function maybeSideHint() {
    songsSeen++;
    if (songsSeen < 3 || flag(LEARNED_SIDE) || !flag(LEARNED_SWIPE) || !hintEl || isBusy()) return;
    if (!hintEl.hidden) return;
    setFlag(LEARNED_SIDE);
    const t = cur();
    const touch = matchMedia('(pointer: coarse)').matches;
    hintEl.className = 'swipe-hint swipe-hint--side';
    hintEl.innerHTML = `
      <span class="swipe-hint__finger swipe-hint__finger--side" aria-hidden="true"><span class="swipe-hint__dot"></span></span>
      <span class="swipe-hint__text">${touch ? 'Swipe the cover sideways' : 'Drag the cover sideways (or press ← →)'} for more from ${esc(t?.station || 'this station')}</span>`;
    hintEl.hidden = false;
    const art = slideAt(idx)?.querySelector('.art');
    if (art && !reduceMotion()) {
      art.animate([{ transform: 'none' }, { transform: 'translateX(-46px) rotate(-1.5deg)' }, { transform: 'none' }],
        { duration: 1100, easing: 'cubic-bezier(.45,0,.2,1)', delay: 300 });
    }
    setTimeout(() => { if (hintEl.classList.contains('swipe-hint--side')) hintEl.hidden = true; }, 5000);
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

  // ── Sideways: more from this station ──────────────────────
  let browsing = false;

  function endDrag(commit) {
    if (!drag) return;
    const { art, dx } = drag;
    drag = null;
    art.classList.remove('art--dragging');
    if (commit) browse(dx < 0 ? 1 : -1, { fromDrag: art, dx });
    else art.animate([{ transform: art.style.transform || 'none' }, { transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }).finished.then(() => { art.style.transform = ''; });
    if (!commit) art.style.transform = '';
  }

  /**
   * Replace the current song with the next (+1, swipe left) or previous
   * (-1, swipe right) song from the same station's playlist. The vertical
   * mix carries on from here afterwards.
   */
  async function browse(dir, { fromDrag = null, dx = 0 } = {}) {
    const t = cur();
    const s = slideAt(idx);
    if (!t || !s || browsing || !getStationSongs) { resetArt(fromDrag); return; }
    browsing = true;
    const art = s.querySelector('.art');
    try {
      const list = await getStationSongs(t.stationId);
      if (list.length < 2) { bounce(art, dir, fromDrag); return; }
      let pos = list.findIndex(x => x.id === t.id);
      if (pos < 0) pos = dir > 0 ? -1 : 0;
      // Walk the station's playlist (wrapping round at either end) until we
      // find a song we can actually play.
      art.classList.add('art--seeking');
      let found = null, foundPos = -1;
      for (let step = 1; step <= Math.min(list.length - 1, 12) && !found; step++) {
        const p = ((pos + dir * step) % list.length + list.length) % list.length;
        const e = await enrichTrack({ ...list[p] });
        if (e?.previewUrl) { found = { ...e, _enriched: true }; foundPos = p; }
      }
      art.classList.remove('art--seeking');
      if (!found) {
        bounce(art, dir, fromDrag);
        toast(`Couldn't find more playable songs from ${t.station} right now`);
        return;
      }
      setFlag(LEARNED_SIDE);
      await swapSlide(idx, found, dir, fromDrag, dx);
      showPos(s, foundPos, list.length);
      paintArt(idx, found);
      activate(idx, { autoplay: true });
    } finally {
      art?.classList.remove('art--seeking');
      browsing = false;
    }
  }

  /** Warm up the songs either side in this station's playlist. */
  async function prefetchNeighbours(t) {
    if (!t || !getStationSongs) return;
    const list = await getStationSongs(t.stationId).catch(() => []);
    const pos = list.findIndex(x => x.id === t.id);
    if (pos < 0 || list.length < 2) return;
    enrichTrack({ ...list[(pos + 1) % list.length] });
    enrichTrack({ ...list[(pos - 1 + list.length) % list.length] });
  }

  function resetArt(art) { if (art) art.style.transform = ''; }

  function bounce(art, dir, fromDrag) {
    if (!art) return;
    const from = fromDrag ? art.style.transform || 'none' : 'none';
    art.style.transform = '';
    if (reduceMotion()) return;
    art.animate([
      { transform: from },
      { transform: `translateX(${dir > 0 ? -24 : 24}px)` },
      { transform: 'none' },
    ], { duration: 360, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }

  async function swapSlide(i, t, dir, fromDrag, dx) {
    const s = slideAt(i);
    const oldArt = s.querySelector('.art');
    const w = oldArt.getBoundingClientRect().width;
    const out = dir > 0 ? -1 : 1;           // swipe left → old cover leaves to the left
    if (!reduceMotion()) {
      await oldArt.animate([
        { transform: fromDrag ? oldArt.style.transform : 'none', opacity: 1 },
        { transform: `translateX(${out * (w + 40)}px) rotate(${out * 6}deg)`, opacity: 0 },
      ], { duration: 190, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished;
    }
    tracks[i] = t;
    s.className = 'slide';
    s.style.removeProperty('--tint');
    s.setAttribute('aria-label', `${t.title} by ${t.artist}`);
    s.innerHTML = slideInner(t);
    const art = s.querySelector('.art');
    if (!reduceMotion()) {
      art.animate([
        { transform: `translateX(${-out * (w * .6)}px)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      s.querySelector('.slide__info')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 });
    }
  }

  function showPos(s, pos, total) {
    const el = s?.querySelector('.slide__pos');
    if (el) el.textContent = ` · ${pos + 1} of ${total}`;
  }

  // ── Gestures on the cover ─────────────────────────────────
  let press = null;       // { x, y, timer, long }
  let lastTap = null;     // { t, x, y }
  let singleTimer = null;

  let drag = null;        // { art, id, x, y, t, dx, active }

  root.addEventListener('pointerdown', (e) => {
    const art = e.target.closest('.art');
    if (!art || e.button > 0) return;
    drag = { art, id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, active: false };
    press = { x: e.clientX, y: e.clientY, long: false };
    press.timer = setTimeout(() => {
      press.long = true;
      navigator.vibrate?.(8);
      share();
    }, LONG_PRESS_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) { clearTimeout(press.timer); press = null; }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) < DRAG_START || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      drag.active = true;
      try { drag.art.setPointerCapture(e.pointerId); } catch {}
      drag.art.classList.add('art--dragging');
      clearTimeout(singleTimer); lastTap = null;
    }
    drag.dx = dx;
    drag.art.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
  });
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  root.addEventListener('pointercancel', () => { cancelPress(); endDrag(false); });
  root.addEventListener('scroll', cancelPress, { passive: true });

  root.addEventListener('pointerup', (e) => {
    if (drag?.active) {
      const dt = performance.now() - drag.t;
      const fast = Math.abs(drag.dx) > 30 && Math.abs(drag.dx) / dt > 0.5;
      endDrag(Math.abs(drag.dx) > DRAG_COMMIT || fast);
      cancelPress();
      return;
    }
    drag = null;
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
    browse: (dir) => browse(dir),
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
