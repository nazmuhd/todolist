import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration. Parsed once at start-up so a missing variable
 * fails loudly instead of surfacing as a confusing runtime error later.
 *
 * There is no auth yet, so the server is a single-user store. The database
 * is a local SQLite file; use `:memory:` for tests.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:8000'),
  DATABASE_PATH: z.string().default('./data/todoist.db'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  // Local quiet-hours window (HH:MM). Reminders due inside it wait until it
  // ends. Set both to the same value (or leave blank) to disable.
  QUIET_HOURS_START: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  QUIET_HOURS_END: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid environment:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isProduction: env.NODE_ENV === 'production',
  corsOrigins: env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean),
  hasPush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
  quietHours: {
    start: env.QUIET_HOURS_START || null,
    end: env.QUIET_HOURS_END || null,
  },
};
