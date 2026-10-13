/**
 * The latest chat messages on disk, so a restart or deploy does not empty the
 * dashboard. Only the newest few hundred are kept: older rows are deleted as
 * new ones arrive, and a moderator's removal deletes rows too.
 *
 * Stored at the streamer's request (2026-10-14), reversing the earlier "never
 * stored" choice. Backups include it, like the rest of the database.
 */
import type { Database } from '../database.ts';
import { chatBufferSize, type ChatMessage, type ChatRemoval } from './chat.ts';

export type ChatStore = ReturnType<typeof createChatStore>;

export function createChatStore(database: Database, size = chatBufferSize) {
  const insertStatement = database.prepare(
    'INSERT OR IGNORE INTO chat_messages (id, platform, user_id, message) VALUES (?, ?, ?, ?)',
  );
  // Everything older than the newest `size` rows.
  const pruneStatement = database.prepare(`
    DELETE FROM chat_messages
    WHERE seq <= (SELECT seq FROM chat_messages ORDER BY seq DESC LIMIT 1 OFFSET ?)
  `);
  const removeMessageStatement = database.prepare('DELETE FROM chat_messages WHERE id = ?');
  const removeUserStatement = database.prepare('DELETE FROM chat_messages WHERE platform = ? AND user_id = ?');
  const removePlatformStatement = database.prepare('DELETE FROM chat_messages WHERE platform = ?');
  const recentStatement = database.prepare(
    'SELECT message FROM (SELECT seq, message FROM chat_messages ORDER BY seq DESC LIMIT ?) ORDER BY seq',
  );

  return {
    save(message: ChatMessage): void {
      insertStatement.run(message.id, message.platform, message.userId, JSON.stringify(message));
      pruneStatement.run(size);
    },

    remove(removal: ChatRemoval): void {
      if (removal.kind === 'message') removeMessageStatement.run(removal.id);
      else if (removal.kind === 'user') removeUserStatement.run(removal.platform, removal.userId);
      else removePlatformStatement.run(removal.platform);
    },

    /** Oldest first. */
    recent(): ChatMessage[] {
      return (recentStatement.all(size) as { message: string }[]).map((row) => JSON.parse(row.message) as ChatMessage);
    },
  };
}
