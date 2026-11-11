import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../../supabase/migrations');

/**
 * Applies every migration in supabase/migrations in filename order, skipping
 * the ones already applied. The client has the same idea in its MIGRATIONS
 * object: each step upgrades from the previous version.
 */
async function main() {
  const files = (await readdir(migrationsDir))
    .filter(name => name.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No migrations found.');
    return;
  }

  const pool = getPool();
  await pool.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows } = await pool.query<{ name: string }>('select name from schema_migrations');
  const applied = new Set(rows.map(r => r.name));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (name) values ($1)', [file]);
      console.log(`ok    ${file}`);
    } catch (err) {
      console.error(`fail  ${file}`);
      throw err;
    }
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await closePool().catch(() => {});
    process.exit(1);
  });
