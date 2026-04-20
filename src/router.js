/**
 * Hash-based SPA router with top-bar visibility + nav highlight.
 */

const routes = {};
let currentPage = null;

export function route(path, handler) { routes[path] = handler; }
export function navigate(path)       { window.location.hash = path; }
export function getCurrentRoute()    { return currentPage; }

export function initRouter() {
  const container = document.getElementById('app');

  async function handleRoute() {
    const hash = window.location.hash.replace('#', '') || '/feed';
    const handler = routes[hash];
    if (handler) {
      currentPage = hash;
      updateNav(hash);
      await handler(container);
    } else {
      navigate('/feed');
    }
  }

  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function updateNav(hash) {
  const page = hash.replace('/', '');

  // Nav highlight
  document.querySelectorAll('.bottom-nav__item').forEach(item => {
    item.classList.toggle('bottom-nav__item--active', item.dataset.page === page);
  });

  // The feed is dark + full-bleed; everything else shows the paper top-bar.
  const topBar = document.getElementById('top-bar');
  const app = document.getElementById('app');
  if (!topBar || !app) return;

  if (page === 'feed') {
    topBar.style.display = 'none';
    app.style.paddingTop = '0';
  } else {
    topBar.style.display = '';
    app.style.paddingTop = '';
  }
}
