/**
 * Generate overlay — short animated transition while we pull from the
 * pre-built playlists.json. Data is effectively instant now, so the
 * overlay is mostly UX flavour, capped at ~1.5s.
 */
import { findStation } from '../data/stations.js';
import { buildMosaic } from '../services/dataService.js';

const FEED_MAX     = 60;
const TARGET_MS    = 1500;   // minimum visible time so it doesn't flash
const COUNT_STEP_MS = 18;

export function runGenerate(selectedIds, onDone, onCancel) {
  const root = document.createElement('div');
  root.className = 'generate';
  root.innerHTML = `
    <div class="generate__head">
      <div>
        <div class="mono mono--light">Generate · instant</div>
        <div style="font-size:20px;font-weight:600;letter-spacing:-.3px;margin-top:4px;color:var(--light)">Building your mix</div>
      </div>
      <button class="generate__close" aria-label="Cancel" data-action="cancel">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>

    <div class="generate__body">
      <div>
        <span class="generate__count" id="gen-count">00</span><span class="generate__count-total"> / ${FEED_MAX}</span>
      </div>
      <div class="generate__status" id="gen-status">Picking random tracks across your stations.</div>
    </div>

    <div class="generate__fills" id="gen-fills"></div>
  `;

  const fills = root.querySelector('#gen-fills');
  const stations = selectedIds.map(id => findStation(id)).filter(Boolean);
  stations.slice(0, 6).forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'fill-row';
    row.innerHTML = `
      <span class="fill-row__label">${st.cc} ${st.country}</span>
      <div class="fill-row__track"><div class="fill-row__bar" data-bar></div></div>
      <span class="fill-row__pct" data-pct>0%</span>
    `;
    fills.appendChild(row);
    animateFill(row, i * 80);
  });
  if (stations.length > 6) {
    const more = document.createElement('div');
    more.className = 'mono mono--light';
    more.textContent = `+${stations.length - 6} more`;
    fills.appendChild(more);
  }

  document.body.appendChild(root);

  const buildPromise = buildMosaic(FEED_MAX).catch(err => {
    console.error('buildMosaic failed', err);
    return [];
  });

  // Animate the count up to whatever buildMosaic returns.
  const countEl = root.querySelector('#gen-count');
  let displayed = 0;
  let target = FEED_MAX;
  const counter = setInterval(() => {
    if (displayed >= target) { clearInterval(counter); return; }
    displayed++;
    if (countEl) countEl.textContent = String(displayed).padStart(2, '0');
  }, COUNT_STEP_MS);

  buildPromise.then(tracks => { target = tracks.length; });

  const minTime = new Promise(r => setTimeout(r, TARGET_MS));
  Promise.all([minTime, buildPromise]).then(([, tracks]) => {
    cleanup();
    if (onDone) onDone(tracks);
  });

  root.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    cleanup();
    if (onCancel) onCancel();
  });

  function cleanup() {
    clearInterval(counter);
    root.remove();
  }
}

function animateFill(rowEl, delayMs) {
  const bar = rowEl.querySelector('[data-bar]');
  const pct = rowEl.querySelector('[data-pct]');
  let fill = 0;
  setTimeout(() => {
    const iv = setInterval(() => {
      fill += 0.18 + Math.random() * 0.12;
      if (fill >= 1) {
        fill = 1;
        clearInterval(iv);
        bar.classList.add('fill-row__bar--done');
        pct.textContent = 'OK';
      } else {
        pct.textContent = `${Math.round(fill * 100)}%`;
      }
      bar.style.width = `${fill * 100}%`;
    }, 60);
  }, delayMs);
}
