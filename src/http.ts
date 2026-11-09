/**
 * Response helpers for the passkey API.
 *
 * Success bodies carry the payload BOTH at the top level (the §2f shape,
 * e.g. `{ address }`) and under `data` (this service's existing envelope),
 * so callers written either way work. Errors: `{ success: false, error:
 * CODE, message, details? }` with the PasskeyError's HTTP status.
 */

import type { Response } from 'express';
import { PasskeyError } from './passkey/errors';

export function ok(res: Response, payload: Record<string, unknown>, message?: string, status = 200): void {
  res.status(status).json({
    success: true,
    ...payload,
    data: payload,
    ...(message ? { message } : {}),
    timestamp: new Date().toISOString(),
  });
}

export function fail(res: Response, err: unknown, context: string): void {
  if (err instanceof PasskeyError) {
    res.status(err.status).json({
      success: false,
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      timestamp: new Date().toISOString(),
    });
    return;
  }
  const e = err as { message?: string; shortMessage?: string };
  console.error(`[${context}] error:`, e?.shortMessage ?? e?.message ?? err);
  res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: e?.shortMessage ?? e?.message ?? 'internal error',
    timestamp: new Date().toISOString(),
  });
}

/** 410 for routes that used to sign with a server-held key. */
export function gone(res: Response, error: string, see: string): void {
  res.status(410).json({
    success: false,
    error,
    see,
    message: `This route signed with a server-held key and was removed. Use ${see} (two-phase, passkey-signed).`,
    timestamp: new Date().toISOString(),
  });
}
