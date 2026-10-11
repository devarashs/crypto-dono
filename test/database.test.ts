import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  latestSchemaVersion,
  migrations,
  openDatabase,
  readSchemaVersion,
  runInTransaction,
} from '../src/database.ts';

describe('openDatabase', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'crypto-dono-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates missing parent directories and migrates to the latest version', () => {
    const database = openDatabase(join(directory, 'nested', 'deeper', 'db.sqlite'));
    expect(readSchemaVersion(database)).toBe(latestSchemaVersion);
    database.close();
  });

  it('keeps data across reopen and does not re-run migrations', () => {
    const path = join(directory, 'db.sqlite');
    const first = openDatabase(path);
    first
      .prepare(
        `INSERT INTO donations (public_id, donor_name, amount_minor, currency, created_at, updated_at)
         VALUES ('p1', 'Ann', 500, 'usd', 't', 't')`,
      )
      .run();
    first.close();

    const second = openDatabase(path);
    expect(readSchemaVersion(second)).toBe(latestSchemaVersion);
    expect(second.prepare('SELECT donor_name FROM donations').all()).toEqual([
      { donor_name: 'Ann' },
    ]);
    second.close();
  });

  it('uses WAL journaling so reads do not block on writes', () => {
    const database = openDatabase(join(directory, 'db.sqlite'));
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    database.close();
  });
});

describe('applyMigrations', () => {
  it('rolls back a failing migration and keeps the previous version', () => {
    const database = openDatabase(':memory:');
    expect(() =>
      applyMigrations(database, [
        { version: latestSchemaVersion + 1, description: 'half applied', sql: 'CREATE TABLE t (x); SELECT nonsense FROM nowhere;' },
      ]),
    ).toThrow();
    expect(readSchemaVersion(database)).toBe(latestSchemaVersion);
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeUndefined();
  });

  it('skips migrations at or below the current version', () => {
    const database = openDatabase(':memory:');
    applyMigrations(database, [{ version: 1, description: 'already applied', sql: 'NOT VALID SQL' }]);
    expect(readSchemaVersion(database)).toBe(latestSchemaVersion);
  });
});

describe('upgrading an existing database', () => {
  it('adds alert_triggered_at to a version 1 database without touching its rows', () => {
    const database = new DatabaseSync(':memory:');
    applyMigrations(database, migrations.filter((migration) => migration.version === 1));
    database
      .prepare(
        `INSERT INTO donations (public_id, donor_name, amount_minor, currency, status, created_at, updated_at)
         VALUES ('p1', 'Ann', 500, 'usd', 'finished', 't', 't')`,
      )
      .run();

    applyMigrations(database, migrations);

    expect(readSchemaVersion(database)).toBe(latestSchemaVersion);
    expect(database.prepare('SELECT donor_name, status, alert_triggered_at FROM donations').all()).toEqual([
      { donor_name: 'Ann', status: 'finished', alert_triggered_at: null },
    ]);
  });
});

describe('runInTransaction', () => {
  it('commits when the work returns', () => {
    const database = openDatabase(':memory:');
    database.exec('CREATE TABLE t (x INTEGER)');
    const value = runInTransaction(database, () => {
      database.exec('INSERT INTO t VALUES (1)');
      return 'done';
    });
    expect(value).toBe('done');
    expect(database.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  it('rolls back and rethrows when the work throws', () => {
    const database = openDatabase(':memory:');
    database.exec('CREATE TABLE t (x INTEGER)');
    expect(() =>
      runInTransaction(database, () => {
        database.exec('INSERT INTO t VALUES (1)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(database.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });
});
