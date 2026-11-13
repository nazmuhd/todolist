import { getDb } from '../db/index.ts';

type OptionsLike = { windowMs: number };

type IncrementResponse = { totalHits: number; resetTime: Date };

/**
 * SQLite-backed store for express-rate-limit.
 * Useful for single-database deployments and persistence across restarts.
 * For multi-process deployments, all instances must share the same SQLite DB.
 */
export class SqliteRateLimitStore {
  windowMs = 0;
  prefix: string;
  private ready = false;

  constructor(options: { prefix?: string } = {}) {
    this.prefix = options.prefix ?? 'rl:';
  }

  private ensureTable(): void {
    if (this.ready) return;
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_hits (
        key TEXT PRIMARY KEY,
        total_hits INTEGER NOT NULL,
        reset_time INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_reset_time ON rate_limit_hits(reset_time);
    `);
    this.ready = true;
  }

  init(options: OptionsLike): void {
    this.windowMs = options.windowMs;
    this.ensureTable();
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async increment(key: string): Promise<IncrementResponse> {
    this.ensureTable();
    const db = getDb();
    const now = Date.now();
    const nextReset = now + this.windowMs;
    const storageKey = this.k(key);

    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT total_hits, reset_time FROM rate_limit_hits WHERE key = ?').get(storageKey) as
        | { total_hits: number; reset_time: number }
        | undefined;

      let totalHits: number;
      let resetTimeMs: number;
      if (row && row.reset_time > now) {
        totalHits = Number(row.total_hits) + 1;
        resetTimeMs = Number(row.reset_time);
        db.prepare('UPDATE rate_limit_hits SET total_hits = ? WHERE key = ?').run(totalHits, storageKey);
      } else {
        totalHits = 1;
        resetTimeMs = nextReset;
        db.prepare(
          'INSERT INTO rate_limit_hits (key, total_hits, reset_time) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET total_hits = excluded.total_hits, reset_time = excluded.reset_time'
        ).run(storageKey, totalHits, resetTimeMs);
      }

      // Opportunistic cleanup of expired rows (cheap, bounded impact)
      db.prepare('DELETE FROM rate_limit_hits WHERE reset_time <= ?').run(now - this.windowMs);
      db.exec('COMMIT');
      return { totalHits, resetTime: new Date(resetTimeMs) };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  async decrement(key: string): Promise<void> {
    this.ensureTable();
    const db = getDb();
    const storageKey = this.k(key);
    db.prepare(
      'UPDATE rate_limit_hits SET total_hits = CASE WHEN total_hits > 0 THEN total_hits - 1 ELSE 0 END WHERE key = ?'
    ).run(storageKey);
  }

  async resetKey(key: string): Promise<void> {
    this.ensureTable();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_hits WHERE key = ?').run(this.k(key));
  }

  async resetAll(): Promise<void> {
    this.ensureTable();
    const db = getDb();
    const like = `${this.prefix}%`;
    db.prepare('DELETE FROM rate_limit_hits WHERE key LIKE ?').run(like);
  }
}
