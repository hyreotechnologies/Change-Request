import { h, render, clear, debounce } from '../lib/dom.js';
import { HYREO_LOGO_URL } from '../lib/brand.js';
import { icon, avatar, notify, modal } from '../lib/ui.js';
import { readPref, writePref, applyTheme, currentTheme } from '../lib/prefs.js';
import api from '../lib/api.js';
import store from '../lib/store.js';
import router from '../lib/router.js';
import { statusBadge } from './table.js';
import { money } from '../lib/format.js';

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: 'dashboard', permission: 'dashboard.view' },
  { path: '/accounts', label: 'Accounts', icon: 'accounts', permission: 'account.view' },
  { path: '/change-requests', label: 'Change Requests', icon: 'change', permission: 'cr.view' },
  { path: '/approvals', label: 'Approvals', icon: 'approvals', permission: 'cr.view' },
  { path: '/documents', label: 'Documents', icon: 'documents', permission: 'document.view' },
  { path: '/reports', label: 'Reports', icon: 'reports', permission: 'report.view' },
  { path: '/notifications', label: 'Notifications', icon: 'bell', permission: 'notification.view' },
  { path: '/outbox', label: 'Email Outbox', icon: 'mail', permission: 'email.view' },
  { path: '/integrations', label: 'Integrations', icon: 'plug', permission: 'integration.manage' },
  { path: '/settings', label: 'Settings', icon: 'settings', permission: 'settings.manage' }
];

let shellRoot = null;
let pageHost = null;
let sidebarNode = null;
let savedViewsHost = null;
let searchInputNode = null;

const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;

export function mountShell(root) {
  if (shellRoot && root.contains(shellRoot)) {
    highlightNav();
    return pageHost;
  }

  pageHost = h('div.page');
  sidebarNode = buildSidebar();
  shellRoot = h(
    `div.app-shell${readPref('sidebarCollapsed', false) ? '.is-collapsed' : ''}`,
    sidebarNode,
    h('div.sidebar-backdrop', { onClick: closeMobileSidebar }),
    h('div.main', buildTopbar(), pageHost)
  );
  render(root, shellRoot);
  highlightNav();
  registerShortcuts();
  refreshSavedViews();
  return pageHost;
}

export function pageContainer() {
  return pageHost;
}

export function setPage(...children) {
  render(pageHost, ...children);
  window.scrollTo({ top: 0 });
  highlightNav();
  closeMobileSidebar();
}

function buildSidebar() {
  const items = NAV.filter((item) => store.can(item.permission));

  return h(
    'aside.sidebar',
    h(
      'div.sidebar__brand',
      h('div.brand', h('img.brand__logo', { src: HYREO_LOGO_URL, alt: 'Hyreo' }), h('div.sidebar__subtitle', 'Account Management'))
    ),
    h(
      'nav.sidebar__nav',
      h('div.sidebar__section', 'Workspace'),
      ...items.slice(0, 6).map(navItem),
      (savedViewsHost = h('div')),
      h('div.sidebar__section', 'Communication & admin'),
      ...items.slice(6).map(navItem)
    )
  );
}

/** Re-read the signed-in user's saved views into the sidebar. */
export async function refreshSavedViews() {
  if (!savedViewsHost || !store.can('cr.view')) return;
  const host = savedViewsHost;
  let views = [];
  try {
    views = await api.get('/api/saved-views');
  } catch {
    return;
  }
  render(
    host,
    views.length ? h('div.sidebar__section', 'Saved views') : null,
    ...views.map((view) =>
      h(
        'a.nav-item.nav-item--view',
        { href: `/change-requests?${view.query}`, dataset: { view: view.query }, title: view.name },
        h('span.nav-item__icon', icon('bookmark', 15)),
        h('span.truncate', view.name)
      )
    )
  );
  highlightNav();
}

function navItem(item) {
  return h(
    'a.nav-item',
    { href: item.path, dataset: { path: item.path } },
    h('span.nav-item__icon', icon(item.icon, 17)),
    item.label,
    item.path === '/notifications' && store.unread > 0 ? h('span.nav-item__badge', String(store.unread)) : null
  );
}

/**
 * Narrow screens slide the sidebar over the page; wide screens collapse it and
 * let the page fill the space. The wide-screen choice is remembered.
 */
function toggleSidebar() {
  if (!shellRoot) return;
  if (isNarrow()) {
    shellRoot.classList.toggle('is-nav-open');
  } else {
    const collapsed = shellRoot.classList.toggle('is-collapsed');
    writePref('sidebarCollapsed', collapsed);
  }
}

function closeMobileSidebar() {
  shellRoot?.classList.remove('is-nav-open');
}

function highlightNav() {
  if (!sidebarNode) return;
  const path = location.pathname;
  const search = location.search.replace(/^\?/, '');
  const views = [...sidebarNode.querySelectorAll('.nav-item--view')];
  const onView = path === '/change-requests' && views.some((node) => node.dataset.view === search);
  for (const node of sidebarNode.querySelectorAll('.nav-item')) {
    if (node.classList.contains('nav-item--view')) {
      node.classList.toggle('is-active', path === '/change-requests' && node.dataset.view === search);
      continue;
    }
    const target = node.dataset.path;
    const active = !(onView && target === '/change-requests') && (path === target || (target !== '/dashboard' && path.startsWith(target)));
    node.classList.toggle('is-active', active);
  }
}

/* ---------------------------------------------------- keyboard shortcuts -- */

const SHORTCUTS = [
  ['/', 'Search'],
  ['N', 'New change request'],
  ['B', 'Show or hide the sidebar'],
  ['G then D', 'Go to the dashboard'],
  ['G then C', 'Go to change requests'],
  ['G then A', 'Go to approvals'],
  ['G then R', 'Go to reports'],
  ['?', 'Show these shortcuts']
];

let shortcutsRegistered = false;
let pendingG = 0;

function typingInto(target) {
  return target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

function registerShortcuts() {
  if (shortcutsRegistered) return;
  shortcutsRegistered = true;

  document.addEventListener('keydown', (event) => {
    if (!shellRoot || !document.body.contains(shellRoot)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (typingInto(event.target) || document.querySelector('.overlay')) return;

    const key = event.key.toLowerCase();
    if (pendingG && Date.now() - pendingG < 1200) {
      pendingG = 0;
      const target = { d: '/dashboard', c: '/change-requests', a: '/approvals', r: '/reports' }[key];
      if (target) {
        event.preventDefault();
        router.navigate(target);
      }
      return;
    }

    if (event.key === '/') {
      event.preventDefault();
      searchInputNode?.focus();
    } else if (key === 'n' && store.can('cr.create')) {
      event.preventDefault();
      router.navigate('/change-requests/new');
    } else if (key === 'b') {
      event.preventDefault();
      toggleSidebar();
    } else if (key === 'g') {
      pendingG = Date.now();
    } else if (event.key === '?') {
      event.preventDefault();
      showShortcuts();
    }
  });
}

function showShortcuts() {
  modal({
    title: 'Keyboard shortcuts',
    subtitle: 'Available anywhere outside a text field.',
    body: h(
      'div.shortcuts',
      ...SHORTCUTS.map(([keys, label]) =>
        h(
          'div.shortcuts__row',
          h('span', label),
          h('span.shortcuts__keys', ...keys.split(' then ').flatMap((k, i) => [i ? h('span.muted', ' then ') : null, h('kbd', k)]))
        )
      )
    )
  });
}

function buildTopbar() {
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search accounts, MSA numbers, CR numbers, titles…  ( / )',
    'aria-label': 'Global search',
    autocomplete: 'off'
  });
  searchInputNode = searchInput;
  const results = h('div.search-results.hidden');

  const runSearch = debounce(async (term) => {
    if (!term || term.length < 2) {
      results.classList.add('hidden');
      return;
    }
    try {
      const data = await api.get(`/api/search?q=${encodeURIComponent(term)}`);
      renderSearchResults(results, data);
      results.classList.remove('hidden');
    } catch {
      results.classList.add('hidden');
    }
  }, 220);

  searchInput.addEventListener('input', (event) => runSearch(event.target.value.trim()));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      searchInput.value = '';
      results.classList.add('hidden');
      searchInput.blur();
    }
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.search-box')) results.classList.add('hidden');
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
      event.preventDefault();
      searchInput.focus();
    }
  });

  const bell = h(
    'button.icon-btn',
    { onClick: () => router.navigate('/notifications'), 'aria-label': 'Notifications', title: 'Notifications' },
    icon('bell', 18),
    store.unread > 0 ? h('span.icon-btn__dot', String(Math.min(store.unread, 99))) : null
  );

  store.subscribe(() => {
    const existing = bell.querySelector('.icon-btn__dot');
    if (existing) existing.remove();
    if (store.unread > 0) bell.appendChild(h('span.icon-btn__dot', String(Math.min(store.unread, 99))));
    if (sidebarNode) {
      const notifNav = sidebarNode.querySelector('[data-path="/notifications"]');
      if (notifNav) {
        const badgeNode = notifNav.querySelector('.nav-item__badge');
        if (badgeNode) badgeNode.remove();
        if (store.unread > 0) notifNav.appendChild(h('span.nav-item__badge', String(store.unread)));
      }
    }
  });

  return h(
    'header.topbar',
    h(
      'button.icon-btn.topbar__menu',
      { onClick: toggleSidebar, 'aria-label': 'Toggle navigation' },
      icon('menu', 20)
    ),
    h('div.search-box', h('span.search-box__icon', icon('search', 16)), searchInput, results),
    h(
      'div.topbar__actions',
      store.can('cr.create')
        ? h(
            'button.btn.btn--primary.btn--sm',
            { onClick: () => router.navigate('/change-requests/new') },
            icon('plus', 15),
            'New CR'
          )
        : null,
      bell,
      userMenu()
    )
  );
}

function renderSearchResults(container, data) {
  clear(container);
  const groups = [
    {
      label: 'Accounts',
      items: data.accounts,
      render: (row) => ({
        primary: row.account_name,
        secondary: `${row.account_code} · ${row.legal_entity_name || ''}`,
        href: `/accounts/${row.id}`
      })
    },
    {
      label: 'MSA contracts',
      items: data.msas,
      render: (row) => ({
        primary: row.msa_reference_number,
        secondary: `${row.account_name} · ${row.cr_count} change request(s)`,
        href: `/accounts/${row.account_id}`
      })
    },
    {
      label: 'Change requests',
      items: data.change_requests,
      render: (row) => ({
        primary: row.cr_number,
        secondary: `${row.account_name} · ${row.title}`,
        href: `/change-requests/${row.id}`,
        badge: row.status,
        amount: money(row.total_cost, row.currency)
      })
    },
    {
      label: 'Contacts',
      items: data.contacts,
      render: (row) => ({
        primary: row.name,
        secondary: `${row.email || ''} · ${row.account_name}`,
        href: `/accounts/${row.account_id}`
      })
    }
  ].filter((group) => group.items?.length);

  if (!groups.length) {
    container.appendChild(h('div.search-results__empty', 'No matches found'));
    return;
  }

  for (const group of groups) {
    container.appendChild(
      h(
        'div.search-results__group',
        h('div.search-results__label', group.label),
        ...group.items.map((row) => {
          const view = group.render(row);
          return h(
            'div.search-results__item',
            {
              onClick: () => {
                container.classList.add('hidden');
                router.navigate(view.href);
              }
            },
            h(
              'div',
              { style: { minWidth: '0', flex: '1' } },
              h('div.cell-strong', view.primary),
              h('div.cell-sub.truncate', view.secondary)
            ),
            view.amount ? h('span.cell-sub.nowrap', view.amount) : null,
            view.badge ? statusBadge(view.badge) : null
          );
        })
      )
    );
  }
}

function userMenu() {
  const user = store.user;
  let dropdown = null;

  const chip = h(
    'button.user-chip',
    {
      onClick: (event) => {
        event.stopPropagation();
        if (dropdown) {
          dropdown.remove();
          dropdown = null;
          return;
        }
        dropdown = h(
          'div.dropdown',
          h(
            'div.dropdown__header',
            h('div.row', avatar(user.name, { large: true }), h('div', h('div.cell-strong', user.name), h('div.cell-sub', user.email))),
            h('div.mt-1', h('span.badge.badge--navy.badge--plain', user.role_code.replace('_', ' ')))
          ),
          store.can('user.manage')
            ? h('div.dropdown__item', { onClick: () => router.navigate('/settings/users') }, icon('users', 16), 'User management')
            : null,
          h('div.dropdown__item', { onClick: () => router.navigate('/notifications') }, icon('bell', 16), 'Notifications'),
          themePicker(),
          h('div.dropdown__item', { onClick: showShortcuts }, icon('keyboard', 16), 'Keyboard shortcuts', h('kbd', { style: { marginLeft: 'auto' } }, '?')),
          h(
            'div.dropdown__item',
            {
              onClick: async () => {
                await api.post('/api/auth/logout');
                store.clearSession();
                notify.info('You have been signed out.');
                router.navigate('/login');
              }
            },
            icon('logout', 16),
            'Sign out'
          )
        );
        document.body.appendChild(dropdown);
        setTimeout(() => {
          document.addEventListener(
            'click',
            () => {
              dropdown?.remove();
              dropdown = null;
            },
            { once: true }
          );
        }, 0);
      }
    },
    avatar(user?.name),
    h('div', h('div.user-chip__name', user?.name || ''), h('div.user-chip__role', (user?.role_code || '').replace('_', ' ')))
  );

  return chip;
}

/** Light / dark / follow the system, as a segmented control inside the user menu. */
function themePicker() {
  const options = [
    { value: 'light', label: 'Light', icon: 'sun' },
    { value: 'dark', label: 'Dark', icon: 'moon' },
    { value: 'system', label: 'System', icon: 'settings' }
  ];
  const host = h('div.theme-picker', { onClick: (event) => event.stopPropagation() });
  const draw = () =>
    render(
      host,
      h('span.theme-picker__label', 'Theme'),
      h(
        'div.segmented',
        ...options.map((option) =>
          h(
            `button.segmented__item${currentTheme() === option.value ? '.is-active' : ''}`,
            {
              type: 'button',
              title: option.label,
              'aria-pressed': String(currentTheme() === option.value),
              onClick: () => {
                applyTheme(option.value, { remember: true });
                draw();
              }
            },
            icon(option.icon, 14),
            option.label
          )
        )
      )
    );
  draw();
  return host;
}

export function resetShell() {
  shellRoot = null;
  pageHost = null;
  sidebarNode = null;
  savedViewsHost = null;
  searchInputNode = null;
}
