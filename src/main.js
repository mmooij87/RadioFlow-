/**
 * RadioFlow — Main Entry Point
 */
import { route, navigate, initRouter } from './router.js';
import { renderStations } from './pages/stations.js';
import { renderFeed, clearFeed } from './pages/mosaic.js';
import { renderFavorites } from './pages/favorites.js';
import { stopPreview } from './components/audioPlayer.js';

// Register routes
route('/stations', (container) => {
  stopPreview();
  renderStations(container, (selectedStations) => {
    localStorage.setItem('radioflow_stations', JSON.stringify(selectedStations));
    clearFeed();
    // After generating, navigate to feed
    navigate('/feed');
  });
});

route('/feed', async (container) => {
  await renderFeed(container);
});

// Keep /mosaic as alias for backwards compat
route('/mosaic', async (container) => {
  await renderFeed(container);
});

route('/favorites', (container) => {
  stopPreview();
  renderFavorites(container);
});

// Initialize
initRouter();
