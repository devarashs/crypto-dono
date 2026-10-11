/**
 * Persistence for platform connections (which Twitch or Kick channel is linked)
 * and for the message ids used to ignore duplicate webhook deliveries.
 */
import type { Database } from '../database.ts';

export const connectablePlatforms = ['twitch', 'kick', 'youtube'] as const;
export type ConnectablePlatform = (typeof connectablePlatforms)[number];

export type PlatformConnection = {
  readonly platform: ConnectablePlatform;
  /** The platform's id for the streamer's channel, e.g. a Twitch user id. */
  readonly accountId: string;
  readonly accountLogin: string;
  readonly status: 'active' | 'revoked';
  /** Why the platform revoked access, e.g. "authorization_revoked". */
  readonly statusReason: string | null;
  readonly connectedAt: string;
};

type ConnectionRow = {
  platform: ConnectablePlatform;
  account_id: string;
  account_login: string;
  status: 'active' | 'revoked';
  status_reason: string | null;
  connected_at: string;
};

export type ConnectionStore = ReturnType<typeof createConnectionStore>;

export function createConnectionStore(database: Database, now: () => Date = () => new Date()) {
  const findStatement = database.prepare('SELECT * FROM platform_connections WHERE platform = ?');
  const upsertStatement = database.prepare(`
    INSERT INTO platform_connections (platform, account_id, account_login, status, status_reason, connected_at, updated_at)
    VALUES (?, ?, ?, 'active', NULL, ?, ?)
    ON CONFLICT (platform) DO UPDATE SET
      account_id = excluded.account_id, account_login = excluded.account_login,
      status = 'active', status_reason = NULL,
      connected_at = excluded.connected_at, updated_at = excluded.updated_at
  `);
  const revokeStatement = database.prepare(`
    UPDATE platform_connections SET status = 'revoked', status_reason = ?, updated_at = ? WHERE platform = ?
  `);
  const deleteStatement = database.prepare('DELETE FROM platform_connections WHERE platform = ?');
  const rememberMessageStatement = database.prepare(
    'INSERT OR IGNORE INTO twitch_messages (message_id, received_at) VALUES (?, ?)',
  );
  const pruneMessagesStatement = database.prepare('DELETE FROM twitch_messages WHERE received_at < ?');

  return {
    find(platform: ConnectablePlatform): PlatformConnection | undefined {
      const row = findStatement.get(platform) as ConnectionRow | undefined;
      return row === undefined
        ? undefined
        : {
            platform: row.platform,
            accountId: row.account_id,
            accountLogin: row.account_login,
            status: row.status,
            statusReason: row.status_reason,
            connectedAt: row.connected_at,
          };
    },

    /** Records a fresh connection, replacing any earlier one for the platform. */
    connect(platform: ConnectablePlatform, accountId: string, accountLogin: string): void {
      const timestamp = now().toISOString();
      upsertStatement.run(platform, accountId, accountLogin, timestamp, timestamp);
    },

    /** Marks the connection revoked, keeping who it was so the admin page can say so. */
    markRevoked(platform: ConnectablePlatform, reason: string): void {
      revokeStatement.run(reason, now().toISOString(), platform);
    },

    disconnect(platform: ConnectablePlatform): void {
      deleteStatement.run(platform);
    },

    /**
     * Records a Twitch message id.
     * @returns true the first time this id is seen, false for a duplicate delivery.
     */
    rememberTwitchMessage(messageId: string): boolean {
      const timestamp = now();
      // Cheap enough to do on every message; keeps the table to about a day.
      pruneMessagesStatement.run(new Date(timestamp.getTime() - 24 * 60 * 60 * 1000).toISOString());
      return rememberMessageStatement.run(messageId, timestamp.toISOString()).changes === 1;
    },
  };
}
