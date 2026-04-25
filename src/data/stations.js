/**
 * RadioFlow v2 — Station catalog.
 *
 * Shape: { id, name, city, country, cc, freq, genre, color }
 * To add a station, append a row here AND register its ORB scrape URL
 * in scripts/refresh-playlists.js. The id must match across both.
 */

export const STATIONS = [
  { id: 'kink',          name: 'KINK',             city: 'Amsterdam',    country: 'NL', cc: '🇳🇱', freq: 'DAB+',  genre: 'Alternative',  color: '#D15A3A' },
  { id: 'nporadio2',     name: 'NPO Radio 2',      city: 'Hilversum',    country: 'NL', cc: '🇳🇱', freq: '88.0',  genre: 'Pop / AC',     color: '#E8B04A' },
  { id: 'pinguin',       name: 'Pinguin Radio',    city: 'Amsterdam',    country: 'NL', cc: '🇳🇱', freq: 'Web',   genre: 'Indie',        color: '#3A3A3A' },
  { id: 'bbc6',          name: 'BBC Radio 6',      city: 'London',       country: 'UK', cc: '🇬🇧', freq: 'DAB',   genre: 'Eclectic',     color: '#6A4A8A' },
  { id: 'fluxfm',        name: 'Flux FM',          city: 'Berlin',       country: 'DE', cc: '🇩🇪', freq: '100.6', genre: 'Indie',        color: '#7A4A4A' },
  { id: 'triplej',       name: 'Triple J',         city: 'Sydney',       country: 'AU', cc: '🇦🇺', freq: '105.7', genre: 'Alt / Rock',   color: '#D1A34A' },
  { id: 'radioswiss',    name: 'Radio Swiss Jazz', city: 'Zürich',       country: 'CH', cc: '🇨🇭', freq: '97.7',  genre: 'Jazz',         color: '#3A3A3A' },
  { id: 'kexp',          name: 'KEXP 90.3',        city: 'Seattle',      country: 'US', cc: '🇺🇸', freq: '90.3',  genre: 'Indie',        color: '#2F5A7A' },
  { id: 'willy',         name: 'Willy',            city: 'Brussels',     country: 'BE', cc: '🇧🇪', freq: '107.5', genre: 'Alt / Rock',   color: '#5A8A6A' },
  { id: 'wxpn',          name: 'WXPN 88.5',        city: 'Philadelphia', country: 'US', cc: '🇺🇸', freq: '88.5',  genre: 'AAA / Indie',  color: '#8A4A4A' },
  { id: 'kcrw',          name: 'KCRW',             city: 'Santa Monica', country: 'US', cc: '🇺🇸', freq: '89.9',  genre: 'Eclectic',     color: '#8A7A4A' },
  { id: 'radioparadise', name: 'Radio Paradise',   city: 'Paradise CA',  country: 'US', cc: '🇺🇸', freq: 'Web',   genre: 'Eclectic',     color: '#4A7A8A' },
];

export const COUNTRY_NAMES = {
  NL: 'Netherlands',
  UK: 'United Kingdom',
  DE: 'Germany',
  AU: 'Australia',
  CH: 'Switzerland',
  US: 'United States',
  BE: 'Belgium',
};

export function findStation(id) {
  return STATIONS.find(s => s.id === id) || null;
}

export function filterStations(q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return STATIONS;
  return STATIONS.filter(st =>
    [st.name, st.city, st.country, st.genre].join(' ').toLowerCase().includes(s)
  );
}
