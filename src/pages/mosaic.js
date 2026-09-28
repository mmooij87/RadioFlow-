/**
 * Feed — vertical swipe, Rams aesthetic.
 *
 * Tracks come back from buildMosaic() with just artist+title+stationId;
 * cover art and the 30-second preview URL are fetched on demand from
 * iTunes the moment a slide enters view, with the next slides
 * pre-fetched in parallel so swipes feel instant.
 *
 * Tap the cover to play / pause. If the browser blocks autoplay (e.g. the
 * app was opened straight onto the feed, without a Generate tap), the
 * slide shows a play button instead of an error.
 */
import { buildMosaic, enrichTrack } from '../services/dataService.js';
import { isFavorite, toggleFavorite, updateFavorite } from '../services/favoritesService.js';
import { playPreview, stopPreview, togglePreview, onAudio } from '../components/audioPlayer.js';
import { findStation } from '../data/stations.js';

const PREFETCH_AHEAD = 3;

let tracks = [];
let currentIndex = 0;
let progressTimer = null;
let audioUnsub = null;
let scrollEl = null;
let observer = null;

export function clearFeed() {
  tracks = [];
  currentIndex = 0;
}

/** Hand over a freshly built mix (from the Generate overlay) so we don't rebuild it. */
export function setFeedTracks(list) {
  tracks = Array.isArray(list) ? list : [];
  currentIndex = 0;
}

/** Tear down timers/observers/listeners when navigating away from the feed. */
export function leaveFeed() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  if (observer) { observer.disconnect(); observer = null; }
  if (audioUnsub) { audioUnsub(); audioUnsub = null; }
  scrollEl = null;
}

export async function renderFeed(container) {
  container.className = 'app--dark';
  container.innerHTML = `
    <div class="feed page-enter">
      <div class="feed__scroll" id="feed-scroll">
        <section class="feed-slide feed-slide--empty">
          <span class="material-symbols-outlined">graphic_eq</span>
          <h2>Loading feed…</h2>
          <p>Pulling the last 24 hours from your stations.</p>
        </section>
      </div>
    </div>
  `;

  leaveFeed();
  audioUnsub = onAudio({
    onPlay:  () => setPlayState(true),
    onPause: () => setPlayState(false),
    onEnd:   () => setPlayState(false),
    onError: ({ name, code }) => {
      setPlayState(false);
      // Autoplay blocked → the play button on the cover is the fix; no scary toast.
      if (name === 'NotAllowedError') return;
      toast(code ? 'This preview could not be played' : 'Playback failed, tap the cover to retry');
    },
  });

  if (tracks.length === 0) {
    try {
      tracks = await buildMosaic();
    } catch (e) {
      console.error('buildMosaic failed', e);
      tracks = [];
    }
  }

  if (tracks.length === 0) {
    container.querySelector('.feed__scroll').innerHTML = `
      <section class="feed-slide feed-slide--empty">
        <span class="material-symbols-outlined">cloud_off</span>
        <h2>No tracks available</h2>
        <p>Pick at least one station and tap Generate to build a fresh mix.</p>
      </section>
    `;
    return;
  }

  scrollEl = container.querySelector('.feed__scroll');
  scrollEl.innerHTML = tracks.map((t, i) => renderSlide(t, i)).join('');

  observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > 0.6) {
        const idx = parseInt(e.target.dataset.index, 10);
        if (idx !== currentIndex) {
          currentIndex = idx;
          activateSlide(idx);
        }
      }
    });
  }, { threshold: 0.6, root: scrollEl });

  scrollEl.querySelectorAll('.feed-slide').forEach(s => observer.observe(s));

  if (currentIndex >= tracks.length) currentIndex = 0;
  if (currentIndex > 0) {
    const target = scrollEl.querySelector(`.feed-slide[data-index="${currentIndex}"]`);
    if (target) target.scrollIntoView({ behavior: 'instant' });
  }

  // Boot: kick off the first slide and pre-fetch a few ahead.
  activateSlide(currentIndex);

  scrollEl.addEventListener('click', handleClick);
}

/**
 * Make slide `idx` the playing one: enrich it (cover + preview), start
 * audio, kick off prefetch for the next slides.
 */
async function activateSlide(idx) {
  const slideEl = scrollEl?.querySelector(`.feed-slide[data-index="${idx}"]`);
  if (slideEl) startProgressAnim(slideEl);

  const t = await ensureEnriched(idx);

  // The user may have swiped on while we were waiting.
  if (idx !== currentIndex) return;

  if (t?.previewUrl) {
    playPreview(t.previewUrl, t.id);
  } else {
    // No preview available — keep audio paused, mark the slide.
    stopPreview();
    slideEl?.classList.add('feed-slide--no-preview');
  }

  // Pre-fetch ahead so the next swipes are instant.
  for (let j = 1; j <= PREFETCH_AHEAD; j++) ensureEnriched(idx + j);
}

async function ensureEnriched(idx) {
  if (idx < 0 || idx >= tracks.length) return null;
  const t = tracks[idx];
  if (!t || t._enriched) return t;
  const enriched = { ...(await enrichTrack(t)), _enriched: true };
  // The feed may have been regenerated while we were waiting.
  if (tracks[idx]?.id !== t.id) return enriched;
  tracks[idx] = enriched;
  applyEnrichmentToDom(idx, enriched);
  updateFavorite(enriched);   // liked before the cover arrived? patch it in
  return enriched;
}

function applyEnrichmentToDom(idx, t) {
  const slideEl = scrollEl?.querySelector(`.feed-slide[data-index="${idx}"]`);
  if (!slideEl) return;
  const cover = slideEl.querySelector('.feed-slide__cover');
  if (cover) {
    if (t.coverArt) {
      cover.style.backgroundImage = `url('${cssUrl(t.coverArt)}')`;
      cover.classList.remove('feed-slide__cover--loading');
      const ph = slideEl.querySelector('.feed-slide__cover-placeholder');
      if (ph) ph.remove();
    } else {
      cover.classList.remove('feed-slide__cover--loading');
      cover.classList.add('feed-slide__cover--missing');
    }
  }
  if (t.album) {
    const albumEl = slideEl.querySelector('[data-album]');
    if (albumEl) albumEl.textContent = t.album.toUpperCase();
  }
}

function renderSlide(track, i) {
  const fav = isFavorite(track.id);
  const st = findStation(track.stationId) || {};
  const stationLabel = st.cc ? `${st.cc} ${st.name || track.station || 'Radio'}` : (track.station || 'Radio');
  const freq = st.freq || '';
  const hasArt = !!track.coverArt;
  const bg = hasArt ? `style="background-image:url('${cssUrl(track.coverArt)}')"` : '';
  const coverClass = `feed-slide__cover${hasArt ? '' : ' feed-slide__cover--loading'}`;
  return `
    <section class="feed-slide" data-track-id="${escapeAttr(track.id)}" data-index="${i}">
      <div class="feed-slide__topbar">
        <div class="feed-slide__topbar-left">
          <span class="mono mono--light">Playlist · 24h window</span>
          <span class="feed-slide__live">
            <span class="feed-slide__live-dot"></span>
            <span>Live mix</span>
            <span style="opacity:.5">·</span>
            <span style="opacity:.8">${String(i+1).padStart(2,'0')}/${String(tracks.length).padStart(2,'0')}</span>
          </span>
        </div>
        <button class="feed-slide__stations-btn" data-action="open-stations">
          <span class="material-symbols-outlined" style="font-size:16px">radio</span>
          Stations
        </button>
      </div>

      <div class="feed-slide__cover-wrap">
        <div class="${coverClass}" ${bg}>
          ${hasArt ? '' : `
            <div class="feed-slide__cover-placeholder">
              <span class="material-symbols-outlined" style="font-size:48px">music_note</span>
            </div>
          `}
          <button class="feed-slide__play" data-action="toggle-play" aria-label="Play or pause preview">
            <span class="material-symbols-outlined">play_arrow</span>
          </button>
          <div class="feed-slide__nopreview mono mono--light">No preview</div>
          <button class="feed-slide__handoff" data-action="handoff" aria-label="Open in Spotify">
            <span class="material-symbols-outlined" style="font-size:18px">open_in_new</span>
          </button>
        </div>
        <div class="feed-slide__swipe-hint">↑ SWIPE NEXT</div>
      </div>

      <div class="feed-slide__info">
        <div class="feed-slide__meta">
          <span>${escapeHtml(stationLabel)}</span>
          ${freq ? `<span class="feed-slide__freq">${escapeHtml(freq)}</span>` : ''}
        </div>
        <div class="feed-slide__title">${escapeHtml(track.title)}</div>
        <div class="feed-slide__artist">${escapeHtml(track.artist)}</div>
      </div>

      <div class="feed-slide__progress-wrap">
        <div class="feed-slide__progress">
          <div class="feed-slide__progress-bar" data-progress></div>
        </div>
        <div class="feed-slide__times">
          <span data-elapsed>0:00</span>
          <span style="opacity:.6" data-album>${track.album ? escapeHtml(track.album).toUpperCase() : escapeHtml((st.genre || '').toUpperCase())}</span>
          <span data-total>0:30</span>
        </div>
      </div>

      <div class="feed-slide__actions">
        <button class="feed-action ${fav ? 'feed-action--active' : ''}" data-action="like">
          <span class="material-symbols-outlined" style="font-variation-settings:'FILL' ${fav ? 1 : 0}">favorite</span>
          <span>${fav ? 'LIKED' : 'LIKE'}</span>
        </button>
        <button class="feed-action" data-action="share">
          <span class="material-symbols-outlined">ios_share</span>
          <span>SHARE</span>
        </button>
        <button class="feed-action" data-action="handoff">
          <span class="material-symbols-outlined">open_in_new</span>
          <span>SPOTIFY</span>
        </button>
      </div>
    </section>
  `;
}

function startProgressAnim(slideEl) {
  if (progressTimer) clearInterval(progressTimer);
  const bar = slideEl.querySelector('[data-progress]');
  const elapsed = slideEl.querySelector('[data-elapsed]');
  const totalEl = slideEl.querySelector('[data-total]');
  const audio = document.getElementById('audio-player');
  if (bar) bar.style.width = '0%';
  if (elapsed) elapsed.textContent = '0:00';
  if (!audio) return;

  progressTimer = setInterval(() => {
    const dur = audio.duration;
    if (!dur || isNaN(dur) || !isFinite(dur)) return;
    const t = Math.min(audio.currentTime, dur);
    const p = t / dur;
    if (bar) bar.style.width = `${p * 100}%`;
    if (elapsed) elapsed.textContent = mmss(Math.floor(t));
    if (totalEl) totalEl.textContent = mmss(Math.floor(dur));
  }, 200);
}

function handleClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const slide = btn.closest('.feed-slide');
  if (!slide) return;
  const trackId = slide.dataset.trackId;
  const track = tracks.find(t => t.id === trackId);
  if (!track) return;

  e.stopPropagation();
  const action = btn.dataset.action;
  if (action === 'toggle-play') {
    const idx = parseInt(slide.dataset.index, 10);
    if (!track.previewUrl) return;
    if (idx !== currentIndex) return;
    const audio = document.getElementById('audio-player');
    // Nothing (or another track) loaded yet → start this one; else toggle.
    if (!audio?.src || audio.src !== track.previewUrl) playPreview(track.previewUrl, track.id);
    else togglePreview();
  } else if (action === 'like') {
    const nowFav = toggleFavorite(track);   // the global badge updates via onFavoritesChange
    btn.classList.toggle('feed-action--active', nowFav);
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.style.fontVariationSettings = `'FILL' ${nowFav ? 1 : 0}`;
    const label = btn.querySelector('span:last-child');
    if (label) label.textContent = nowFav ? 'LIKED' : 'LIKE';
  } else if (action === 'share') {
    const text = `${track.title} by ${track.artist} (heard on RadioFlow)`;
    const url = track.spotifyLink;
    if (navigator.share) {
      navigator.share({ title: `${track.title} — ${track.artist}`, text, url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(`${text}\n${url}`)
        .then(() => toast('Link copied'))
        .catch(() => toast('Could not copy the link'));
    }
  } else if (action === 'handoff') {
    const url = track.spotifyLink || `https://open.spotify.com/search/${encodeURIComponent(`${track.artist} ${track.title}`)}`;
    window.open(url, '_blank', 'noopener');
  } else if (action === 'open-stations') {
    window.location.hash = '/stations';
  }
}

/** Reflect play / pause on the active slide's cover button. */
function setPlayState(playing) {
  const slideEl = scrollEl?.querySelector(`.feed-slide[data-index="${currentIndex}"]`);
  if (!slideEl) return;
  scrollEl.querySelectorAll('.feed-slide--playing').forEach(el => {
    if (el !== slideEl) el.classList.remove('feed-slide--playing');
  });
  slideEl.classList.toggle('feed-slide--playing', playing);
  const icon = slideEl.querySelector('.feed-slide__play .material-symbols-outlined');
  if (icon) icon.textContent = playing ? 'pause' : 'play_arrow';
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let toastEl = null;
let toastTimer = null;
function toast(text) {
  // Reuse a single toast so fast swiping doesn't stack them up.
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
  }
  toastEl.textContent = text;
  if (!toastEl.isConnected) document.body.appendChild(toastEl);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.remove(), 1800);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cssUrl(str) {
  return String(str ?? '').replace(/'/g, "\\'");
}
