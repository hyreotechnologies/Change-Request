import { h, render, qs, readForm, setFieldErrors } from './dom.js';
import { initials } from './format.js';

/* ------------------------------------------------------------------ icons */

const PATHS = {
  dashboard: 'M3 3h7v7H3zM14 3h7v5h-7zM14 11h7v10h-7zM3 13h7v8H3z',
  accounts: 'M3 21V7l6-4 6 4v14M9 21v-5h4v5M15 21h6V11l-3-2',
  change: 'M14 3v4a1 1 0 001 1h4M5 21h14a1 1 0 001-1V8l-5-5H6a1 1 0 00-1 1v16a1 1 0 001 1zM9 13h6M9 17h4',
  approvals: 'M9 11l3 3 7-7M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h10',
  documents: 'M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9zM13 2v7h7M9 13h6M9 17h6',
  reports: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  bell: 'M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-2.7-1.1l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00-1.1-2.7H3a2 2 0 110-4h.1a1.6 1.6 0 001.1-2.7l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 002.7-1.1V3a2 2 0 114 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1.3z',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronDown: 'M6 9l6 6 6-6',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  mail: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zM22 6l-10 7L2 6',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  user: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  menu: 'M3 12h18M3 6h18M3 18h18',
  file: 'M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9zM13 2v7h7',
  copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  building: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1',
  signature: 'M3 17s3-9 6-9 2 6 4.5 6S17 7 21 7M3 21h18',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
  lock: 'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4',
  history: 'M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8M12 7v5l4 2',
  board: 'M4 3h4a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zM10 3h4a1 1 0 011 1v10a1 1 0 01-1 1h-4a1 1 0 01-1-1V4a1 1 0 011-1zM16 3h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1V4a1 1 0 011-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  bookmark: 'M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z',
  moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  keyboard: 'M20 5H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 16h8M10 13h4',
  diff: 'M12 3v14M5 10h14M5 21h14'
};

export function icon(name, size = 16, extraClass = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('width', size);
  node.setAttribute('height', size);
  node.setAttribute('fill', 'none');
  node.setAttribute('stroke', 'currentColor');
  node.setAttribute('stroke-width', '1.8');
  node.setAttribute('stroke-linecap', 'round');
  node.setAttribute('stroke-linejoin', 'round');
  if (extraClass) node.setAttribute('class', extraClass);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] || PATHS.info);
  node.appendChild(path);
  return node;
}

/* ----------------------------------------------------------------- badges */

export function badge(text, color = 'slate', { plain = false } = {}) {
  return h(`span.badge.badge--${color}${plain ? '.badge--plain' : ''}`, text);
}

export function avatar(name, { large = false } = {}) {
  return h(`span.avatar${large ? '.avatar--lg' : ''}`, initials(name));
}

/* ----------------------------------------------------------------- toasts */

let toastHost = null;

export function toast(message, type = 'info', timeout = 4200) {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const node = h(
    `div.toast.toast--${type}`,
    h('span', { style: { flex: '1' } }, message),
    h('button.toast__close', { onClick: () => node.remove(), 'aria-label': 'Dismiss' }, '×')
  );
  toastHost.appendChild(node);
  if (timeout) setTimeout(() => node.remove(), timeout);
  return node;
}

export const notify = {
  success: (m) => toast(m, 'success'),
  error: (m) => toast(m, 'error', 6500),
  warning: (m) => toast(m, 'warning', 5200),
  info: (m) => toast(m, 'info')
};

export function apiError(error) {
  const message = error?.message || 'Something went wrong';
  if (error?.details?.length) {
    notify.error(`${message}: ${error.details.map((d) => d.message).join('; ')}`);
  } else {
    notify.error(message);
  }
}

/* ----------------------------------------------------------------- modals */

export function modal({ title, subtitle = null, body, actions = [], size = '', onClose = null, closeOnBackdrop = true }) {
  const overlay = h('div.overlay');
  const close = (result) => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose(result);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close(null);
  };
  document.addEventListener('keydown', onKey);

  const box = h(
    `div.modal${size ? `.modal--${size}` : ''}`,
    h(
      'div.modal__head',
      h('div', h('h3', title), subtitle ? h('div.card__subtitle', subtitle) : null),
      h('button.icon-btn', { style: { marginLeft: 'auto' }, onClick: () => close(null), 'aria-label': 'Close' }, icon('x', 18))
    ),
    h('div.modal__body', body),
    actions.length
      ? h(
          'div.modal__foot',
          ...actions.map((action) =>
            h(
              `button.btn.btn--${action.variant || 'secondary'}`,
              {
                onClick: async (event) => {
                  if (!action.onClick) return close(action.value ?? null);
                  const button = event.currentTarget;
                  button.disabled = true;
                  try {
                    const result = await action.onClick({ close, modal: box });
                    if (result !== false && action.closeOnSuccess !== false) close(result);
                  } finally {
                    button.disabled = false;
                  }
                  return undefined;
                }
              },
              action.label
            )
          )
        )
      : null
  );

  overlay.appendChild(box);
  if (closeOnBackdrop) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
  }
  document.body.appendChild(overlay);
  const firstInput = qs('input, textarea, select', box);
  if (firstInput) setTimeout(() => firstInput.focus(), 40);
  return { element: box, close };
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  requireComment = false,
  commentLabel = 'Comments',
  commentPlaceholder = ''
}) {
  return new Promise((resolve) => {
    let textarea = null;
    const body = h(
      'div',
      h('p', { style: { color: 'var(--ink-600)' } }, message),
      requireComment
        ? h(
            'div.field',
            h('label.field__label', commentLabel, h('span.req', '*')),
            (textarea = h('textarea.textarea', { placeholder: commentPlaceholder, rows: 4 }))
          )
        : null
    );

    const { close } = modal({
      title,
      body,
      onClose: (result) => resolve(result ?? false),
      actions: [
        { label: cancelLabel, variant: 'secondary', value: false },
        {
          label: confirmLabel,
          variant,
          onClick: () => {
            if (requireComment) {
              const value = textarea.value.trim();
              if (value.length < 5) {
                textarea.classList.add('is-invalid');
                notify.warning('Please provide at least 5 characters.');
                return false;
              }
              close({ confirmed: true, comments: value });
              return false;
            }
            close({ confirmed: true });
            return false;
          }
        }
      ]
    });
  });
}

/* ------------------------------------------------------------ form modals */

export function formModal({ title, subtitle, fields, submitLabel = 'Save', size = '', onSubmit }) {
  return new Promise((resolve) => {
    const form = h('form', { onSubmit: (e) => e.preventDefault() }, fields);
    const { close } = modal({
      title,
      subtitle,
      size,
      body: form,
      onClose: (result) => resolve(result ?? null),
      actions: [
        { label: 'Cancel', variant: 'secondary', value: null },
        {
          label: submitLabel,
          variant: 'primary',
          onClick: async () => {
            try {
              const result = await onSubmit(readForm(form), form);
              close(result ?? true);
            } catch (error) {
              if (error?.details) setFieldErrors(form, error.details);
              apiError(error);
            }
            return false;
          }
        }
      ]
    });
  });
}

/* -------------------------------------------------------- building blocks */

export function card({ title, subtitle, actions, body, flush = false, footer = null }) {
  return h(
    'div.card',
    title || actions
      ? h(
          'div.card__head',
          h('div', title ? h('div.card__title', title) : null, subtitle ? h('div.card__subtitle', subtitle) : null),
          actions ? h('div.card__actions', actions) : null
        )
      : null,
    h(`div.card__body${flush ? '.card__body--flush' : ''}`, body),
    footer ? h('div.card__footer', footer) : null
  );
}

export function emptyState(title, message, action = null) {
  return h(
    'div.empty',
    h('div.empty__icon', icon('file', 30)),
    h('div.empty__title', title),
    message ? h('div', message) : null,
    action ? h('div.mt-2', action) : null
  );
}

export function loading(label = 'Loading') {
  return h(
    'div.empty',
    h('div', { style: { display: 'flex', justifyContent: 'center', marginBottom: '10px' } }, h('div.spinner.spinner--dark')),
    h('div', label)
  );
}

export function skeletonTable(rows = 5) {
  return h(
    'div',
    { style: { padding: '16px' } },
    ...Array.from({ length: rows }, () =>
      h('div.skeleton', { style: { height: '38px', marginBottom: '8px' } })
    )
  );
}

export function definitionList(entries) {
  return h(
    'div.def-grid',
    ...entries
      .filter(Boolean)
      .map(([label, value]) =>
        h(
          'div.def',
          h('div.def__label', label),
          value === null || value === undefined || value === '' || value === '—'
            ? h('div.def__value.def__value--muted', 'Not provided')
            : value instanceof Node
              ? h('div.def__value', value)
              : h('div.def__value', String(value))
        )
      )
  );
}

export function field(label, control, { hint = null, required = false } = {}) {
  return h(
    'div.field',
    h('label.field__label', label, required ? h('span.req', '*') : null),
    control,
    hint ? h('span.field__hint', hint) : null
  );
}

export function input(name, props = {}) {
  return h('input.input', { name, ...props });
}

export function textarea(name, props = {}) {
  return h('textarea.textarea', { name, ...props });
}

export function select(name, options, value = null, props = {}) {
  const node = h('select.select', { name, ...props });
  for (const option of options) {
    const opt = typeof option === 'string' ? { value: option, label: option } : option;
    node.appendChild(
      h('option', { value: opt.value, selected: String(opt.value) === String(value ?? '') }, opt.label)
    );
  }
  return node;
}

export function switchControl(name, checked, label) {
  return h(
    'label.switch',
    h('input', { type: 'checkbox', name, checked: Boolean(checked) }),
    h('span.switch__track'),
    label ? h('span', label) : null
  );
}

export function tabs(items, activeKey, onChange) {
  return h(
    'div.tabs',
    ...items.map((item) =>
      h(
        `button.tab${item.key === activeKey ? '.is-active' : ''}`,
        { onClick: () => onChange(item.key) },
        item.label,
        item.count !== undefined && item.count !== null ? h('span.tab__count', String(item.count)) : null
      )
    )
  );
}

export function pageHeader({ breadcrumb = null, title, subtitle = null, actions = null }) {
  return h(
    'div.page__head',
    h(
      'div.page__title',
      breadcrumb ? h('div.breadcrumb', breadcrumb) : null,
      h('h1', title),
      subtitle ? h('div.page__subtitle', subtitle) : null
    ),
    actions ? h('div.page__actions', actions) : null
  );
}

export function alert(type, title, message = null) {
  return h(
    `div.alert.alert--${type}`,
    icon(type === 'danger' ? 'alert' : type === 'success' ? 'check' : 'info', 17),
    h('div', h('div.alert__title', title), message ? h('div', message) : null)
  );
}

export { render, readForm, setFieldErrors };
