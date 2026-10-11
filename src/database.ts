/**
 * SQLite connection and schema migrations, using Node's built-in `node:sqlite`.
 *
 * Built-in rather than better-sqlite3 so the Docker image needs no native
 * compilation step and self-hosters have nothing extra to install.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

type Migration = { readonly version: number; readonly description: string; readonly sql: string };

/**
 * Applied in order, each exactly once. The applied version is tracked in SQLite's
 * `user_version` pragma.
 *
 * Append only. Never edit or reorder an existing entry: deployed databases have
 * already run it, so a change would silently not apply to them.
 */
const migrations: readonly Migration[] = [
  {
    version: 1,
    description: 'Create donations table',
    sql: `
      CREATE TABLE donations (
        id INTEGER PRIMARY KEY,
        -- Random identifier sent to NOWPayments as order_id and shown in URLs, so
        -- the sequential primary key never leaks donation volume.
        public_id TEXT NOT NULL UNIQUE,
        donor_name TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        -- Integer minor units (cents for USD) so no amount ever passes through a
        -- binary float.
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        -- Lower-case ISO 4217 code, as NOWPayments expects it.
        currency TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
          'created', 'waiting', 'confirming', 'confirmed', 'sending',
          'partially_paid', 'finished', 'failed', 'refunded', 'expired'
        )),
        nowpayments_invoice_id TEXT,
        nowpayments_payment_id TEXT,
        pay_currency TEXT,
        -- Crypto amounts kept as the decimal strings NOWPayments sends; they exceed
        -- float precision and are displayed, never computed with.
        actually_paid TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX donations_created_at ON donations (created_at);
    `,
  },
];

/**
 * Opens (creating if needed) the database file and brings its schema up to date.
 *
 * @param path File path, or `:memory:` for tests. Parent directories are created.
 * @returns An open connection; the caller owns closing it.
 * @throws If the file cannot be opened or a migration fails. A failed migration is
 *   rolled back, leaving the database at the last good version.
 */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  // WAL lets the overlay's reads proceed while a webhook writes. busy_timeout
  // waits out a briefly held lock instead of failing the request immediately.
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database, migrations);
  return database;
}

/** Exposed for tests; production code calls `openDatabase`. */
export function applyMigrations(database: Database, pending: readonly Migration[]): void {
  const currentVersion = readSchemaVersion(database);
  for (const migration of pending) {
    if (migration.version <= currentVersion) continue;
    runInTransaction(database, () => {
      database.exec(migration.sql);
      // PRAGMA cannot take a bound parameter; the version is an integer literal
      // from the list above, never input.
      database.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
    });
  }
}

export function readSchemaVersion(database: Database): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * Runs `work` inside a transaction, committing on return and rolling back on throw.
 * node:sqlite has no transaction helper of its own.
 */
export function runInTransaction<T>(database: Database, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
