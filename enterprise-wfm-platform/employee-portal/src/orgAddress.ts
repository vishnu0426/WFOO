/**
 * Which organisation a person means, taken from where they came in so they never have to type a code: a link (?org=ACME), a path (/org/acme),
 * the first part of the host name (acme.example.com, only when switched on), or the organisation used last on this device. No imports, so it is
 * tested directly. The same file is kept in the admin app; a test checks they agree.
 */
export type OrgSource = 'link' | 'path' | 'subdomain' | 'remembered';
export interface Where { hostname: string; pathname: string; search: string }

/** A code is letters, digits, dash and underscore: nothing that could change the meaning of an address or a request. */
export const cleanCode = (v: unknown): string | null => { const s = typeof v === 'string' ? v.trim() : ''; return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s) ? s : null; };

/** First parts of a host name that name the product or a function, never an organisation. */
const GENERIC = new Set(['www', 'app', 'portal', 'my', 'login', 'wfm', 'mywfm', 'employee', 'employees', 'staff', 'api', 'm']);

export function orgFromAddress(w: Where, remembered?: string | null, opts: { subdomain?: boolean } = {}): { code: string; source: OrgSource } | null {
  const q = new URLSearchParams(w.search);
  const link = cleanCode(q.get('org') ?? q.get('o'));
  if (link) return { code: link, source: 'link' };
  const m = /^\/org\/([^/]+)/i.exec(w.pathname);
  if (m) { let seg = m[1]; try { seg = decodeURIComponent(seg); } catch { /* keep it as typed */ } const c = cleanCode(seg); if (c) return { code: c, source: 'path' }; }
  if (opts.subdomain) {
    const host = w.hostname.toLowerCase();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && !host.includes(':')) {
      const labels = host.split('.');
      const first = labels.length >= 3 || (labels.length === 2 && labels[1] === 'localhost') ? labels[0] : null;
      const c = first && !GENERIC.has(first) ? cleanCode(first) : null;
      if (c) return { code: c, source: 'subdomain' };
    }
  }
  const last = cleanCode(remembered);
  return last ? { code: last, source: 'remembered' } : null;
}
