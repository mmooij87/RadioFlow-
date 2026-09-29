/**
 * Settings — a bottom sheet with two views:
 *   main    where songs open (Spotify / YouTube Music / Apple Music)
 *           + the stations on your dial (remove, restore defaults)
 *   search  find and add stations from 100,000+ worldwide
 */
import { icon } from './icons.js';
import { toast } from './toast.js';
import {
  SERVICES, getOpenIn, setOpenIn, getMyStations, removeStation, resetStations,
  addStation, hasOrb, stationPlace, onStoreChange,
} from '../services/stationStore.js';
import { apiReady, searchStations, fetchOrbPlaylist } from '../services/orbApi.js';

const SUGGESTIONS = ['indie', 'jazz', 'Amsterdam', 'classic rock', 'Berlin', 'soul', 'electronic', 'Tokyo'];

export function createSettingsSheet(dialog, { onClose }) {
  let view = 'main';
  let query = '';
  let results = null;        // null = nothing searched yet
  let searching = false;
  let error = '';
  const rowState = new Map(); // station id → 'checking' | 'empty'
  let debounce = 0;
  let aborter = null;

  // ── Main view ────────────────────────────────────────────
  function mainHtml() {
    const openIn = getOpenIn();
    const mine = getMyStations();
    return `
      <div class="sheet__grip" aria-hidden="true"></div>
      <header class="sheet__head">
        <h2 id="settings-title">Settings</h2>
        <button class="icon-btn" data-act="close" aria-label="Close">${icon('close', { size: 22 })}</button>
      </header>
      <div class="sheet__body">
        <section class="set-block">
          <h3 class="set-label" id="openin-label">Open songs in</h3>
          <div class="segmented" role="radiogroup" aria-labelledby="openin-label">
            ${Object.entries(SERVICES).map(([k, v]) => `
              <button role="radio" aria-checked="${k === openIn}" data-act="open-in" data-v="${k}"
                class="segmented__opt ${k === openIn ? 'segmented__opt--on' : ''}">${v.label}</button>`).join('')}
          </div>
        </section>

        <section class="set-block">
          <div class="set-row-head">
            <h3 class="set-label">Your stations <span class="set-n">${mine.length}</span></h3>
            <button class="pill pill--solid pill--sm" data-act="to-search">${icon('plus', { size: 16 })}Add stations</button>
          </div>
          ${mine.length ? `
            <ul class="st-list">
              ${mine.map(st => `
                <li class="st-row">
                  ${logo(st)}
                  <span class="st-row__text">
                    <span class="st-row__name">${esc(st.name)}</span>
                    <span class="st-row__meta">${esc(meta(st))}</span>
                  </span>
                  <button class="icon-btn icon-btn--quiet" data-act="remove" data-id="${esc(st.id)}"
                    aria-label="Remove ${esc(st.name)} from your dial">${icon('close', { size: 18 })}</button>
                </li>`).join('')}
            </ul>` : `<p class="set-empty">Your dial is empty. Add a few stations to start listening.</p>`}
          <p class="set-help">All your stations play in the mix. Tap one on the dial to hear only that station; swipe the dial to bring them all back.</p>
          <button class="link-btn" data-act="reset">Restore the default stations</button>
        </section>
      </div>`;
  }

  // ── Search view ──────────────────────────────────────────
  function searchHtml() {
    return `
      <div class="sheet__grip" aria-hidden="true"></div>
      <header class="sheet__head sheet__head--search">
        <button class="icon-btn" data-act="to-main" aria-label="Back to settings">${icon('back', { size: 22 })}</button>
        <h2 id="settings-title">Add stations</h2>
        <button class="icon-btn" data-act="close" aria-label="Close">${icon('close', { size: 22 })}</button>
      </header>
      ${apiReady() ? `
        <div class="search-box">
          ${icon('search', { size: 20 })}
          <input id="st-search" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
            placeholder="Station, city or genre" aria-label="Search stations worldwide" value="${esc(query)}" />
        </div>
        <div class="sheet__body" id="search-results" aria-live="polite">${resultsHtml()}</div>
      ` : `
        <div class="sheet__body">
          <p class="set-empty">Searching stations worldwide needs the small RadioFlow server (a free
          Cloudflare Worker). Once it's set up, you can add any of 100,000+ stations here.
          The steps are in <code>worker/README.md</code>.</p>
        </div>`}`;
  }

  function resultsHtml() {
    if (error) return `<p class="set-empty">${esc(error)}</p>`;
    if (results === null) {
      return `
        <p class="set-empty">Search 100,000+ stations worldwide by name, city or genre.</p>
        <div class="chips">${SUGGESTIONS.map(s => `<button class="chip" data-act="suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    }
    if (searching && !results.length) return `<p class="set-empty">Searching…</p>`;
    if (!results.length) return `<p class="set-empty">No stations found for “${esc(query)}”. Try a city or a genre.</p>`;
    return `
      <ul class="st-list">
        ${results.map(st => {
          const added = hasOrb(st.orb);
          const state = rowState.get(st.id);
          return `
            <li class="st-row">
              ${logo(st)}
              <span class="st-row__text">
                <span class="st-row__name">${esc(st.name)}</span>
                <span class="st-row__meta">${esc(meta(st))}</span>
                ${state === 'empty' ? `<span class="st-row__warn">Doesn't share what it plays, so there's nothing to hear.</span>` : ''}
              </span>
              ${added
                ? `<span class="st-row__done">${icon('check', { size: 18 })}Added</span>`
                : state === 'empty'
                  ? ''
                  : `<button class="pill pill--sm" data-act="add" data-id="${esc(st.id)}" ${state === 'checking' ? 'disabled' : ''}>
                       ${state === 'checking' ? 'Checking…' : `${icon('plus', { size: 16 })}Add`}</button>`}
            </li>`;
        }).join('')}
      </ul>`;
  }

  function render() {
    dialog.innerHTML = view === 'main' ? mainHtml() : searchHtml();
    if (view === 'search') {
      const input = dialog.querySelector('#st-search');
      if (input) {
        input.addEventListener('input', () => { query = input.value; scheduleSearch(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); runSearch(); } });
      }
    }
  }
  function renderResults() {
    const box = dialog.querySelector('#search-results');
    if (box) box.innerHTML = resultsHtml(); else render();
  }

  function scheduleSearch() {
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 380);
  }
  async function runSearch() {
    const q = query.trim();
    if (q.length < 2) { results = null; error = ''; renderResults(); return; }
    aborter?.abort();
    aborter = new AbortController();
    searching = true; error = '';
    if (!results) results = [];
    renderResults();
    try {
      results = await searchStations(q, { signal: aborter.signal });
      searching = false;
      renderResults();
    } catch (e) {
      if (e.name === 'AbortError') return;
      searching = false;
      error = "Couldn't reach the station search. Check your connection and try again.";
      renderResults();
    }
  }

  async function add(st) {
    rowState.set(st.id, 'checking');
    renderResults();
    // Only add stations that actually publish a song list.
    const tracks = await fetchOrbPlaylist(st.orb);
    if (!tracks.length) {
      rowState.set(st.id, 'empty');
      renderResults();
      return;
    }
    rowState.delete(st.id);
    addStation(st);
    toast(`${st.name} is on your dial`);
    renderResults();
  }

  // ── Events ───────────────────────────────────────────────
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) { close(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') close();
    else if (act === 'open-in') { setOpenIn(b.dataset.v); render(); }
    else if (act === 'to-search') openSearch();
    else if (act === 'to-main') { view = 'main'; render(); }
    else if (act === 'remove') {
      const st = getMyStations().find(s => s.id === b.dataset.id);
      removeStation(b.dataset.id);
      render();
      if (st) toast(`${st.name} removed`);
    } else if (act === 'reset') {
      if (confirm('Put the 12 default stations back and remove the ones you added?')) { resetStations(); render(); }
    } else if (act === 'suggest') {
      query = b.dataset.q;
      render();
      runSearch();
    } else if (act === 'add') {
      const st = results?.find(r => r.id === b.dataset.id);
      if (st) add(st);
    }
  });

  // Drag the grip or header down to dismiss.
  let startY = null;
  dialog.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sheet__grip, .sheet__head') && !e.target.closest('button')) startY = e.clientY;
  });
  dialog.addEventListener('pointermove', (e) => {
    if (startY !== null) dialog.style.translate = `0 ${Math.max(0, e.clientY - startY)}px`;
  });
  const endDrag = (e) => {
    if (startY === null) return;
    const dy = e.clientY - startY;
    startY = null; dialog.style.translate = '';
    if (dy > 90) close();
  };
  dialog.addEventListener('pointerup', endDrag);
  dialog.addEventListener('pointercancel', endDrag);
  dialog.addEventListener('close', () => onClose());

  onStoreChange(() => { if (dialog.open && view === 'main') render(); });

  function open() { view = 'main'; render(); dialog.showModal(); }
  function openSearch() {
    view = 'search';
    render();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('#st-search')?.focus();
  }
  function close() { if (dialog.open) dialog.close(); }
  return { open, openSearch, close, get isOpen() { return dialog.open; } };
}

function meta(st) {
  const place = stationPlace(st);
  const genre = st.genres?.length ? st.genres.join(', ') : st.genre;
  return [genre, place].filter(Boolean).join(' · ');
}
function logo(st) {
  if (st.logo) return `<img class="st-row__logo" src="${esc(st.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  return `<span class="st-row__logo st-row__logo--text" aria-hidden="true">${esc((st.name || '?').slice(0, 1))}</span>`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
