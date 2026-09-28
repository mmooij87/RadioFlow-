/**
 * The tuning dial — the app's one bold element.
 *
 * Every station on the listener's dial sits on a horizontal radio scale.
 * Tap a station to switch it on/off; lit stations feed the mix. A needle
 * glides to the station the current song came from. The scale ends in an
 * "Add" slot that opens the station search.
 */
import { stationTopLine, stationPlace } from '../services/stationStore.js';
import { icon } from './icons.js';

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const HOLD_MS = 480;

export function createDial(root, { onToggle, onAdd, onSolo, onUnsolo }) {
  let stations = [];
  let selected = new Set();
  let solo = null;
  let counts = {};
  let needleId = null;

  root.innerHTML = `
    <p class="dial__hint" id="dial-hint" hidden>Tap a station to start listening</p>
    <div class="dial__solo" id="dial-solo" hidden>
      <span class="dial__solo-text"></span>
      <button class="dial__solo-btn" data-act="unsolo">Hear all stations</button>
    </div>
    <div class="dial__window" id="dial-window">
      <div class="dial__scale" role="group" aria-label="Stations, tap to switch on or off"></div>
    </div>`;
  const win = root.querySelector('#dial-window');
  const scale = root.querySelector('.dial__scale');
  const hint = root.querySelector('#dial-hint');

  const soloBar = root.querySelector('#dial-solo');

  // Press and hold a station (or right-click it) to hear only that one.
  let hold = null;
  let swallowClick = false;
  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.dial__st');
    if (!btn || e.button > 0) return;
    hold = { id: btn.dataset.id, x: e.clientX, y: e.clientY, btn };
    btn.classList.add('dial__st--holding');
    hold.timer = setTimeout(() => {
      swallowClick = true;
      btn.classList.remove('dial__st--holding');
      navigator.vibrate?.(15);
      soloToggle(hold.id);
      hold = null;
    }, HOLD_MS);
  });
  const cancelHold = () => {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold.btn.classList.remove('dial__st--holding');
    hold = null;
  };
  root.addEventListener('pointermove', (e) => {
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 10) cancelHold();
  });
  root.addEventListener('pointerup', cancelHold);
  root.addEventListener('pointercancel', cancelHold);
  root.addEventListener('pointerleave', cancelHold);
  root.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('.dial__st');
    if (!btn) return;
    e.preventDefault();
    if (swallowClick) return;            // touch long-press already handled it
    soloToggle(btn.dataset.id);
  });
  // Keyboard: Shift+Enter on a focused station.
  root.addEventListener('keydown', (e) => {
    const btn = e.target.closest('.dial__st');
    if (btn && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); soloToggle(btn.dataset.id); }
  });

  function soloToggle(id) {
    if (solo === id) onUnsolo(); else onSolo(id);
  }

  root.addEventListener('click', (e) => {
    if (swallowClick) { swallowClick = false; e.preventDefault(); return; }
    if (e.target.closest('[data-act="unsolo"]')) { onUnsolo(); return; }
    if (e.target.closest('.dial__add')) { onAdd(); return; }
    const btn = e.target.closest('.dial__st');
    if (btn) onToggle(btn.dataset.id, !selected.has(btn.dataset.id));
  });

  // Let a vertical mouse wheel scroll the dial sideways on desktop.
  win.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { win.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  function setStations(list, sel) {
    stations = list;
    selected = sel;
    scale.innerHTML = `
      ${stations.map(st => `
        <button class="dial__st" data-id="${esc(st.id)}" aria-pressed="false"
          title="${esc(st.name)}${st.city ? ', ' + esc(st.city) : ''}. Press and hold to hear only this station.">
          <span class="dial__freq">${esc(stationTopLine(st))}</span>
          <span class="dial__name">${esc(st.name)}</span>
          <span class="dial__city">${esc(stationPlace(st))}</span>
        </button>`).join('')}
      <button class="dial__add" aria-label="Add or remove stations">
        <span class="dial__add-icon">${icon('plus', { size: 20 })}</span>
        <span class="dial__name">Add</span>
      </button>
      <span class="dial__needle" aria-hidden="true"></span>`;
    render();
    if (needleId) requestAnimationFrame(() => setNeedle(needleId, { instant: true }));
  }

  function setSelected(sel) { selected = sel; render(); }
  function setSolo(id) { solo = id; render(); }

  function render() {
    scale.querySelectorAll('.dial__st').forEach(btn => {
      const id = btn.dataset.id;
      const on = selected.has(id);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('dial__st--on', on);
      btn.classList.toggle('dial__st--quiet', counts[id] === 0);
      btn.classList.toggle('dial__st--tuned', id === needleId);
    });
    scale.querySelectorAll('.dial__st').forEach(btn => btn.classList.toggle('dial__st--solo', btn.dataset.id === solo));
    root.classList.toggle('dial--empty', selected.size === 0);
    root.classList.toggle('dial--solo', !!solo);
    hint.hidden = selected.size !== 0;
    const st = solo && stations.find(s => s.id === solo);
    soloBar.hidden = !st;
    document.body.classList.toggle('is-solo', !!st);   // makes room above the dial
    if (st) soloBar.querySelector('.dial__solo-text').textContent = `Only ${st.name}`;
  }

  function setNeedle(id, { instant = false } = {}) {
    needleId = id;
    const needle = scale.querySelector('.dial__needle');
    const btn = id && scale.querySelector(`.dial__st[data-id="${cssEsc(id)}"]`);
    if (!btn || !needle) { needle?.classList.remove('dial__needle--show'); render(); return; }
    const x = btn.offsetLeft + btn.offsetWidth / 2;
    needle.style.transform = `translateX(${x}px)`;
    needle.classList.add('dial__needle--show');
    win.scrollTo({ left: x - win.clientWidth / 2, behavior: instant || reduceMotion() ? 'auto' : 'smooth' });
    render();
  }

  function setCounts(c) { counts = { ...counts, ...c }; render(); }

  new ResizeObserver(() => { if (needleId) setNeedle(needleId, { instant: true }); }).observe(win);

  return { setStations, setSelected, setSolo, setNeedle, setCounts };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function cssEsc(s) { return window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
