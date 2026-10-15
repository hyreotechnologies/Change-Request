/**
 * Per-browser conveniences (theme, collapsed sidebar, list layout).
 * Storage can be unavailable (private windows, blocked site data), so every
 * read falls back to the default and every write is best-effort.
 */

const PREFIX = 'hcrms.';

export function readPref(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* not persisted; the setting still applies for this page view */
  }
}

/* ------------------------------------------------------------------ theme */

export const THEMES = ['system', 'light', 'dark'];

// Light is the house style. Dark (or following the OS) only applies once the
// user picks it from the user menu; the key is new so that an earlier build's
// automatically stored 'system' value is ignored.
const THEME_KEY = 'themeChoice';
const DEFAULT_THEME = 'light';

export function currentTheme() {
  const theme = readPref(THEME_KEY, DEFAULT_THEME);
  return THEMES.includes(theme) ? theme : DEFAULT_THEME;
}

const systemDark = () => window.matchMedia?.('(prefers-color-scheme: dark)');
let followingSystem = false;

/**
 * 'system' follows the operating system (and keeps following it while the
 * page is open); 'light' / 'dark' pin it. The resolved value always lands on
 * <html data-theme>, so the stylesheet has a single dark-mode block.
 */
export function applyTheme(theme = currentTheme(), { remember = false } = {}) {
  const resolved = theme === 'system' ? (systemDark()?.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
  if (remember) writePref(THEME_KEY, theme);

  if (!followingSystem && systemDark()?.addEventListener) {
    followingSystem = true;
    systemDark().addEventListener('change', () => {
      if (currentTheme() === 'system') applyTheme('system');
    });
  }
}
