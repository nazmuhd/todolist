import type { NextFunction, Request, Response } from 'express';

/** Turns thrown errors into a consistent JSON shape without leaking internals. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  const status = typeof (err as { status?: number })?.status === 'number'
    ? (err as { status: number }).status
    : 500;

  if (status >= 500) {
    console.error(err);
    res.status(status).json({ error: 'Internal server error' });
    return;
  }

  const message = err instanceof Error ? err.message : 'Request failed';
  res.status(status).json({ error: message || 'Request failed' });
}
