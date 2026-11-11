import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, closeDb } from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '../../database/sqlite/migrations');

/**
 * Applies every migration in database/sqlite/migrations in filename order,
 * skipping the ones already applied. Each file runs in its own transaction.
 */
export async function migrate(): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter(name => name.endsWith('.sql'))
    .sort();

  if (!files.length) {
    console.log('No migrations found.');
    return;
  }

  const db = getDb();
  db.exec(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const applied = new Set(
    (db.prepare('select name from schema_migrations').all() as { name: string }[]).map(r => r.name),
  );

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file}`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('insert into schema_migrations (name) values (?)').run(file);
      db.exec('COMMIT');
      console.log(`ok    ${file}`);
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`fail  ${file}`);
      throw err;
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(err);
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
