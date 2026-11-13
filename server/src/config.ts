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
  QUIET_HOURS_START: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()),
  QUIET_HOURS_END: z.preprocess(v => v === '' ? undefined : v, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional()),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  RESEND_API_KEY: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  EMAIL_FROM: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  BASE_URL: z.preprocess(v => v === '' ? undefined : v, z.string().optional()),
  // Automatic backups: how often to take one, and how many to keep.
  BACKUP_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
  BACKUP_KEEP: z.coerce.number().int().positive().default(24),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['RESEND_API_KEY'], message: 'RESEND_API_KEY is required in production' });
  }
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
  backupIntervalMinutes: env.BACKUP_INTERVAL_MINUTES,
  backupKeep: env.BACKUP_KEEP,
};
