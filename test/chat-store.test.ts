import { describe, expect, it } from 'vitest';
import { createChatBuffer, type ChatMessage } from '../src/dashboard/chat.ts';
import { createChatStore } from '../src/dashboard/chat-store.ts';
import { createDashboardHub } from '../src/dashboard/dashboard-hub.ts';
import { openDatabase } from '../src/database.ts';

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  platform: 'twitch',
  at: '2026-10-14T10:00:00.000Z',
  userId: 'u1',
  user: 'NeonRider',
  color: '#1E90FF',
  badges: ['subscriber'],
  text: `text ${id}`,
  ...overrides,
});

describe('chat store', () => {
  it('keeps only the newest messages, oldest first', () => {
    const store = createChatStore(openDatabase(':memory:'), 3);
    for (const id of ['a', 'b', 'c', 'd', 'e']) store.save(message(id));
    expect(store.recent().map((entry) => entry.id)).toEqual(['c', 'd', 'e']);
    expect(store.recent()[2]).toEqual(message('e'));
  });

  it('deletes what moderators remove', () => {
    const store = createChatStore(openDatabase(':memory:'));
    store.save(message('t1'));
    store.save(message('t2', { userId: 'troll' }));
    store.save(message('t3', { userId: 'troll' }));
    store.save(message('k1', { platform: 'kick', userId: 'troll' }));
    store.remove({ kind: 'message', id: 't1' });
    store.remove({ kind: 'user', platform: 'twitch', userId: 'troll' });
    expect(store.recent().map((entry) => entry.id)).toEqual(['k1']);
    store.remove({ kind: 'all', platform: 'kick' });
    expect(store.recent()).toEqual([]);
  });

  it('gives a restarted buffer the chat it had before', () => {
    const database = openDatabase(':memory:');
    const before = createChatBuffer(createDashboardHub(), { store: createChatStore(database) });
    before.add(message('a'));
    before.add(message('b'));
    before.remove({ kind: 'message', id: 'a' });
    const afterRestart = createChatBuffer(createDashboardHub(), { store: createChatStore(database) });
    expect(afterRestart.recent().map((entry) => entry.id)).toEqual(['b']);
  });

  it('clears everything, in the database and for open pages, for every platform', () => {
    const database = openDatabase(':memory:');
    const hub = createDashboardHub();
    const received: unknown[] = [];
    hub.subscribe((event) => received.push(event));
    const buffer = createChatBuffer(hub, { store: createChatStore(database) });
    buffer.add(message('t1'));
    buffer.add(message('k1', { platform: 'kick' }));
    received.length = 0;
    buffer.clear();
    expect(buffer.recent()).toEqual([]);
    expect(createChatStore(database).recent()).toEqual([]);
    expect(received).toEqual([
      { type: 'chat-remove', removal: { kind: 'all', platform: 'twitch' }, ids: ['t1'] },
      { type: 'chat-remove', removal: { kind: 'all', platform: 'kick' }, ids: ['k1'] },
    ]);
  });

  it('ignores a message delivered twice', () => {
    const store = createChatStore(openDatabase(':memory:'));
    store.save(message('a'));
    store.save(message('a'));
    expect(store.recent()).toHaveLength(1);
  });
});
