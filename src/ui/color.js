/**
 * Pull a background tint out of the cover art.
 *
 * Draws the cover at 24×24 into a canvas and picks a colourful, mid-tone
 * pixel average, then darkens it so white text always stays readable
 * (target lightness ~22%). Needs CORS on the image host; if the canvas is
 * tainted or the image fails we resolve to null and the UI keeps its
 * neutral fallback tint.
 */
const cache = new Map();
const FALLBACK = null;

export function coverTint(url) {
  if (!url) return Promise.resolve(FALLBACK);
  if (cache.has(url)) return cache.get(url);
  const p = new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    // A smaller rendition is plenty for colour and loads much faster.
    img.src = url.replace(/\/\d+x\d+bb\.jpg$/, '/60x60bb.jpg');
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 24, 24);
        const d = ctx.getImageData(0, 0, 24, 24).data;
        // Bucket pixels by hue and take the dominant bucket. Averaging all
        // pixels would turn e.g. a pink + green cover into grey mud.
        const buckets = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
        let grey = { w: 0, r: 0, g: 0, b: 0 };
        for (let i = 0; i < d.length; i += 4) {
          const pr = d[i], pg = d[i + 1], pb = d[i + 2];
          const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
          const sat = max ? (max - min) / max : 0;
          const lum = (max + min) / 510;
          if (lum < 0.08 || lum > 0.94 || sat < 0.18) {
            grey.w += 1; grey.r += pr; grey.g += pg; grey.b += pb;
            continue;
          }
          const hue = rgbHue(pr, pg, pb);
          const bk = buckets[Math.floor(hue / 30) % 12];
          const w = sat * (1 - Math.abs(lum - 0.5));
          bk.w += w; bk.r += pr * w; bk.g += pg * w; bk.b += pb * w;
        }
        const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
        // Mostly-monochrome cover → use its (dark) average, desaturated.
        const pick = best.w > 2 ? best : grey;
        if (!pick.w) return resolve(FALLBACK);
        resolve(toDarkTint(pick.r / pick.w, pick.g / pick.w, pick.b / pick.w));
      } catch {
        resolve(FALLBACK);   // tainted canvas (no CORS) or other failure
      }
    };
    img.onerror = () => resolve(FALLBACK);
  });
  cache.set(url, p);
  return p;
}

function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

function toDarkTint(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  const sat = Math.min(0.5, s * 0.85);
  return `hsl(${Math.round(h)} ${Math.round(sat * 100)}% 20%)`;
}
