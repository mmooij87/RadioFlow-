/**
 * The tuning dial — the app's one bold element.
 *
 * Every station sits on a horizontal radio scale. Tap a station to switch
 * it on/off; lit stations feed the mix. A needle glides to the station the
 * current song came from, so "where did this come from?" is answered
 * without a single label.
 */
const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createDial(root, { stations, selected, onToggle }) {
  let counts = {};
  let needleId = null;

  root.innerHTML = `
    <p class="dial__hint" id="dial-hint">Tap a station to start listening</p>
    <div class="dial__window" id="dial-window">
      <div class="dial__scale" role="group" aria-label="Stations, tap to switch on or off">
        ${stations.map(st => `
          <button class="dial__st" data-id="${st.id}" aria-pressed="false"
            title="${st.name}, ${st.city}">
            <span class="dial__freq">${st.freq}</span>
            <span class="dial__name">${st.name}</span>
            <span class="dial__city">${st.cc}&#8201;${st.city}</span>
          </button>`).join('')}
        <span class="dial__needle" aria-hidden="true"></span>
      </div>
    </div>`;

  const win = root.querySelector('#dial-window');
  const needle = root.querySelector('.dial__needle');
  const hint = root.querySelector('#dial-hint');

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.dial__st');
    if (!btn) return;
    const id = btn.dataset.id;
    const on = !selected.has(id);
    onToggle(id, on);      // caller mutates `selected` and calls render()
  });

  // Horizontal wheel on desktop: let a vertical wheel scroll the dial.
  win.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      win.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  function render() {
    root.querySelectorAll('.dial__st').forEach(btn => {
      const id = btn.dataset.id;
      const on = selected.has(id);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('dial__st--on', on);
      btn.classList.toggle('dial__st--quiet', counts[id] === 0);
      btn.classList.toggle('dial__st--tuned', id === needleId);
    });
    root.classList.toggle('dial--empty', selected.size === 0);
    hint.hidden = selected.size !== 0;
  }

  function setNeedle(id) {
    needleId = id;
    const btn = id && root.querySelector(`.dial__st[data-id="${id}"]`);
    if (!btn) { needle.classList.remove('dial__needle--show'); render(); return; }
    const x = btn.offsetLeft + btn.offsetWidth / 2;
    needle.style.transform = `translateX(${x}px)`;
    needle.classList.add('dial__needle--show');
    const target = x - win.clientWidth / 2;
    win.scrollTo({ left: target, behavior: reduceMotion() ? 'auto' : 'smooth' });
    render();
  }

  function setCounts(c) { counts = c || {}; render(); }

  // Re-place the needle when the layout width changes (rotation, resize).
  new ResizeObserver(() => { if (needleId) setNeedle(needleId); }).observe(win);

  render();
  return { render, setNeedle, setCounts };
}
