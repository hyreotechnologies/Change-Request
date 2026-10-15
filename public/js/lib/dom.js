/**
 * Tiny DOM helper.
 *   h('div.card', { onClick }, h('h3', 'Title'), 'text')
 * Selector syntax: tag.class.class#id
 */
export function h(selector, props, ...children) {
  let tag = 'div';
  let classes = [];
  let id = null;

  const match = String(selector).match(/^([a-zA-Z0-9-]*)((?:[.#][^.#]+)*)$/);
  if (match) {
    tag = match[1] || 'div';
    for (const token of (match[2] || '').split(/(?=[.#])/).filter(Boolean)) {
      if (token.startsWith('.')) classes.push(token.slice(1));
      else if (token.startsWith('#')) id = token.slice(1);
    }
  } else {
    tag = selector;
  }

  const node = document.createElement(tag);
  if (classes.length) node.className = classes.join(' ');
  if (id) node.id = id;

  let rest = children;
  if (props !== null && props !== undefined) {
    if (typeof props === 'object' && !Array.isArray(props) && !(props instanceof Node)) {
      applyProps(node, props);
    } else {
      rest = [props, ...children];
    }
  }

  append(node, rest);
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.className = [node.className, value].filter(Boolean).join(' ');
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') {
      node.value = value;
    } else if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'readOnly') {
      node[key] = Boolean(value);
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function render(container, ...children) {
  clear(container);
  append(container, children);
  return container;
}

export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

export function frag(...children) {
  const fragment = document.createDocumentFragment();
  append(fragment, children);
  return fragment;
}

/** Delegate an event from a container to matching descendants. */
export function delegate(container, event, selector, listener) {
  container.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && container.contains(target)) listener(e, target);
  });
}

export function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Read every named control inside a container into a plain object. */
export function readForm(container) {
  const data = {};
  for (const field of qsa('[name]', container)) {
    const name = field.getAttribute('name');
    if (!name) continue;
    if (field.type === 'checkbox') data[name] = field.checked;
    else if (field.type === 'number') data[name] = field.value === '' ? null : Number(field.value);
    else data[name] = field.value === '' ? null : field.value;
  }
  return data;
}

export function setFieldErrors(container, details = []) {
  for (const node of qsa('.is-invalid', container)) node.classList.remove('is-invalid');
  for (const node of qsa('.field__error', container)) node.remove();
  for (const detail of details) {
    const field = qs(`[name="${detail.field}"]`, container);
    if (!field) continue;
    field.classList.add('is-invalid');
    field.parentElement.appendChild(h('span.field__error', detail.message));
  }
  const first = qs('.is-invalid', container);
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
