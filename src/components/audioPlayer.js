/**
 * Audio Player — shared singleton wrapping the global <audio> element.
 *
 * Mobile autoplay policy: iOS Safari and most Android browsers block any
 * `audio.play()` that wasn't initiated by a user gesture. We track an
 * `unlocked` flag — flipped to `true` after the first successful play()
 * — and expose `tryAutoplay()` for code paths (intersection observer, slide
 * boot) that want to auto-play but should silently no-op until the user
 * has tapped at least once.
 */

let audioEl = null;
let currentTrackId = null;
let unlocked = false;
const listeners = { play: new Set(), pause: new Set(), end: new Set() };

function getAudio() {
  if (!audioEl) {
    audioEl = document.getElementById('audio-player');
    if (audioEl) {
      audioEl.addEventListener('play',  () => listeners.play .forEach(fn => fn(currentTrackId)));
      audioEl.addEventListener('pause', () => listeners.pause.forEach(fn => fn(currentTrackId)));
      audioEl.addEventListener('ended', () => {
        const id = currentTrackId;
        currentTrackId = null;
        listeners.end.forEach(fn => fn(id));
      });
      audioEl.addEventListener('error', () => {
        const id = currentTrackId;
        currentTrackId = null;
        listeners.end.forEach(fn => fn(id));
      });
    }
  }
  return audioEl;
}

/**
 * Start playing a preview from a real user gesture (tap/click).
 * On success, marks the audio context as unlocked so subsequent
 * tryAutoplay() calls (e.g. on slide swipe) actually play.
 *
 * @returns Promise<boolean> — true if play started, false if blocked / error.
 */
export async function playPreview(previewUrl, trackId) {
  const audio = getAudio();
  if (!audio || !previewUrl) return false;

  if (currentTrackId === trackId && !audio.paused) {
    audio.pause();
    return false;
  }

  audio.pause();
  audio.src = previewUrl;
  audio.volume = 0.7;
  currentTrackId = trackId;

  try {
    await audio.play();
    unlocked = true;
    return true;
  } catch (err) {
    console.warn('Audio playback failed:', err.message || err);
    currentTrackId = null;
    return false;
  }
}

/**
 * Attempt autoplay (e.g. on swipe). No-op until the user has unlocked
 * audio with a real gesture, so we never trip the autoplay block silently.
 */
export async function tryAutoplay(previewUrl, trackId) {
  if (!unlocked) return false;
  return playPreview(previewUrl, trackId);
}

export function stopPreview() {
  const audio = getAudio();
  if (audio) {
    audio.pause();
    audio.src = '';
  }
  const id = currentTrackId;
  currentTrackId = null;
  if (id) listeners.end.forEach(fn => fn(id));
}

export function pausePreview() {
  const audio = getAudio();
  if (audio && !audio.paused) audio.pause();
}

export function isAudioUnlocked() { return unlocked; }
export function getCurrentTrackId() { return currentTrackId; }
export function isPlaying(trackId) {
  const audio = getAudio();
  return currentTrackId === trackId && audio && !audio.paused;
}

/**
 * Subscribe to audio lifecycle events. Returns an unsubscribe fn.
 */
export function onAudio({ onPlay, onPause, onEnd } = {}) {
  if (onPlay)  listeners.play .add(onPlay);
  if (onPause) listeners.pause.add(onPause);
  if (onEnd)   listeners.end  .add(onEnd);
  return () => {
    if (onPlay)  listeners.play .delete(onPlay);
    if (onPause) listeners.pause.delete(onPause);
    if (onEnd)   listeners.end  .delete(onEnd);
  };
}

/**
 * Backwards-compatible wrapper used by mosaic.js initialisation.
 */
export function setCallbacks({ onPlay, onStop } = {}) {
  if (onPlay) listeners.play.add(onPlay);
  if (onStop) {
    listeners.pause.add(onStop);
    listeners.end.add(onStop);
  }
}
