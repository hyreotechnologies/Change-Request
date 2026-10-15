/** Thin fetch wrapper: unwraps { data } / { error } and raises typed errors. */

export class ApiError extends Error {
  constructor(payload, status) {
    super(payload?.message || 'Request failed');
    this.name = 'ApiError';
    this.code = payload?.code || 'INTERNAL';
    this.details = payload?.details || null;
    this.status = status;
  }
}

async function request(method, url, body, options = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  });

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      // the API always answers in JSON, so this is the server itself refusing —
      // most often an old process still running without the newer routes
      const message =
        response.status === 404
          ? `The server did not recognise ${method} ${url}. If the application was updated, restart it and try again.`
          : `The server returned ${response.status} for ${method} ${url}.`;
      throw new ApiError({ code: 'UNEXPECTED_RESPONSE', message }, response.status);
    }
    return response;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(payload.error, response.status);
    if (error.status === 401 && !options.allowUnauthorised) {
      document.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw error;
  }
  return payload.data;
}

export const api = {
  get: (url, options) => request('GET', url, undefined, options),
  post: (url, body, options) => request('POST', url, body ?? {}, options),
  put: (url, body, options) => request('PUT', url, body ?? {}, options),
  patch: (url, body, options) => request('PATCH', url, body ?? {}, options),
  del: (url, options) => request('DELETE', url, undefined, options),

  /**
   * Trigger a browser download for an authenticated endpoint.
   * The `download` attribute both forces a save and keeps the SPA router from
   * treating the click as in-app navigation (the file name still comes from the
   * server's Content-Disposition header).
   */
  download(url) {
    const link = document.createElement('a');
    link.href = url;
    link.rel = 'noopener';
    link.setAttribute('download', '');
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
};

export function qs(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export default api;
