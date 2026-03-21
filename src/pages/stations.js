/**
 * Page 1: Station Selection — "Choose Your Sound"
 */

const STATIONS = [
  { id: 'main', name: 'Kink FM', tag: 'Alternative', icon: 'radio' },
  { id: 'pinguin', name: 'Pinguin Radio', tag: 'Indie', icon: 'album' },
  { id: 'bbc6', name: 'BBC Radio 6', tag: 'Music', icon: 'music_note' },
  { id: 'fluxfm', name: 'Flux FM', tag: 'Berlin', icon: 'podcasts' },
  { id: 'npo3fm', name: 'NPO 3FM', tag: 'Pop/Rock', icon: 'speaker' },
  { id: 'nporadio2', name: 'NPO Radio 2', tag: 'Hits', icon: 'history' },
];

let selectedStations = new Set(['main']);

export function renderStations(container, onGenerate) {
  selectedStations = new Set(['main']);

  container.innerHTML = `
    <div class="stations-page page-enter">
      <section class="stations-hero">
        <h2 class="stations-hero__title">
          CHOOSE YOUR <span class="stations-hero__accent">SOUND</span>
        </h2>
        <p class="stations-hero__subtitle">
          Select 1 to 3 stations to fuse into your custom sonic profile. We'll generate a brutalist mix based on your frequency.
        </p>
      </section>

      <div class="station-grid" id="station-grid">
        ${STATIONS.map(s => `
          <div class="station-card ${selectedStations.has(s.id) ? 'station-card--selected' : ''}"
               data-station="${s.id}" id="station-${s.id}">
            <div class="station-card__header">
              <span class="material-symbols-outlined station-card__icon">${s.icon}</span>
              <span class="material-symbols-outlined station-card__check">check_circle</span>
            </div>
            <div class="station-card__info">
              <span class="station-card__tag">${s.tag}</span>
              <h3 class="station-card__name">${s.name}</h3>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="stations-action">
        <button class="btn-primary btn-primary--full" id="generate-btn">
          GENERATE PLAYLIST
          <span class="material-symbols-outlined">bolt</span>
        </button>
        <p class="stations-count" id="stations-count">${selectedStations.size} Station${selectedStations.size !== 1 ? 's' : ''} Selected</p>
      </div>

      <!-- Loading Overlay -->
      <div class="loading-overlay" id="loading-overlay">
        <div class="loading-spinner">
          <div class="loading-spinner__ring"></div>
          <div class="loading-spinner__ring loading-spinner__ring--active"></div>
          <div class="loading-spinner__icon">
            <span class="material-symbols-outlined">graphic_eq</span>
          </div>
        </div>
        <h2 class="text-headline-lg" style="margin-bottom: 8px;">Amplifying Signals</h2>
        <p class="text-body-md color-on-surface-v" id="loading-text">Mixing frequencies...</p>
      </div>
    </div>
  `;

  // Station selection logic
  const grid = document.getElementById('station-grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.station-card');
    if (!card) return;

    const id = card.dataset.station;

    if (selectedStations.has(id)) {
      if (selectedStations.size > 1) {
        selectedStations.delete(id);
        card.classList.remove('station-card--selected');
      }
    } else if (selectedStations.size < 3) {
      selectedStations.add(id);
      card.classList.add('station-card--selected');
    }

    updateCount();
  });

  // Generate button
  const genBtn = document.getElementById('generate-btn');
  genBtn.addEventListener('click', () => {
    if (selectedStations.size === 0) return;

    const overlay = document.getElementById('loading-overlay');
    const loadingText = document.getElementById('loading-text');
    const names = [...selectedStations].map(id =>
      STATIONS.find(s => s.id === id)?.name || id
    );
    loadingText.textContent = `Mixing ${names.join(' and ')} frequencies...`;
    overlay.classList.add('loading-overlay--visible');

    // Navigate to mosaic after a short delay
    setTimeout(() => {
      overlay.classList.remove('loading-overlay--visible');
      if (onGenerate) onGenerate([...selectedStations]);
    }, 2000);
  });
}

function updateCount() {
  const el = document.getElementById('stations-count');
  if (el) {
    el.textContent = `${selectedStations.size} Station${selectedStations.size !== 1 ? 's' : ''} Selected`;
  }
}
