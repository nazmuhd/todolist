import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration. Parsed once at start-up so a missing variable
 * fails loudly instead of surfacing as a confusing runtime error later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:8000'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  STORAGE_BUCKET: z.string().default('attachments'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
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
  /** True when the pieces needed to talk to Supabase are configured. */
  hasSupabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
  hasDatabase: Boolean(env.DATABASE_URL),
  hasPush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
};
