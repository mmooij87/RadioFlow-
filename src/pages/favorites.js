/**
 * Page 3: Favorites — saved tracks list with Spotify links
 */
import { getFavorites, toggleFavorite, onFavoritesChange } from '../services/favoritesService.js';

let unsubscribe = null;

export function renderFavorites(container) {
  // Clean up previous subscription
  if (unsubscribe) unsubscribe();

  function render() {
    const favorites = getFavorites();

    if (favorites.length === 0) {
      container.innerHTML = `
        <div class="favorites-page page-enter">
          <div class="favorites-header">
            <h2 class="favorites-header__title">Favorites</h2>
            <div class="favorites-header__count">
              <span class="favorites-header__number">0 TRACKS</span>
              <div class="favorites-header__line"></div>
            </div>
          </div>
          <div class="favorites-empty">
            <div class="favorites-empty__icon">
              <span class="material-symbols-outlined">heart_broken</span>
            </div>
            <h3 class="favorites-empty__title">No Favorites Yet</h3>
            <p class="favorites-empty__desc">Head to the Mosaic feed and heart some tracks to build your collection.</p>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="favorites-page page-enter">
        <div class="favorites-header">
          <h2 class="favorites-header__title">Favorites</h2>
          <div class="favorites-header__count">
            <span class="favorites-header__number">${favorites.length} TRACK${favorites.length !== 1 ? 'S' : ''}</span>
            <div class="favorites-header__line"></div>
          </div>
        </div>

        <section class="track-list" id="track-list">
          ${favorites.map((t, i) => renderTrackItem(t, i === 0)).join('')}
        </section>
      </div>
    `;

    // Event delegation
    container.addEventListener('click', handleClick);
  }

  function handleClick(e) {
    // Heart button
    const heartBtn = e.target.closest('.track-item__btn--heart');
    if (heartBtn) {
      const item = heartBtn.closest('.track-item');
      const trackId = item?.dataset.trackId;
      if (trackId) {
        const favorites = getFavorites();
        const track = favorites.find(f => f.id === trackId);
        if (track) {
          toggleFavorite(track);
          // Re-render will happen via subscription
        }
      }
      return;
    }

    // Spotify button
    const spotifyBtn = e.target.closest('.track-item__btn--spotify');
    if (spotifyBtn) {
      const item = spotifyBtn.closest('.track-item');
      const artist = item?.dataset.artist;
      const title = item?.dataset.title;
      if (artist && title) {
        const query = encodeURIComponent(`${artist} ${title}`);
        window.open(`https://open.spotify.com/search/${query}`, '_blank');
      }
      return;
    }
  }

  // Initial render
  render();

  // Subscribe to changes
  unsubscribe = onFavoritesChange(() => {
    if (window.location.hash.replace('#', '') !== '/favorites') return;
    container.removeEventListener('click', handleClick);
    render();
  });
}

function renderTrackItem(track, isActive) {
  const durationStr = track.duration ? formatDuration(track.duration) : '';
  const genreStr = track.genre ? track.genre.charAt(0).toUpperCase() + track.genre.slice(1) : 'Rock';

  return `
    <div class="track-item ${isActive ? 'track-item--active' : ''}"
         data-track-id="${track.id}"
         data-artist="${escapeAttr(track.artist)}"
         data-title="${escapeAttr(track.title)}">
      <div class="track-item__art">
        ${track.coverArt
          ? `<img src="${track.coverArt}" alt="${escapeAttr(track.title)}" loading="lazy" />`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--surface-container-highest);">
              <span class="material-symbols-outlined" style="color:rgba(213,228,246,0.15);font-size:28px;">music_note</span>
             </div>`
        }
      </div>
      <div class="track-item__meta">
        <h3 class="track-item__title">${escapeHtml(track.title)}</h3>
        <p class="track-item__artist">${escapeHtml(track.artist)}</p>
        <div class="track-item__tags">
          <span class="track-item__genre">${genreStr}</span>
          ${durationStr ? `<span class="track-item__duration">${durationStr}</span>` : ''}
        </div>
      </div>
      <div class="track-item__actions">
        <button class="track-item__btn track-item__btn--heart" aria-label="Remove from favorites">
          <span class="material-symbols-outlined" style="font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24;">favorite</span>
        </button>
        <button class="track-item__btn track-item__btn--spotify" aria-label="Open in Spotify" title="Search on Spotify">
          <span class="material-symbols-outlined">music_note</span>
        </button>
      </div>
    </div>
  `;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escapeAttr(str) {
  return (str || '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
