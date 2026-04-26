/**
 * Feed — vertical swipe, Rams aesthetic.
 * Full-bleed cover art, mono meta, Braun-orange progress, action rail.
 * Audio autoplay is driven by the IntersectionObserver. The audio element
 * is primed with a user gesture by the Generate button before this view
 * mounts, so successive .play() calls on swipe work without user taps.
 */
import { buildMosaic } from '../services/dataService.js';
import { isFavorite, toggleFavorite, getFavorites } from '../services/favoritesService.js';
import { playPreview, stopPreview, onAudio } from '../components/audioPlayer.js';
import { findStation } from '../data/stations.js';

let tracks = [];
let currentIndex = 0;
let progressTimer = null;
let audioUnsub = null;

export function clearFeed() {
  tracks = [];
  currentIndex = 0;
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

  if (audioUnsub) audioUnsub();
  audioUnsub = onAudio({
    onError: ({ message, code }) => {
      const text = message || (code ? `Audio code ${code}` : 'Audio failed');
      toast(text);
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

  const scrollEl = container.querySelector('.feed__scroll');
  scrollEl.innerHTML = tracks.map((t, i) => renderSlide(t, i)).join('');

  // Intersection observer drives autoplay: when a slide becomes the active
  // (≥60% visible) one, swap the audio source and call play().
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > 0.6) {
        const idx = parseInt(e.target.dataset.index, 10);
        if (idx !== currentIndex) {
          currentIndex = idx;
          startProgressAnim(e.target);
          const t = tracks[idx];
          if (t?.previewUrl) playPreview(t.previewUrl, t.id);
        }
      }
    });
  }, { threshold: 0.6, root: scrollEl });

  scrollEl.querySelectorAll('.feed-slide').forEach(s => observer.observe(s));

  if (currentIndex > 0) {
    const target = scrollEl.querySelector(`.feed-slide[data-index="${currentIndex}"]`);
    if (target) target.scrollIntoView({ behavior: 'instant' });
  }

  // Boot: prime progress UI + start playing the current slide. Audio was
  // already unlocked by the Generate button click before navigation, so
  // this play() succeeds without a tap.
  const firstSlide = scrollEl.querySelector(`.feed-slide[data-index="${currentIndex}"]`);
  if (firstSlide) startProgressAnim(firstSlide);
  const firstTrack = tracks[currentIndex];
  if (firstTrack?.previewUrl) {
    setTimeout(() => playPreview(firstTrack.previewUrl, firstTrack.id), 200);
  }

  scrollEl.addEventListener('click', handleClick);
}

function renderSlide(track, i) {
  const fav = isFavorite(track.id);
  const st = findStation(track.stationId) || {};
  const stationLabel = st.cc ? `${st.cc} ${st.name || track.station || 'Radio'}` : (track.station || 'Radio');
  const freq = st.freq || '';
  const bg = track.coverArt
    ? `style="background-image:url('${escapeAttr(track.coverArt)}')"`
    : '';
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
        <div class="feed-slide__cover" ${bg}>
          ${track.coverArt ? '' : `
            <div class="feed-slide__cover-placeholder">
              <span class="material-symbols-outlined" style="font-size:48px">music_note</span>
            </div>
          `}
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
          <span style="opacity:.6">${track.album ? escapeHtml(track.album).toUpperCase() : escapeHtml((st.genre || '').toUpperCase())}</span>
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
  if (action === 'like') {
    const nowFav = toggleFavorite(track);
    btn.classList.toggle('feed-action--active', nowFav);
    const icon = btn.querySelector('.material-symbols-outlined');
    if (icon) icon.style.fontVariationSettings = `'FILL' ${nowFav ? 1 : 0}`;
    const label = btn.querySelector('span:last-child');
    if (label) label.textContent = nowFav ? 'LIKED' : 'LIKE';
    updateLikedBadge();
  } else if (action === 'share') {
    if (navigator.share) {
      navigator.share({
        title: `${track.title} — ${track.artist}`,
        text: `Heard on RadioFlow: "${track.title}" by ${track.artist}`,
      }).catch(() => {});
    } else {
      toast(`Share: ${track.title}`);
    }
  } else if (action === 'handoff') {
    const url = track.spotifyLink || `https://open.spotify.com/search/${encodeURIComponent(`${track.artist} ${track.title}`)}`;
    window.open(url, '_blank');
    toast(`→ OPENING SPOTIFY: ${track.title}`);
  } else if (action === 'open-stations') {
    window.location.hash = '/stations';
  }
}

function updateLikedBadge() {
  const badge = document.getElementById('nav-liked-badge');
  if (!badge) return;
  const n = getFavorites().length;
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else { badge.hidden = true; }
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
