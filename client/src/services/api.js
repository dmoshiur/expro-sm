/**
 * Fetch wrapper: credentials (httpOnly cookie), JSON, structured errors and a
 * global 401 handler. No axios, no CORS - the SPA is served by the same
 * Express process in production and proxied in development.
 */
let onUnauthorized = null;

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function buildQuery(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.filter((v) => v !== undefined && v !== null && v !== '').forEach((v) => search.append(key, String(v)));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function request(method, path, { body, params, raw, headers } = {}) {
  const response = await fetch(`/api${path}${buildQuery(params)}`, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    payload = await response.json().catch(() => null);
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    if (response.status === 401 && onUnauthorized) onUnauthorized(error);
    throw new ApiError(
      response.status,
      error.code ?? 'ERROR',
      error.message ?? `Request failed (${response.status})`,
      error.details,
      error.requestId ?? response.headers.get('x-request-id'),
    );
  }
  return payload?.data ?? payload;
}

export const api = {
  get: (path, params) => request('GET', path, { params }),
  post: (path, body, params) => request('POST', path, { body, params }),
  patch: (path, body) => request('PATCH', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  del: (path, body) => request('DELETE', path, { body }),
  upload: (path, buffer, mime) =>
    request('POST', path, { raw: true, body: buffer, headers: { 'content-type': mime } }),
  /** Downloads a non-JSON endpoint (CSV) and triggers a browser save. */
  async download(path, params) {
    const response = await fetch(`/api${path}${buildQuery(params)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new ApiError(response.status, 'DOWNLOAD_FAILED', 'Could not download the report');
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const filename = match ? match[1] : 'report.csv';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return filename;
  },
  /** Opens an HTML endpoint (receipt / printable report) in a new tab. */
  openHtml(path, params) {
    window.open(`/api${path}${buildQuery(params)}`, '_blank', 'noopener');
  },
};

export const authApi = {
  login: (payload) => api.post('/auth/login', payload),
  logout: () => api.post('/auth/logout'),
  me: () => api.get('/auth/me'),
  refresh: () => api.post('/auth/refresh'),
  changePassword: (payload) => api.post('/auth/change-password', payload),
  totpStatus: () => api.get('/auth/totp'),
  totpSetup: () => api.post('/auth/totp/setup'),
  totpConfirm: (code) => api.post('/auth/totp/confirm', { code }),
  totpDisable: (payload) => api.post('/auth/totp/disable', payload),
  revokeOtherSessions: () => api.post('/auth/sessions/revoke-others'),
};
