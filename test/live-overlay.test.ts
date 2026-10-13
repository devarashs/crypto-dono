import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createChatBuffer, type ChatBuffer, type ChatMessage } from '../src/dashboard/chat.ts';
import { createDashboardHub, type DashboardHub } from '../src/dashboard/dashboard-hub.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

const token = 'overlay-token-for-tests-0123456789';

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  platform: 'twitch',
  at: new Date().toISOString(),
  userId: '9',
  user: 'NeonRider',
  badges: [],
  text: `message ${id}`,
  ...overrides,
});

describe('chat and viewers on stream', () => {
  let app: FastifyInstance;
  let hub: DashboardHub;
  let chat: ChatBuffer;
  const openStreams: IncomingMessage[] = [];

  function build() {
    const store = createInMemoryStore();
    hub = createDashboardHub();
    chat = createChatBuffer(hub);
    app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: token,
        LOG_LEVEL: 'fatal',
        BANNED_WORDS: 'badword',
      }),
      {
        donations: store.donations,
        leaderboard: store.leaderboard,
        connections: store.connections,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        dashboardHub: hub,
        chat,
        streamStatus: {
          current: () => [
            { platform: 'twitch', state: 'live', login: 'machinearash', viewers: 90, startedAt: 't0', title: 'x' },
            { platform: 'kick', state: 'live', login: 'machinearash', viewers: 38, startedAt: 't0', title: 'y' },
          ],
          refresh: async () => {},
        },
      },
    );
  }

  afterEach(async () => {
    for (const stream of openStreams.splice(0)) stream.destroy();
    await app.close();
  });

  async function openStream(path = `/overlay/${token}/live`) {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path }, resolve).on('error', reject).end();
    });
    openStreams.push(response);
    let received = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      received += chunk;
    });
    const blocks = (type: string) =>
      received
        .split('\n\n')
        .filter((block) => block.includes(`event: ${type}\n`))
        .map((block) => JSON.parse(block.split('\n').find((line) => line.startsWith('data: '))!.slice(6)));
    return {
      response,
      blocks,
      text: () => received,
      async waitFor(type: string, count = 1) {
        const deadline = Date.now() + 2000;
        while (blocks(type).length < count) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got:\n${received}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      },
    };
  }

  it('serves both pages with their own script and no token written into them', async () => {
    build();
    for (const [page, script] of [
      ['chat', '/static/chat-overlay.js'],
      ['viewers', '/static/viewers-overlay.js'],
    ] as const) {
      const response = await app.inject({ method: 'GET', url: `/overlay/${token}/${page}` });
      expect(response.statusCode, page).toBe(200);
      expect(response.body).toContain(`src="${script}"`);
      expect(response.body).toContain('data-stream-url="live"');
      expect(response.body).not.toContain(token);
      expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    }
    for (const file of ['chat-overlay.js', 'viewers-overlay.js', 'live-stream.js', 'stream-widgets.js', 'stream-widgets.css', 'live-overlay.css']) {
      expect((await app.inject({ method: 'GET', url: `/static/${file}` })).statusCode, file).toBe(200);
    }
  });

  it('takes the fade and size from the URL, within limits', async () => {
    build();
    const custom = await app.inject({ method: 'GET', url: `/overlay/${token}/chat?fade=0&max=500` });
    expect(custom.body).toContain('data-fade-seconds="0"');
    expect(custom.body).toContain('data-max-messages="50"');
    const defaults = await app.inject({ method: 'GET', url: `/overlay/${token}/chat?fade=soon` });
    expect(defaults.body).toContain('data-fade-seconds="30"');
    expect(defaults.body).toContain('data-max-messages="12"');
  });

  it('answers 404 without the right token', async () => {
    build();
    for (const page of ['chat', 'viewers', 'live']) {
      expect((await app.inject({ method: 'GET', url: `/overlay/wrong-token-wrong-token-wrong/${page}` })).statusCode, page).toBe(404);
    }
  });

  it('streams chat with banned words masked, removals, and viewers, but never private activity', async () => {
    build();
    chat.add(message('t1', { user: 'badword_fan', text: 'what a badword moment' }));
    const stream = await openStream();
    await stream.waitFor('chat-snapshot');
    expect(stream.blocks('chat-snapshot')[0]).toEqual([
      expect.objectContaining({ id: 't1', text: 'what a ******* moment' }),
    ]);
    await stream.waitFor('status');
    expect(stream.blocks('status')[0]).toHaveLength(2);

    chat.add(message('k1', { platform: 'kick', userId: '42', text: 'BADWORD again' }));
    await stream.waitFor('chat');
    expect(stream.blocks('chat')[0]).toMatchObject({ id: 'k1', text: '******* again' });

    chat.remove({ kind: 'user', platform: 'kick', userId: '42' });
    await stream.waitFor('chat-remove');
    expect(stream.blocks('chat-remove')[0]).toEqual({ removal: { kind: 'user', platform: 'kick', userId: '42' } });

    hub.publish({ type: 'activity', item: { id: 'a', at: 'now', source: 'donation', headline: [{ text: 'private', emphasis: false }] } });
    chat.add(message('t2'));
    await stream.waitFor('chat', 2);
    expect(stream.text()).not.toContain('event: activity');
    expect(stream.text()).not.toContain('private');
  });
});
