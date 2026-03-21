/**
 * Simple hash-based SPA router
 */

const routes = {};
let currentPage = null;

/**
 * Register a route.
 * @param {string} path - hash path (e.g., '/stations')
 * @param {Function} handler - async function(container) to render the page
 */
export function route(path, handler) {
  routes[path] = handler;
}

/**
 * Navigate to a route.
 */
export function navigate(path) {
  window.location.hash = path;
}

/**
 * Get the current route path.
 */
export function getCurrentRoute() {
  return currentPage;
}

/**
 * Initialize the router.
 */
export function initRouter() {
  const container = document.getElementById('app');

  async function handleRoute() {
    const hash = window.location.hash.replace('#', '') || '/stations';
    const handler = routes[hash];

    if (handler) {
      currentPage = hash;
      updateNav(hash);
      await handler(container);
    } else {
      // Default to stations
      navigate('/stations');
    }
  }

  window.addEventListener('hashchange', handleRoute);
  handleRoute(); // Initial route
}

function updateNav(hash) {
  const pageName = hash.replace('/', '');

  document.querySelectorAll('.bottom-nav__item').forEach(item => {
    const itemPage = item.dataset.page;
    if (itemPage === pageName) {
      item.classList.add('bottom-nav__item--active');
    } else {
      item.classList.remove('bottom-nav__item--active');
    }
  });

  const topBar = document.getElementById('top-bar');
  const appContainer = document.getElementById('app');
  if (topBar) {
    if (pageName === 'stations') {
      topBar.style.display = '';
      if (appContainer) appContainer.style.paddingTop = ''; // Keep CSS default (64px)
    } else {
      topBar.style.display = 'none';
      if (appContainer) appContainer.style.paddingTop = '0px';
    }
  }
}
