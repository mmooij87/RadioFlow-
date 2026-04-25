/**
 * RadioFlow v2 — Station catalog.
 *
 * Shape: { id, name, city, country, cc, freq, genre, listeners, color }
 * To add a new station, append a row and register the scrape URL in server/proxy.js.
 * The id must match the backend proxy route id.
 */

export const STATIONS = [
  { id: 'kink',       name: 'KINK',            city: 'Amsterdam',    country: 'NL', cc: '🇳🇱', freq: 'DAB+',  genre: 'Alternative',  color: '#D15A3A' },
  { id: 'nporadio2',  name: 'NPO Radio 2',     city: 'Hilversum',    country: 'NL', cc: '🇳🇱', freq: '88.0',  genre: 'Pop / AC',     color: '#E8B04A' },
  { id: 'npo3fm',     name: 'NPO 3FM',         city: 'Hilversum',    country: 'NL', cc: '🇳🇱', freq: '96.8',  genre: 'Pop / Rock',   color: '#2F5A7A' },
  { id: 'pinguin',    name: 'Pinguin Radio',   city: 'Amsterdam',    country: 'NL', cc: '🇳🇱', freq: 'Web',   genre: 'Indie',        color: '#3A3A3A' },
  { id: 'bbc6',       name: 'BBC Radio 6',     city: 'London',       country: 'UK', cc: '🇬🇧', freq: 'DAB',   genre: 'Eclectic',     color: '#6A4A8A' },
  { id: 'nts1',       name: 'NTS 1',           city: 'London',       country: 'UK', cc: '🇬🇧', freq: 'Web',   genre: 'Underground',  color: '#2A2A2A' },
  { id: 'fip',        name: 'FIP',             city: 'Paris',        country: 'FR', cc: '🇫🇷', freq: '105.1', genre: 'Eclectic',     color: '#C94A5A' },
  { id: 'rinsefr',    name: 'Rinse FR',        city: 'Paris',        country: 'FR', cc: '🇫🇷', freq: '106.4', genre: 'Electronic',   color: '#5A8A6A' },
  { id: 'fluxfm',     name: 'Flux FM',         city: 'Berlin',       country: 'DE', cc: '🇩🇪', freq: '100.6', genre: 'Indie',        color: '#7A4A4A' },
  { id: 'byte',       name: 'Byte.fm',         city: 'Hamburg',      country: 'DE', cc: '🇩🇪', freq: '91.7',  genre: 'Eclectic',     color: '#8A7A4A' },
  { id: 'kexp',       name: 'KEXP 90.3',       city: 'Seattle',      country: 'US', cc: '🇺🇸', freq: '90.3',  genre: 'Indie',        color: '#2F5A7A' },
  { id: 'kcrw',       name: 'KCRW',            city: 'Santa Monica', country: 'US', cc: '🇺🇸', freq: '89.9',  genre: 'Eclectic',     color: '#8A7A4A' },
  { id: 'triplej',    name: 'Triple J',        city: 'Sydney',       country: 'AU', cc: '🇦🇺', freq: '105.7', genre: 'Alt / Rock',   color: '#D1A34A' },
  { id: 'radioswiss', name: 'Radio Swiss Jazz',city: 'Zürich',       country: 'CH', cc: '🇨🇭', freq: '97.7',  genre: 'Jazz',         color: '#3A3A3A' },
];

export const COUNTRY_NAMES = {
  NL: 'Netherlands', UK: 'United Kingdom', FR: 'France', DE: 'Germany',
  US: 'United States', AU: 'Australia', CH: 'Switzerland',
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
