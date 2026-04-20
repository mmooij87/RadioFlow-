/**
 * Liked — Rams-style artwork grid of saved tracks.
 */
import { getFavorites, toggleFavorite, onFavoritesChange } from '../services/favoritesService.js';

let unsubscribe = null;

export function renderFavorites(container) {
  if (unsubscribe) unsubscribe();

  function render() {
    const favs = getFavorites();
    container.className = 'app--paper';

    if (favs.length === 0) {
      container.innerHTML = `
        <div class="liked page-enter">
          <div class="liked__head">
            <div class="mono">Liked · local · synced</div>
            <h2 class="liked__title">Hearts <span class="liked__count">00</span></h2>
          </div>
          <div class="liked__empty">
            <div class="liked__empty-icon">
              <span class="material-symbols-outlined">favorite</span>
            </div>
            <p>Hearts appear here. Tap Like on a song in the feed to save it.</p>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="liked page-enter">
        <div class="liked__head">
          <div class="mono">Liked · local · synced</div>
          <h2 class="liked__title">
            Hearts
            <span class="liked__count">${String(favs.length).padStart(2, '0')}</span>
          </h2>
        </div>

        <div class="liked__toolbar">
          <button class="tool-pill" data-action="export">
            <span class="material-symbols-outlined">ios_share</span>
            EXPORT
          </button>
          <button class="tool-pill tool-pill--accent" data-action="handoff-all">
            <span class="material-symbols-outlined">open_in_new</span>
            SEND · SPOTIFY
          </button>
        </div>

        <div class="liked__grid">
          <div class="liked-grid" id="liked-grid">
            ${favs.map(renderTile).join('')}
          </div>
        </div>
      </div>
    `;

    container.querySelector('.liked__toolbar')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'handoff-all') {
        const ids = getFavorites().map(f => `${f.artist} ${f.title}`).join(' ');
        const q = encodeURIComponent(ids);
        window.open(`https://open.spotify.com/search/${q}`, '_blank');
      } else if (action === 'export') {
        exportM3U(getFavorites());
      }
    });

    container.querySelector('#liked-grid').addEventListener('click', (e) => {
      const tile = e.target.closest('[data-track-id]');
      if (!tile) return;
      const id = tile.dataset.trackId;
      const track = getFavorites().find(f => f.id === id);
      if (track) {
        // click = open in Spotify (quickest next step once liked)
        const q = encodeURIComponent(`${track.artist} ${track.title}`);
        window.open(`https://open.spotify.com/search/${q}`, '_blank');
      }
    });
  }

  render();
  unsubscribe = onFavoritesChange(() => {
    if (window.location.hash.replace('#', '') !== '/liked') return;
    render();
  });
}

function renderTile(t) {
  const bg = t.coverArt
    ? `style="background-image:url('${escapeAttr(t.coverArt)}')"`
    : '';
  return `
    <button class="liked-tile" data-track-id="${escapeAttr(t.id)}">
      <div class="liked-tile__cover" ${bg}>
        ${t.coverArt ? '' : `
          <div class="liked-tile__cover-placeholder">
            <span class="material-symbols-outlined" style="font-size:24px">music_note</span>
          </div>
        `}
      </div>
      <div class="liked-tile__info">
        <div class="liked-tile__title">${escapeHtml(t.title)}</div>
        <div class="liked-tile__artist">${escapeHtml(t.artist)}</div>
      </div>
    </button>
  `;
}

function exportM3U(favs) {
  const lines = ['#EXTM3U'];
  favs.forEach(t => {
    lines.push(`#EXTINF:${t.duration || -1},${t.artist} - ${t.title}`);
    lines.push(t.previewUrl || t.deezerLink || '');
  });
  const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'radioflow-liked.m3u';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
