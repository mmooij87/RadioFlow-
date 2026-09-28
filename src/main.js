/**
 * RadioFlow v2 — entry point.
 */
import { route, navigate, initRouter } from './router.js';
import { renderStations } from './pages/stations.js';
import { renderFeed, clearFeed, setFeedTracks, leaveFeed } from './pages/mosaic.js';
import { renderFavorites } from './pages/favorites.js';
import { runGenerate } from './pages/generate.js';
import { stopPreview } from './components/audioPlayer.js';
import { getFavorites, onFavoritesChange } from './services/favoritesService.js';

route('/stations', (container) => {
  leaveFeed();
  stopPreview();
  renderStations(container, (selectedStations) => {
    localStorage.setItem('radioflow_stations', JSON.stringify(selectedStations));
    clearFeed();
    runGenerate(selectedStations, (tracks) => {
      // Reuse the mix the overlay just built instead of building a second,
      // differently-shuffled one on the feed page.
      setFeedTracks(tracks);
      navigate('/feed');
    }, () => {
      // cancel: stay on stations
    });
  });
});

route('/feed', async (container) => {
  await renderFeed(container);
});

// backward-compat aliases
route('/mosaic', async (container) => { await renderFeed(container); });
route('/favorites', (container) => {
  leaveFeed();
  stopPreview();
  renderFavorites(container);
});

route('/liked', (container) => {
  leaveFeed();
  stopPreview();
  renderFavorites(container);
});

// Keep the liked nav badge in sync
function syncLikedBadge() {
  const badge = document.getElementById('nav-liked-badge');
  if (!badge) return;
  const n = getFavorites().length;
  if (n > 0) { badge.textContent = String(n); badge.hidden = false; }
  else { badge.hidden = true; }
}
onFavoritesChange(syncLikedBadge);
syncLikedBadge();

initRouter();
