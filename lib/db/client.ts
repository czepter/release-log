// Opening the database applies any pending migrations, so a fresh file and
// an existing one reach the same schema by the same path.

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function openDb(path: string): Db {
  const sqlite = new Database(path);
  // Foreign keys are off by default in SQLite and the index relies on
  // explicit deletes rather than cascades, but WAL is worth having: a
  // reader is never blocked by the sync writing.
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
