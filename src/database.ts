/**
 * SQLite connection and schema migrations, using Node's built-in `node:sqlite`.
 *
 * Built-in rather than better-sqlite3 so the Docker image needs no native
 * compilation step and self-hosters have nothing extra to install.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { donorNameKey } from './donations/donor-name-key.ts';

export type Database = DatabaseSync;

type Migration = {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
  /** Data changes SQL cannot express, run after `sql` in the same transaction. */
  readonly backfill?: (database: Database) => void;
};

/**
 * Applied in order, each exactly once. The applied version is tracked in SQLite's
 * `user_version` pragma.
 *
 * Append only. Never edit or reorder an existing entry: deployed databases have
 * already run it, so a change would silently not apply to them.
 */
export const migrations: readonly Migration[] = [
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
  {
    version: 2,
    description: 'Record when a donation triggered its alert',
    sql: `
      -- Set exactly once, in the same transaction as the status update that
      -- crossed the alert threshold. NULL means no alert has been triggered, which
      -- is what makes duplicate and retried IPNs harmless.
      ALTER TABLE donations ADD COLUMN alert_triggered_at TEXT;
    `,
  },
  {
    version: 3,
    description: 'Record when an overlay finished showing an alert',
    sql: `
      -- Triggered but not yet shown means an overlay missed it (OBS closed, a
      -- reconnect), so it is replayed when an overlay next connects.
      ALTER TABLE donations ADD COLUMN alert_shown_at TEXT;
      CREATE INDEX donations_pending_alerts ON donations (alert_triggered_at)
        WHERE alert_triggered_at IS NOT NULL AND alert_shown_at IS NULL;
    `,
  },
  {
    version: 4,
    description: 'Public leaderboard: opt-out flag and grouping key',
    sql: `
      -- 1 unless the donor unticked "show me on the public leaderboard".
      -- Donations from before the leaderboard existed default to listed, as agreed.
      ALTER TABLE donations ADD COLUMN show_on_leaderboard INTEGER NOT NULL DEFAULT 1
        CHECK (show_on_leaderboard IN (0, 1));
      -- Case- and Unicode-insensitive name, filled in by the app (see donor-name-key.ts).
      ALTER TABLE donations ADD COLUMN donor_name_key TEXT NOT NULL DEFAULT '';
      CREATE INDEX donations_leaderboard ON donations (donor_name_key)
        WHERE show_on_leaderboard = 1 AND alert_triggered_at IS NOT NULL;
      -- "Recent" reads newest-first; without this it sorts every donation per view.
      CREATE INDEX donations_recent ON donations (alert_triggered_at)
        WHERE show_on_leaderboard = 1 AND alert_triggered_at IS NOT NULL;
    `,
    backfill: (database) => {
      const rows = database.prepare('SELECT id, donor_name FROM donations').all() as {
        id: number;
        donor_name: string;
      }[];
      const update = database.prepare('UPDATE donations SET donor_name_key = ? WHERE id = ?');
      for (const row of rows) update.run(donorNameKey(row.donor_name), row.id);
    },
  },
  {
    version: 5,
    description: 'Index the biggest single donations for the on-stream table',
    sql: `
      -- Matches the query's ORDER BY exactly, so the top 10 are read straight
      -- off the index instead of sorting every listed donation.
      CREATE INDEX donations_biggest ON donations (amount_minor DESC, alert_triggered_at)
        WHERE show_on_leaderboard = 1 AND alert_triggered_at IS NOT NULL;
    `,
  },
  {
    version: 6,
    description: 'Platform connections and Twitch message de-duplication',
    sql: `
      -- One row per connected platform account (the streamer's own channel).
      CREATE TABLE platform_connections (
        platform TEXT PRIMARY KEY CHECK (platform IN ('twitch', 'kick', 'youtube')),
        account_id TEXT NOT NULL,
        account_login TEXT NOT NULL,
        -- 'active', or 'revoked' when the platform withdrew access.
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        status_reason TEXT,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      -- Twitch delivers "at least once"; a message id seen before is ignored.
      -- Pruned after a day: Twitch retries within minutes, not days.
      CREATE TABLE twitch_messages (
        message_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX twitch_messages_received_at ON twitch_messages (received_at);
    `,
  },
];

/** The schema version a freshly opened database ends up at. */
export const latestSchemaVersion = Math.max(...migrations.map((migration) => migration.version));

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
      migration.backfill?.(database);
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
