import type { NextFunction, Request, Response } from 'express';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { config } from '../config.ts';

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/**
 * Verifies the Supabase access token and attaches `req.user`.
 * The token is signed by Supabase's Auth service, so the JWKS is fetched
 * from `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` and cached.
 */
export async function verifyToken(token: string) {
  if (!config.SUPABASE_URL) throw new Error('SUPABASE_URL is not configured');
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${config.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks, { audience: 'authenticated' });
  return payload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    res.status(401).json({ error: 'missing_token' });
    return;
  }

  verifyToken(token)
    .then((payload) => {
      (req as Request & { user?: { id: string; email?: string } }).user = {
        id: String(payload.sub),
        email: typeof payload.email === 'string' ? payload.email : undefined,
      };
      next();
    })
    .catch((err) => {
      res.status(401).json({ error: 'invalid_token', detail: err.message });
    });
}
