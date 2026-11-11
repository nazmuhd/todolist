import { Pool } from 'pg';
import { config } from '../config.ts';

let pool: Pool | null = null;

/** Shared connection pool. Created on first use so imports stay side-effect free. */
export function getPool(): Pool {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured — copy server/.env.example to server/.env');
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      ssl: config.isProduction ? { rejectUnauthorized: false } : undefined,
    });
    pool.on('error', (err) => console.error('Unexpected pg error:', err));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
