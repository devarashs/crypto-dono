/**
 * Admin sign-ins kept in the database, so a restart or deploy does not sign
 * the streamer out. A session store for @fastify/session.
 *
 * Only a SHA-256 of each session id is stored: the id itself lives in the
 * signed cookie alone, so a copy of the database (a backup, say) cannot be used
 * to sign in. The plugin saves the session on every admin request with a fresh
 * expiry (rolling), which makes the expiry slide: it ends after a stretch
 * without visits, not a fixed time after signing in.
 */
import { createHash } from 'node:crypto';
import type { Session } from 'fastify';
import type { Database } from '../database.ts';

type Callback = (error?: unknown) => void;

const hashId = (sessionId: string) => createHash('sha256').update(sessionId).digest('hex');

export function createSqliteSessionStore(database: Database, now: () => Date = () => new Date()) {
  const upsertStatement = database.prepare(`
    INSERT INTO admin_sessions (id_hash, data, expires_at) VALUES (?, ?, ?)
    ON CONFLICT (id_hash) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at
  `);
  const getStatement = database.prepare('SELECT data, expires_at FROM admin_sessions WHERE id_hash = ?');
  const deleteStatement = database.prepare('DELETE FROM admin_sessions WHERE id_hash = ?');
  const pruneStatement = database.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?');

  return {
    set(sessionId: string, session: Session, callback: Callback): void {
      try {
        const expires = session.cookie.expires;
        if (!(expires instanceof Date) && expires == null) throw new Error('admin sessions must have an expiry');
        pruneStatement.run(now().toISOString());
        upsertStatement.run(hashId(sessionId), JSON.stringify(session), new Date(expires).toISOString());
        callback();
      } catch (error) {
        callback(error);
      }
    },

    get(sessionId: string, callback: (error: unknown, session?: Session | null) => void): void {
      try {
        const row = getStatement.get(hashId(sessionId)) as { data: string; expires_at: string } | undefined;
        if (row === undefined || row.expires_at <= now().toISOString()) {
          callback(null, null);
          return;
        }
        callback(null, JSON.parse(row.data) as Session);
      } catch (error) {
        callback(error);
      }
    },

    destroy(sessionId: string, callback: Callback): void {
      try {
        deleteStatement.run(hashId(sessionId));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  };
}
