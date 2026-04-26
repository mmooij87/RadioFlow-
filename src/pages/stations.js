/**
 * Stations — multi-select, search, grid/list variants.
 * Built to match RadioFlow v2 Dieter Rams design.
 */
import { STATIONS, filterStations } from '../data/stations.js';
import { primeAudio } from '../components/audioPlayer.js';

const SELECTED_KEY = 'radioflow_stations';
const VARIANT_KEY  = 'radioflow_stations_variant';

let state = {
  selected: new Set(),
  variant: 'grid',
  search: '',
};

export function renderStations(container, onGenerate) {
  // load persisted selection + variant
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]');
    state.selected = new Set(saved);
  } catch { state.selected = new Set(); }
  state.variant = localStorage.getItem(VARIANT_KEY) || 'grid';
  state.search = '';

  container.className = 'app--paper';
  container.innerHTML = `
    <div class="stations page-enter">
      <div class="stations__head">
        <div class="mono" id="stations-count-label">Stations · ${STATIONS.length} worldwide</div>
        <h2 class="stations__title">Add sources</h2>
      </div>

      <div class="stations__search">
        <span class="material-symbols-outlined">search</span>
        <input id="stations-search" type="text" placeholder="Search city, name, genre…" autocomplete="off" />
        <span class="mono" id="stations-picked">${state.selected.size} picked</span>
      </div>

      <div class="stations__variant-tabs">
        <button class="variant-tab ${state.variant==='grid'?'variant-tab--active':''}" data-variant="grid">GRID</button>
        <button class="variant-tab ${state.variant==='list'?'variant-tab--active':''}" data-variant="list">LIST</button>
      </div>

      <div class="stations__body" id="stations-body">
        ${renderVariant()}
      </div>

      <div class="stations__cta">
        <button class="cta-generate" id="generate-btn" ${state.selected.size ? '' : 'disabled'}>
          <span>Generate playlist</span>
          <span class="cta-generate__hint" id="generate-hint">
            ${state.selected.size ? `${state.selected.size} st · ${state.selected.size * 40} tracks` : 'Pick a station'}
          </span>
        </button>
      </div>
    </div>
  `;

  // search
  const searchEl = container.querySelector('#stations-search');
  searchEl.addEventListener('input', (e) => {
    state.search = e.target.value;
    document.getElementById('stations-body').innerHTML = renderVariant();
  });

  // variant toggle
  container.querySelector('.stations__variant-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.variant-tab');
    if (!btn) return;
    state.variant = btn.dataset.variant;
    localStorage.setItem(VARIANT_KEY, state.variant);
    container.querySelectorAll('.variant-tab').forEach(b =>
      b.classList.toggle('variant-tab--active', b.dataset.variant === state.variant));
    document.getElementById('stations-body').innerHTML = renderVariant();
  });

  // click delegation: select / deselect
  container.querySelector('#stations-body').addEventListener('click', (e) => {
    const pickEl = e.target.closest('[data-station]');
    if (!pickEl) return;
    const id = pickEl.dataset.station;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    persistSelected();
    refreshPickedChrome();
    pickEl.classList.toggle(pickEl.matches('.station-card') ? 'station-card--picked' : 'station-row--picked');
    const check = pickEl.querySelector('.material-symbols-outlined.check');
    // re-render variant to update inner bits cleanly
    document.getElementById('stations-body').innerHTML = renderVariant();
  });

  // generate
  container.querySelector('#generate-btn').addEventListener('click', () => {
    if (!state.selected.size) return;
    // Consume the click as a user gesture to unlock audio for the page
    // session — otherwise iOS / Android silently block the autoplay
    // that fires when the feed's IntersectionObserver kicks in.
    primeAudio();
    if (onGenerate) onGenerate([...state.selected]);
  });
}

function persistSelected() {
  localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
}

function refreshPickedChrome() {
  const hint  = document.getElementById('generate-hint');
  const picked = document.getElementById('stations-picked');
  const btn = document.getElementById('generate-btn');
  if (picked) picked.textContent = `${state.selected.size} picked`;
  if (hint) hint.textContent = state.selected.size
    ? `${state.selected.size} st · ${state.selected.size * 40} tracks`
    : 'Pick a station';
  if (btn) {
    if (state.selected.size) btn.removeAttribute('disabled');
    else btn.setAttribute('disabled', '');
  }
}

function renderVariant() {
  const filtered = filterStations(state.search);
  if (filtered.length === 0) {
    return `<div style="padding:40px 20px;text-align:center;" class="mono">No stations match “${escapeHtml(state.search)}”</div>`;
  }
  if (state.variant === 'list') return renderList(filtered);
  return renderGrid(filtered);
}

function renderGrid(list) {
  return `
    <div class="station-grid">
      ${list.map(renderCard).join('')}
    </div>
  `;
}

function renderCard(st) {
  const picked = state.selected.has(st.id);
  return `
    <button class="station-card ${picked ? 'station-card--picked' : ''}" data-station="${st.id}">
      <div class="station-card__top">
        <span class="station-card__dot"></span>
        <span class="station-card__meta">LIVE · ${escapeHtml(st.freq)}</span>
      </div>
      <div class="station-card__name">${escapeHtml(st.cc)} ${escapeHtml(st.name)}</div>
      <div class="station-card__tag">${escapeHtml(st.city.toUpperCase())} · ${escapeHtml(st.genre.toUpperCase())}</div>
      <div class="station-card__check">
        ${picked ? `<span class="material-symbols-outlined">check</span>` : ''}
      </div>
    </button>
  `;
}

function renderList(list) {
  const groups = {};
  list.forEach(st => { (groups[st.country] ||= []).push(st); });
  return `
    <div class="station-list">
      ${Object.entries(groups).map(([cc, group]) => `
        <div class="station-list__group">
          <div class="station-list__group-head">
            <span>${escapeHtml(cc)} · ${escapeHtml(group[0].cc)}</span>
            <span>${group.length} station${group.length !== 1 ? 's' : ''}</span>
          </div>
          ${group.map(renderRow).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

function renderRow(st) {
  const picked = state.selected.has(st.id);
  return `
    <button class="station-row ${picked ? 'station-row--picked' : ''}" data-station="${st.id}">
      <div class="station-row__bar"></div>
      <div class="station-row__main">
        <div class="station-row__name">${escapeHtml(st.name)}</div>
        <div class="station-row__meta">
          ${escapeHtml(st.city.toUpperCase())} · ${escapeHtml(st.freq)} · ${escapeHtml(st.genre.toUpperCase())}
        </div>
      </div>
      <div class="station-row__check">
        ${picked ? `<span class="material-symbols-outlined">check</span>` : ''}
      </div>
    </button>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
