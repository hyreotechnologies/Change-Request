import { h, render } from './lib/dom.js';
import { notify } from './lib/ui.js';
import store from './lib/store.js';
import router from './lib/router.js';
import { mountShell, setPage, resetShell } from './components/shell.js';
import { applyTheme } from './lib/prefs.js';

import loginPage from './pages/login.js';
import dashboardPage from './pages/dashboard.js';
import accountsPage from './pages/accounts.js';
import accountFormPage from './pages/accountForm.js';
import accountDetailPage from './pages/accountDetail.js';
import changeRequestsPage from './pages/changeRequests.js';
import crWizardPage from './pages/crWizard.js';
import crDetailPage from './pages/crDetail.js';
import approvalsPage from './pages/approvals.js';
import documentsPage from './pages/documents.js';
import reportsPage from './pages/reports.js';
import notificationsPage, { outboxPage } from './pages/notifications.js';
import settingsPage from './pages/settings.js';
import portalPage from './pages/portal.js';

const root = document.getElementById('app');

// before the first paint, so a dark-mode user never sees a white flash
applyTheme();

/** Routes that render outside the authenticated shell. */
const PUBLIC_ROUTES = new Set(['/login', '/portal/:token']);

function authenticated(handler) {
  return async (context) => {
    mountShell(root);
    await handler(context);
  };
}

router
  .add('/', async () => router.navigate(store.user ? '/dashboard' : '/login', { replace: true }))
  .add('/login', async () => {
    resetShell();
    loginPage(root);
  })
  .add('/portal/:token', async (context) => {
    resetShell();
    await portalPage(root, context);
  })
  .add('/dashboard', authenticated(dashboardPage))
  .add('/accounts', authenticated(accountsPage))
  .add('/accounts/new', authenticated(accountFormPage))
  .add('/accounts/:id', authenticated(accountDetailPage))
  .add('/accounts/:id/edit', authenticated(accountFormPage))
  .add('/change-requests', authenticated(changeRequestsPage))
  .add('/change-requests/new', authenticated(crWizardPage))
  .add('/change-requests/:id', authenticated(crDetailPage))
  .add('/change-requests/:id/edit', authenticated(crWizardPage))
  .add('/approvals', authenticated(approvalsPage))
  .add('/documents', authenticated(documentsPage))
  .add('/reports', authenticated(reportsPage))
  .add('/notifications', authenticated(notificationsPage))
  .add('/outbox', authenticated(outboxPage))
  .add('/settings', authenticated(settingsPage))
  .add('/settings/:tab', authenticated(settingsPage))
  .setNotFound(async ({ path }) => {
    if (!store.user) {
      router.navigate('/login', { replace: true });
      return;
    }
    mountShell(root);
    setPage(
      h(
        'div.empty',
        { style: { padding: '80px 20px' } },
        h('div.empty__title', 'Page not found'),
        h('div', `Nothing matches ${path}.`),
        h('div.mt-2', h('a.btn.btn--primary', { href: '/dashboard' }, 'Back to dashboard'))
      )
    );
  })
  .setGuard(async (route) => {
    if (PUBLIC_ROUTES.has(route.pattern)) return true;
    if (store.user) return true;
    const user = await store.loadSession();
    if (user) return true;
    router.navigate('/login', { replace: true });
    return false;
  });

document.addEventListener('auth:expired', () => {
  if (location.pathname.startsWith('/portal/')) return;
  store.clearSession();
  resetShell();
  notify.warning('Your session has expired. Please sign in again.');
  router.navigate('/login');
});

// keep the unread badge fresh while the tab is open
setInterval(() => {
  if (store.user && document.visibilityState === 'visible') store.refreshUnread();
}, 60_000);

(async function bootstrap() {
  render(root, h('div.empty', { style: { padding: '120px 20px' } }, h('div.spinner.spinner--dark', { style: { margin: '0 auto' } })));
  if (!location.pathname.startsWith('/portal/')) await store.loadSession();
  router.start();
})();
