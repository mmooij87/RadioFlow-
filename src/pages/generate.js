/**
 * Generate overlay — optimistic UI while buildMosaic() runs in the background.
 * Simulates per-station parallel fills + network log.
 * Target ≤ 10s from tap to feed.
 */
import { findStation } from '../data/stations.js';
import { buildMosaic } from '../services/dataService.js';

const TARGET_MS = 8000;

export function runGenerate(selectedIds, onDone, onCancel) {
  const root = document.createElement('div');
  root.className = 'generate';
  root.innerHTML = `
    <div class="generate__head">
      <div>
        <div class="mono mono--light">Generate · target ≤ 10s</div>
        <div style="font-size:20px;font-weight:600;letter-spacing:-.3px;margin-top:4px;color:var(--light)">Building your mix</div>
      </div>
      <button class="generate__close" aria-label="Cancel" data-action="cancel">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>

    <div class="generate__body">
      <div>
        <span class="generate__count" id="gen-count">00</span><span class="generate__count-total"> / 20</span>
      </div>
      <div class="generate__status" id="gen-status">Reading last 24h plays across your stations.</div>
    </div>

    <div class="generate__fills" id="gen-fills"></div>

    <div class="generate__log" id="gen-log">
      <div class="generate__log-header">Network log</div>
    </div>
  `;

  const fills = root.querySelector('#gen-fills');
  const stations = selectedIds.map(id => findStation(id)).filter(Boolean);
  stations.slice(0, 6).forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'fill-row';
    row.dataset.stationId = st.id;
    row.innerHTML = `
      <span class="fill-row__label">${st.cc} ${st.country}</span>
      <div class="fill-row__track">
        <div class="fill-row__bar" data-bar></div>
      </div>
      <span class="fill-row__pct" data-pct>0%</span>
    `;
    fills.appendChild(row);
    animateFill(row, i * 220);
  });
  if (stations.length > 6) {
    const more = document.createElement('div');
    more.className = 'mono mono--light';
    more.textContent = `+${stations.length - 6} more fetched in parallel`;
    fills.appendChild(more);
  }

  document.body.appendChild(root);

  // simulated phase log
  const logEl = root.querySelector('#gen-log');
  const statusEl = root.querySelector('#gen-status');
  const countEl = root.querySelector('#gen-count');
  const phases = [
    { t:  300, msg: 'CACHE HIT · edge', status: 'Reading last 24h plays across your stations.' },
    { t: 1200, msg: `FETCH last 24h · ${stations.length}/${stations.length} stations` },
    { t: 2400, msg: 'FIRST 5 SONGS READY · 2.4s', status: 'Streaming matched songs. First few already playable.' },
    { t: 4000, msg: 'MATCH spotify · 14/20' },
    { t: 6200, msg: 'DEDUP · 3 repeats removed' },
    { t: 7600, msg: 'READY · 20 songs', status: 'Mix ready. Launching…' },
  ];
  const timers = phases.map(ph => setTimeout(() => {
    const row = document.createElement('div');
    row.className = 'generate__log-row';
    row.innerHTML = `<span class="generate__log-t">${(ph.t/1000).toFixed(1)}s</span><span>${ph.msg}</span>`;
    logEl.appendChild(row);
    // keep only the last 4 rows (plus header)
    while (logEl.children.length > 5) logEl.removeChild(logEl.children[1]);
    if (ph.status && statusEl) statusEl.textContent = ph.status;
  }, ph.t));

  // count animation
  let n = 0;
  const counter = setInterval(() => {
    n = Math.min(n + 1, 20);
    if (countEl) countEl.textContent = String(n).padStart(2, '0');
    if (n >= 20) clearInterval(counter);
  }, 300);

  // fire real buildMosaic in parallel
  const buildPromise = buildMosaic(20).catch(err => {
    console.error('buildMosaic failed', err);
    return [];
  });

  // whichever finishes last between target and actual build
  const targetElapsed = new Promise(r => setTimeout(r, TARGET_MS));
  Promise.all([targetElapsed, buildPromise]).then(([, tracks]) => {
    cleanup();
    if (onDone) onDone(tracks);
  });

  // cancel
  root.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    cleanup();
    if (onCancel) onCancel();
  });

  function cleanup() {
    timers.forEach(clearTimeout);
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
      fill += 0.04 + Math.random() * 0.04;
      if (fill >= 1) {
        fill = 1;
        clearInterval(iv);
        bar.classList.add('fill-row__bar--done');
        pct.textContent = 'OK';
      } else {
        pct.textContent = `${Math.round(fill * 100)}%`;
      }
      bar.style.width = `${fill * 100}%`;
    }, 100);
  }, delayMs);
}
