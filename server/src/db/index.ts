import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.ts';

let db: DatabaseSync | null = null;

function open(file: string): DatabaseSync {
  const path = file === ':memory:' ? file : resolve(file);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

/** Shared database handle. Created on first use so imports stay side-effect free. */
export function getDb(): DatabaseSync {
  if (!db) {
    db = open(config.DATABASE_PATH);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    db.close();
    db = null;
  }
}
