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

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const status = err instanceof HttpError ? err.status : Number(err?.status) || (err?.code === '23505' ? 409 : err?.code === '23503' ? 409 : 500);
  const code = err instanceof HttpError ? err.code : err?.code === '23505' ? 'DUPLICATE' : err?.code === '23503' ? 'IN_USE' : err?.code || 'INTERNAL';
  let message = err?.message || 'Unexpected error';
  if (err?.code === '23505') message = 'That already exists (a unique value is duplicated).';
  if (err?.code === '23503') message = 'That is referenced by other records and cannot be changed this way.';
  if (status >= 500) console.error(`[http] ${req.method} ${req.path} ${req.requestId ?? ''}`, err);
  res.status(status).json({ error: { code, message: status >= 500 && code === 'INTERNAL' ? 'Internal error' : message, details: err?.details, requestId: req.requestId } });
}
