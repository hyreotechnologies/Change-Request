import api from './api.js';

/** Application-wide state: the signed-in user, configuration and enumerations. */
const state = {
  user: null,
  settings: null,
  enums: null,
  unread: 0,
  listeners: new Set()
};

export const store = {
  get user() {
    return state.user;
  },
  get settings() {
    return state.settings;
  },
  get enums() {
    return state.enums;
  },
  get unread() {
    return state.unread;
  },
  get currency() {
    return state.settings?.defaults?.currency || 'INR';
  },

  can(permission) {
    if (!state.user) return false;
    if (state.user.role_code === 'ADMIN') return true;
    return (state.user.permissions || []).includes(permission);
  },

  canAny(...permissions) {
    return permissions.some((permission) => this.can(permission));
  },

  async loadSession() {
    try {
      const data = await api.get('/api/auth/me', { allowUnauthorised: true });
      state.user = data.user;
      state.settings = data.settings;
      if (!state.enums) state.enums = await api.get('/api/enums');
      await this.refreshUnread();
      return state.user;
    } catch {
      state.user = null;
      return null;
    }
  },

  setSession(user, settings) {
    state.user = user;
    state.settings = settings;
    this.emit();
  },

  clearSession() {
    state.user = null;
    state.unread = 0;
    this.emit();
  },

  async refreshSettings() {
    state.settings = await api.get('/api/settings/public');
    this.emit();
    return state.settings;
  },

  async refreshUnread() {
    if (!state.user) return 0;
    try {
      const data = await api.get('/api/notifications?limit=1');
      state.unread = data.unread || 0;
      this.emit();
    } catch {
      /* non-fatal */
    }
    return state.unread;
  },

  statusMeta(code) {
    const found = (state.enums?.statuses || []).find((s) => s.code === code);
    return found || { code, label: code, color: 'slate' };
  },

  enumLabel(group, code) {
    const list = state.enums?.[group] || [];
    const found = list.find((item) => item.code === code);
    return found?.label || code || '—';
  },

  subscribe(listener) {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },

  emit() {
    for (const listener of state.listeners) listener(state);
  }
};

export default store;
