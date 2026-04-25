/**
 * Favorites Service — LocalStorage-backed favorites manager
 */

const STORAGE_KEY = 'radioflow_favorites';

// Event system for cross-page reactivity
const listeners = new Set();

function notify() {
  listeners.forEach(fn => fn(getFavorites()));
}

/**
 * Subscribe to favorites changes.
 * @param {Function} fn - callback receiving updated favorites array
 * @returns {Function} unsubscribe function
 */
export function onFavoritesChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Get all favorites from storage.
 */
export function getFavorites() {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

/**
 * Add a track to favorites.
 */
export function addFavorite(track) {
  const favorites = getFavorites();
  if (!favorites.find(f => f.id === track.id)) {
    favorites.unshift({
      id: track.id,
      artist: track.artist,
      title: track.title,
      album: track.album || '',
      coverArt: track.coverArt || null,
      previewUrl: track.previewUrl || null,
      duration: track.duration || null,
      genre: track.genre || 'rock',
      deezerLink: track.deezerLink || null,
      addedAt: Date.now(),
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
    notify();
  }
}

/**
 * Remove a track from favorites.
 */
export function removeFavorite(trackId) {
  const favorites = getFavorites().filter(f => f.id !== trackId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  notify();
}

/**
 * Check if a track is favorited.
 */
export function isFavorite(trackId) {
  return getFavorites().some(f => f.id === trackId);
}

/**
 * Toggle favorite state.
 * @returns {boolean} new state (true = now favorited)
 */
export function toggleFavorite(track) {
  if (isFavorite(track.id)) {
    removeFavorite(track.id);
    return false;
  } else {
    addFavorite(track);
    return true;
  }
}

/**
 * Clear all favorites.
 */
export function clearFavorites() {
  localStorage.removeItem(STORAGE_KEY);
  notify();
}
