/**
 * Audio Player — shared singleton for managing preview playback
 */

let audioEl = null;
let currentTrackId = null;
let onPlayCallback = null;
let onStopCallback = null;

function getAudio() {
  if (!audioEl) {
    audioEl = document.getElementById('audio-player');
    if (audioEl) {
      audioEl.addEventListener('ended', () => {
        const stoppedId = currentTrackId;
        currentTrackId = null;
        if (onStopCallback) onStopCallback(stoppedId);
      });
      audioEl.addEventListener('error', () => {
        const stoppedId = currentTrackId;
        currentTrackId = null;
        if (onStopCallback) onStopCallback(stoppedId);
      });
    }
  }
  return audioEl;
}

/**
 * Play a preview URL. If the same track is already playing, stop it.
 * @param {string} previewUrl - URL to the 30s MP3 preview
 * @param {string} trackId - unique track identifier
 * @returns {boolean} true if started playing, false if stopped
 */
export function playPreview(previewUrl, trackId) {
  const audio = getAudio();
  if (!audio) return false;

  // If same track is playing, stop it
  if (currentTrackId === trackId) {
    stopPreview();
    return false;
  }

  // Stop any current playback
  audio.pause();
  const prevId = currentTrackId;
  if (prevId && onStopCallback) onStopCallback(prevId);

  // Start new track
  audio.src = previewUrl;
  audio.volume = 0.7;
  currentTrackId = trackId;

  audio.play().catch(err => {
    console.warn('Audio playback failed:', err);
    currentTrackId = null;
    if (onStopCallback) onStopCallback(trackId);
  });

  if (onPlayCallback) onPlayCallback(trackId);
  return true;
}

/**
 * Stop current playback.
 */
export function stopPreview() {
  const audio = getAudio();
  if (audio) {
    audio.pause();
    audio.src = '';
  }
  const stoppedId = currentTrackId;
  currentTrackId = null;
  if (stoppedId && onStopCallback) onStopCallback(stoppedId);
}

/**
 * Check if a specific track is currently playing.
 */
export function isPlaying(trackId) {
  return currentTrackId === trackId;
}

/**
 * Get the currently playing track ID.
 */
export function getCurrentTrackId() {
  return currentTrackId;
}

/**
 * Set callbacks for play/stop events.
 */
export function setCallbacks({ onPlay, onStop }) {
  if (onPlay) onPlayCallback = onPlay;
  if (onStop) onStopCallback = onStop;
}
