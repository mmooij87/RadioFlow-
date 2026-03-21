/**
 * Page 2: Sonic Feed — TikTok-style full-screen vertical swipe feed
 * Each track fills the viewport with cover art, large typography, and action buttons
 */
import { buildMosaic } from '../services/dataService.js';
import { isFavorite, toggleFavorite } from '../services/favoritesService.js';
import { playPreview, stopPreview, setCallbacks, isPlaying, getCurrentTrackId } from '../components/audioPlayer.js';

let feedTracks = [];
let currentIndex = 0;

export function clearFeed() {
  feedTracks = [];
  currentIndex = 0;
}

export async function renderFeed(container) {
  container.innerHTML = `
    <div class="feed-page" id="feed-container">
      <!-- Progress bar -->
      <div class="feed-progress" id="feed-progress">
        <div class="feed-progress__bar" id="feed-progress-bar"></div>
      </div>
      <!-- Loading state -->
      <div class="feed-slide feed-slide--loading">
        <div class="feed-slide__loading">
          <div class="loading-spinner">
            <div class="loading-spinner__ring"></div>
            <div class="loading-spinner__ring loading-spinner__ring--active"></div>
            <div class="loading-spinner__icon">
              <span class="material-symbols-outlined">graphic_eq</span>
            </div>
          </div>
          <p class="text-label-md color-primary-c" style="margin-top:16px;">Loading Feed...</p>
        </div>
      </div>
    </div>
  `;

  // Set up audio callbacks
  setCallbacks({
    onPlay: (trackId) => {
      // Update play button icon for current slide
      const activeSlide = document.querySelector(`.feed-slide[data-track-id="${trackId}"]`);
      if (activeSlide) {
        const vizBars = activeSlide.querySelectorAll('.feed-viz-bar');
        vizBars.forEach(bar => bar.classList.add('feed-viz-bar--active'));
      }
    },
    onStop: (trackId) => {
      const slide = document.querySelector(`.feed-slide[data-track-id="${trackId}"]`);
      if (slide) {
        const vizBars = slide.querySelectorAll('.feed-viz-bar');
        vizBars.forEach(bar => bar.classList.remove('feed-viz-bar--active'));
      }
    },
  });

  // Load tracks
  // Load tracks if empty
  if (feedTracks.length === 0) {
    try {
      feedTracks = await buildMosaic(30);
    } catch (e) {
      console.error('Failed to build feed:', e);
      feedTracks = [];
    }
  }

  if (feedTracks.length === 0) {
    container.innerHTML = `
      <div class="feed-page" style="display:flex;align-items:center;justify-content:center;height:calc(100dvh - 144px);">
        <div style="text-align:center;padding:40px;">
          <span class="material-symbols-outlined" style="font-size:64px;color:rgba(213,228,246,0.2);margin-bottom:16px;">cloud_off</span>
          <h2 class="text-headline-md" style="margin-bottom:8px;">No Tracks Available</h2>
          <p class="text-body-md color-on-surface-v">Could not load the feed. Please try again later.</p>
        </div>
      </div>
    `;
    return;
  }

  // Build the feed
  const feedContainer = document.getElementById('feed-container');
  feedContainer.innerHTML = `
    <div class="feed-progress" id="feed-progress">
      <div class="feed-progress__bar" id="feed-progress-bar"></div>
    </div>
    <main class="feed-scroll" id="feed-scroll">
      ${feedTracks.map((track, i) => renderSlide(track, i)).join('')}
    </main>
  `;

  updateProgress(currentIndex);

  // Snap scroll observation
  const scrollEl = document.getElementById('feed-scroll');
  const slides = scrollEl.querySelectorAll('.feed-slide');

  // Intersection observer to detect current slide
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
        const idx = parseInt(entry.target.dataset.index, 10);
        if (idx !== currentIndex) {
          // Stop previous track
          stopPreview();
          currentIndex = idx;
          updateProgress(idx);
          // Auto-play the new slide's preview
          const track = feedTracks[idx];
          if (track?.previewUrl) {
            playPreview(track.previewUrl, track.id);
          }
        }
      }
    });
  }, { threshold: 0.6, root: scrollEl });

  slides.forEach(slide => observer.observe(slide));

  // Restore scroll position
  if (currentIndex > 0) {
    setTimeout(() => {
      const slide = scrollEl.querySelector(`.feed-slide[data-index="${currentIndex}"]`);
      if (slide) {
        slide.scrollIntoView({ behavior: 'instant' });
      }
    }, 0);
  }

  // Auto-play current track
  const currentTrack = feedTracks[currentIndex];
  if (currentTrack?.previewUrl) {
    setTimeout(() => {
      playPreview(currentTrack.previewUrl, currentTrack.id);
    }, 500);
  }

  // Event delegation
  feedContainer.addEventListener('click', handleFeedClick);
}

function handleFeedClick(e) {
  // Heart button
  const heartBtn = e.target.closest('.feed-action--heart');
  if (heartBtn) {
    e.stopPropagation();
    const slide = heartBtn.closest('.feed-slide');
    const trackId = slide?.dataset.trackId;
    const track = feedTracks.find(t => t.id === trackId);
    if (track) {
      const nowFav = toggleFavorite(track);
      const icon = heartBtn.querySelector('.material-symbols-outlined');
      if (icon) {
        icon.style.fontVariationSettings = nowFav
          ? "'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24"
          : "'FILL' 0, 'wght' 400, 'GRAD' 0, 'opsz' 24";
      }
      const label = heartBtn.querySelector('.feed-action__label');
      if (label) label.textContent = nowFav ? 'SAVED' : 'FAVORITE';
    }
    return;
  }

  // Spotify button
  const spotifyBtn = e.target.closest('.feed-action--spotify');
  if (spotifyBtn) {
    e.stopPropagation();
    const slide = spotifyBtn.closest('.feed-slide');
    const trackId = slide?.dataset.trackId;
    const track = feedTracks.find(t => t.id === trackId);
    if (track) {
      const query = encodeURIComponent(`${track.artist} ${track.title}`);
      window.open(`https://open.spotify.com/search/${query}`, '_blank');
    }
    return;
  }

  // Share button
  const shareBtn = e.target.closest('.feed-action--share');
  if (shareBtn) {
    e.stopPropagation();
    const slide = shareBtn.closest('.feed-slide');
    const trackId = slide?.dataset.trackId;
    const track = feedTracks.find(t => t.id === trackId);
    if (track && navigator.share) {
      navigator.share({
        title: `${track.title} — ${track.artist}`,
        text: `Check out "${track.title}" by ${track.artist} on KINK Radio!`,
      }).catch(() => {});
    }
    return;
  }
}

function updateProgress(index) {
  const bar = document.getElementById('feed-progress-bar');
  if (bar && feedTracks.length > 0) {
    const pct = ((index + 1) / feedTracks.length) * 100;
    bar.style.width = `${pct}%`;
  }
}

function renderSlide(track, index) {
  const fav = isFavorite(track.id);
  const stationLabel = track.station ? track.station.toUpperCase() : 'KINK FM';

  return `
    <section class="feed-slide" data-track-id="${track.id}" data-index="${index}">
      <!-- Full-screen cover art background -->
      <div class="feed-slide__bg">
        ${track.coverArt
          ? `<img class="feed-slide__img" src="${track.coverArt}" alt="${escapeAttr(track.title)}" loading="${index < 3 ? 'eager' : 'lazy'}" />`
          : `<div class="feed-slide__img feed-slide__img--placeholder"></div>`
        }
        <div class="feed-slide__gradient"></div>
      </div>


      <!-- Bottom content overlay -->
      <div class="feed-slide__content">
        <!-- Visualizer + Now Playing -->
        <div class="feed-now-playing">
          <div class="feed-viz">
            <div class="feed-viz-bar" style="height:40%"></div>
            <div class="feed-viz-bar" style="height:80%"></div>
            <div class="feed-viz-bar" style="height:100%"></div>
            <div class="feed-viz-bar" style="height:60%"></div>
            <div class="feed-viz-bar" style="height:90%"></div>
          </div>
          <span class="feed-now-playing__label">Now Playing • ${stationLabel}</span>
        </div>

        <!-- Artist and Title -->
        <div class="feed-track-info">
          <h3 class="feed-track-info__artist">${escapeHtml(track.artist)}</h3>
          <h2 class="feed-track-info__title">${escapeHtml(track.title)}</h2>
        </div>

        <!-- Action buttons -->
        <div class="feed-actions">
          <button class="feed-action feed-action--heart">
            <div class="feed-action__circle">
              <span class="material-symbols-outlined"
                    style="font-variation-settings: 'FILL' ${fav ? 1 : 0}, 'wght' 400, 'GRAD' 0, 'opsz' 24; font-size:28px;">
                favorite
              </span>
            </div>
            <span class="feed-action__label">${fav ? 'SAVED' : 'FAVORITE'}</span>
          </button>

          <button class="feed-action feed-action--spotify">
            <div class="feed-action__spotify-btn">
              <span class="feed-action__spotify-text">Open in Spotify</span>
              <span class="material-symbols-outlined" style="font-size:20px;">open_in_new</span>
            </div>
          </button>

          <button class="feed-action feed-action--share">
            <div class="feed-action__circle feed-action__circle--ghost">
              <span class="material-symbols-outlined" style="font-size:24px;">share</span>
            </div>
          </button>
        </div>
      </div>
    </section>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
