/** History-API router with :param patterns. */

const routes = [];
let notFoundHandler = null;
let beforeEach = null;
let current = null;

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export const router = {
  add(pattern, handler, options = {}) {
    const { regex, keys } = compile(pattern);
    routes.push({ pattern, regex, keys, handler, ...options });
    return this;
  },

  setNotFound(handler) {
    notFoundHandler = handler;
    return this;
  },

  setGuard(guard) {
    beforeEach = guard;
    return this;
  },

  navigate(path, { replace = false, silent = false } = {}) {
    if (path === location.pathname + location.search) {
      if (!silent) this.resolve();
      return;
    }
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    if (!silent) this.resolve();
  },

  get current() {
    return current;
  },

  async resolve() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(new URLSearchParams(location.search));

    for (const route of routes) {
      const match = path.match(route.regex);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      current = { route, params, query, path };
      if (beforeEach) {
        const allowed = await beforeEach(route, { params, query, path });
        if (allowed === false) return;
      }
      await route.handler({ params, query, path });
      return;
    }

    if (notFoundHandler) await notFoundHandler({ path });
  },

  start() {
    window.addEventListener('popstate', () => this.resolve());
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="/"]');
      if (!link || link.target === '_blank' || link.hasAttribute('download') || event.metaKey || event.ctrlKey) return;
      // server-rendered endpoints (downloads, secure links) must reach the network
      const href = link.getAttribute('href');
      if (href.startsWith('/api/') || href.startsWith('/s/')) return;
      event.preventDefault();
      this.navigate(href);
    });
    this.resolve();
  }
};

export function link(href, ...children) {
  const a = document.createElement('a');
  a.href = href;
  for (const child of children.flat()) {
    a.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return a;
}

export default router;
