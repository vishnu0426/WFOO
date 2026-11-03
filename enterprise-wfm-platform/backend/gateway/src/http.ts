import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}
export const bad = (message: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', message, details);
export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string) => new HttpError(409, 'CONFLICT', message);

/** Validate a request part with zod; on failure a 400 that names every offending field. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'VALIDATION', `Invalid input: ${issues.map((i) => `${i.field || 'body'} ${i.message}`).join('; ')}`, issues);
  }
  return r.data;
}

export const isoDay = /^\d{4}-\d{2}-\d{2}$/;

/** One CSV cell for a file people open in a spreadsheet: quoted when needed, and a text that starts with = + - @ is defused so it is not run as a formula. */
export function safeCsvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // a date or number the database cannot hold (2026-02-30, a huge value) is the caller's mistake, not a server fault, and its raw message is not for them
  const badValue = !(err instanceof HttpError) && ['22007', '22008', '22003', '22P02'].includes(err?.code);
  const syntax = !(err instanceof HttpError) && err?.type === 'entity.parse.failed';
  const status = badValue || syntax ? 400 : err instanceof HttpError ? err.status : Number(err?.status) || (err?.code === '23505' ? 409 : err?.code === '23503' ? 409 : 500);
  const code = badValue ? 'VALIDATION' : syntax ? 'BAD_JSON' : err instanceof HttpError ? err.code : err?.code === '23505' ? 'DUPLICATE' : err?.code === '23503' ? 'IN_USE' : err?.code || 'INTERNAL';
  let message = badValue ? 'One of the values is not valid (check dates and numbers).' : syntax ? 'The request body is not valid JSON.' : err?.message || 'Unexpected error';
  if (err?.code === '23505') message = 'That already exists (a unique value is duplicated).';
  if (err?.code === '23503') message = 'That is referenced by other records and cannot be changed this way.';
  if (status >= 500) console.error(`[http] ${req.method} ${req.path} ${req.requestId ?? ''}`, err);
  res.status(status).json({ error: { code, message: status >= 500 && !(err instanceof HttpError) ? 'Internal error' : message, details: err?.details, requestId: req.requestId } });
}
