/**
 * Lock-screen / headphone controls via the Media Session API.
 * Silently does nothing where unsupported.
 */
const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : null;

export function initMediaSession({ onPlay, onPause, onNext, onPrev }) {
  if (!ms) return;
  const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
  set('play', onPlay);
  set('pause', onPause);
  set('nexttrack', onNext);
  set('previoustrack', onPrev);
}

export function setNowPlaying(track) {
  if (!ms || !track || typeof MediaMetadata === 'undefined') return;
  const art = track.coverArt;
  ms.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: `Played on ${track.station}`,
    artwork: art ? [
      { src: art.replace(/\/\d+x\d+bb\.jpg$/, '/256x256bb.jpg'), sizes: '256x256', type: 'image/jpeg' },
      { src: art, sizes: '1000x1000', type: 'image/jpeg' },
    ] : [],
  });
}

export function setPlaybackState(state) {
  if (ms) ms.playbackState = state;
}
