let timer = null;
export function toast(text, ms = 2200) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('toast--show');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('toast--show'), ms);
}
