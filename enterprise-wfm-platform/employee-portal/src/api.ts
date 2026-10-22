/**
 * Gateway client for the employee portal. Same bearer-token auth as the admin web app and the mobile app, against
 * the same /api/v1 self-service endpoints (/me/*). No refresh tokens: a 401 clears the session and reloads to login.
 */

const TOKEN_KEY = 'wfm_employee_token';
const SESSION_KEY = 'wfm_employee_session';
const BASE = '/api/v1';

export type SessionUser = { id: string; userName: string; username: string; email: string | null; role: string; tenantId: string; tenantName: string; employeeId: string | null };
export type Tenant = { id: string; name: string; code: string; timezone: string; currency: string };
export type Session = { user: SessionUser; tenant: Tenant; permissions: string[] };

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const getStoredSession = (): Session | null => {
  try { return getToken() ? JSON.parse(localStorage.getItem(SESSION_KEY) || 'null') : null; } catch { return null; }
};
export const storeSession = (token: string | null, session: Session | null) => {
  if (token && session) { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  else { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(SESSION_KEY); }
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function fail(res: Response): Promise<never> {
  const data: any = await res.json().catch(() => ({}));
  const e = data?.error;
  const message = typeof e === 'string' ? e : e?.message || data?.message || res.statusText || 'Request failed';
  throw new ApiError(message, res.status, e?.code);
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }).catch(() => { throw new ApiError('Cannot reach the server. Check your connection and try again.', 0); });
  if (res.status === 401 && path !== '/auth/login' && token) { storeSession(null, null); location.reload(); }
  if (!res.ok) return fail(res);
  return res.json().catch(() => ({}));
}
