/**
 * Audio Player — shared singleton wrapping the global <audio> element.
 *
 * Mobile autoplay policy: iOS Safari and Android Chrome silently block any
 * `audio.play()` not initiated by a user gesture. We prime the element with
 * a tiny silent WAV inside the Generate button click — that consumes the
 * gesture activation and unlocks audio for the rest of the page session,
 * so the intersection-observer-driven autoplay on swipe just works.
 */

// 100ms silent WAV. Used to consume the user gesture and unlock audio.
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

let audioEl = null;
let currentTrackId = null;
let primed = false;
const listeners = { play: new Set(), pause: new Set(), end: new Set(), error: new Set() };

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
        const code = audioEl.error?.code;
        const id = currentTrackId;
        currentTrackId = null;
        listeners.error.forEach(fn => fn({ id, code }));
      });
    }
  }
  return audioEl;
}

/**
 * Consume a user-gesture to unlock audio for the page session.
 * Must be called *synchronously* inside a click/touchend handler.
 */
export function primeAudio() {
  if (primed) return;
  const audio = getAudio();
  if (!audio) return;
  audio.muted = true;
  audio.src = SILENT_WAV;
  const p = audio.play();
  if (p && p.then) {
    p.then(() => {
      audio.pause();
      audio.muted = false;
      audio.src = '';
      primed = true;
    }).catch((err) => {
      audio.muted = false;
      console.warn('Audio prime failed:', err?.message || err);
    });
  } else {
    primed = true;
  }
}

/**
 * Play a preview. Returns Promise<boolean> — true on success.
 */
export async function playPreview(previewUrl, trackId) {
  const audio = getAudio();
  if (!audio || !previewUrl) return false;

  // toggle: if same track is currently playing, pause instead
  if (currentTrackId === trackId && !audio.paused) {
    audio.pause();
    return false;
  }

  audio.pause();
  audio.muted = false;
  audio.src = previewUrl;
  audio.volume = 1;
  currentTrackId = trackId;

  try {
    await audio.play();
    primed = true;
    return true;
  } catch (err) {
    console.warn('Audio playback failed:', err?.message || err);
    listeners.error.forEach(fn => fn({ id: trackId, message: err?.message }));
    return false;
  }
}

export function pausePreview() {
  const audio = getAudio();
  if (audio && !audio.paused) audio.pause();
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

export function getCurrentTrackId() { return currentTrackId; }

export function isPlaying(trackId) {
  const audio = getAudio();
  return currentTrackId === trackId && audio && !audio.paused;
}

export function onAudio({ onPlay, onPause, onEnd, onError } = {}) {
  if (onPlay)  listeners.play .add(onPlay);
  if (onPause) listeners.pause.add(onPause);
  if (onEnd)   listeners.end  .add(onEnd);
  if (onError) listeners.error.add(onError);
  return () => {
    if (onPlay)  listeners.play .delete(onPlay);
    if (onPause) listeners.pause.delete(onPause);
    if (onEnd)   listeners.end  .delete(onEnd);
    if (onError) listeners.error.delete(onError);
  };
}

// Backwards-compatible shim used by older callers.
export function setCallbacks({ onPlay, onStop } = {}) {
  if (onPlay) listeners.play.add(onPlay);
  if (onStop) {
    listeners.pause.add(onStop);
    listeners.end.add(onStop);
  }
}
