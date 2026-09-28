/** Inline SVG icons: no icon-font download, no flash of ligature text. */
const P = {
  heart:      '<path d="M12 20.3 4.6 13a4.9 4.9 0 0 1 7-7l.4.4.4-.4a4.9 4.9 0 0 1 7 7Z"/>',
  play:       '<path d="M8 5.5v13l10.5-6.5Z"/>',
  pause:      '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/>',
  external:   '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  close:      '<path d="M6 6l12 12M18 6 6 18"/>',
  copy:       '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  download:   '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  trash:      '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  shuffle:    '<path d="M4 7h3.5c4 0 5 10 9 10H20m0 0-3-3m3 3-3 3M4 17h3.5c1.4 0 2.4-1.2 3.2-2.8M20 7h-3.5c-1.4 0-2.4 1.2-3.2 2.8M20 7l-3-3m3 3-3 3"/>',
  up:         '<path d="M12 19V5m-6 6 6-6 6 6"/>',
};
const FILLED = new Set(['heart', 'play', 'pause']);

export function icon(name, { filled, size = 24, label } = {}) {
  const fill = filled ?? FILLED.has(name);
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="ic ic--${name}" ${a11y} width="${size}" height="${size}" viewBox="0 0 24 24"
    fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${fill ? 0 : 1.8}"
    stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
}

/** Replace every [data-icon] placeholder inside root. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon, { size: +(el.dataset.size || 24) });
  });
}
