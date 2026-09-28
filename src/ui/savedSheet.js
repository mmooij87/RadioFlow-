/**
 * Saved songs — a bottom sheet built on the native <dialog> element
 * (free focus trap, Esc to close, inert background).
 */
import { icon } from './icons.js';
import { toast } from './toast.js';
import { getFavorites, removeFavorite, clearFavorites, onFavoritesChange } from '../services/favoritesService.js';
import { SERVICES, getOpenIn, songUrl } from '../services/stationStore.js';

export function createSavedSheet(dialog, { onPreview, onClose }) {
  let previewingId = null;

  function render() {
    const favs = getFavorites();
    dialog.innerHTML = `
      <div class="sheet__grip" aria-hidden="true"></div>
      <header class="sheet__head">
        <h2 id="sheet-title">Saved <span class="sheet__n">${favs.length}</span></h2>
        <button class="icon-btn" data-act="close" aria-label="Close">${icon('close', { size: 22 })}</button>
      </header>
      ${favs.length ? `
        <ul class="saved-list">
          ${favs.map(t => `
            <li class="saved-row ${t.id === previewingId ? 'saved-row--playing' : ''}" data-id="${esc(t.id)}">
              <button class="saved-row__main" data-act="preview" ${t.previewUrl ? '' : 'disabled'}
                aria-label="${t.id === previewingId ? 'Stop' : 'Play'} ${esc(t.title)} by ${esc(t.artist)}">
                <span class="saved-row__art" ${t.coverArt ? `style="background-image:url('${cssUrl(t.coverArt)}')"` : ''}>
                  <span class="saved-row__state">${icon(t.id === previewingId ? 'pause' : 'play', { size: 18 })}</span>
                </span>
                <span class="saved-row__text">
                  <span class="saved-row__title">${esc(t.title)}</span>
                  <span class="saved-row__artist">${esc(t.artist)}</span>
                </span>
              </button>
              <a class="icon-btn" href="${esc(songUrl(t))}" target="_blank" rel="noopener"
                aria-label="Open ${esc(t.title)} in ${SERVICES[getOpenIn()].label}">${icon('external', { size: 20 })}</a>
              <button class="icon-btn icon-btn--quiet" data-act="remove" aria-label="Remove ${esc(t.title)}">
                ${icon('close', { size: 18 })}</button>
            </li>`).join('')}
        </ul>
        <footer class="sheet__tools">
          <button class="pill" data-act="copy">${icon('copy', { size: 18 })}Copy list</button>
          <button class="pill" data-act="export">${icon('download', { size: 18 })}Export .m3u</button>
          <button class="pill pill--quiet" data-act="clear">${icon('trash', { size: 18 })}Clear all</button>
        </footer>
      ` : `
        <div class="sheet__empty">
          <span class="sheet__empty-heart">${icon('heart', { size: 40 })}</span>
          <p>Double-tap a cover to save a song.<br>It lands here.</p>
        </div>
      `}`;
  }

  dialog.addEventListener('click', (e) => {
    // Click on the backdrop (outside the sheet box) closes it.
    if (e.target === dialog) { close(); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const row = btn.closest('.saved-row');
    const track = row && getFavorites().find(f => f.id === row.dataset.id);

    if (act === 'close') close();
    else if (act === 'preview' && track) {
      previewingId = previewingId === track.id ? null : track.id;
      onPreview(previewingId ? track : null);
      render();
    } else if (act === 'remove' && track) {
      if (previewingId === track.id) { previewingId = null; onPreview(null); }
      removeFavorite(track.id);
      toast(`Removed ${track.title}`);
    } else if (act === 'copy') {
      const list = getFavorites().map(f => `${f.artist} - ${f.title}`).join('\n');
      navigator.clipboard?.writeText(list)
        .then(() => toast('List copied. Paste it into Soundiiz or TuneMyMusic to build a playlist.', 3600))
        .catch(() => toast('Copying is blocked in this browser'));
    } else if (act === 'export') {
      exportM3U(getFavorites());
    } else if (act === 'clear') {
      const n = getFavorites().length;
      if (confirm(`Remove all ${n} saved song${n === 1 ? '' : 's'}? This can't be undone.`)) {
        previewingId = null; onPreview(null);
        clearFavorites();
      }
    }
  });

  // Drag the grip down to dismiss (touch).
  let startY = null;
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sheet__grip, .sheet__head') && !e.target.closest('button')) startY = e.clientY;
  });
  dialog.addEventListener('pointermove', (e) => {
    if (startY === null) return;
    const dy = Math.max(0, e.clientY - startY);
    dialog.style.translate = `0 ${dy}px`;
  });
  const endDrag = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null;
    dialog.style.translate = '';
    if (dy > 90) close();
  };
  dialog.addEventListener('pointerup', endDrag);
  dialog.addEventListener('pointercancel', endDrag);

  dialog.addEventListener('close', () => {
    if (previewingId) { previewingId = null; }
    onClose();
  });

  onFavoritesChange(() => { if (dialog.open) render(); });

  function open() {
    render();
    dialog.showModal();
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  return { open, close, get isOpen() { return dialog.open; } };
}

function exportM3U(favs) {
  const lines = ['#EXTM3U'];
  favs.forEach(t => {
    lines.push(`#EXTINF:${t.duration || -1},${t.artist} - ${t.title}`);
    lines.push(t.previewUrl || songUrl(t));
  });
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: 'radioflow-saved.m3u' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssUrl(s) { return String(s ?? '').replace(/['"()\\]/g, encodeURIComponent); }
