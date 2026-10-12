import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { KickApi } from '../src/kick/kick-api.ts';
import type { HealthFinding, HealthPlatform } from '../src/platforms/subscription-health.ts';
import { createInMemoryStore } from './support/in-memory-store.ts';

const password = 'correct horse battery staple';

describe('subscription health on the admin page', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function build(findings: Map<HealthPlatform, HealthFinding>) {
    const store = createInMemoryStore();
    store.connections.connect('kick', '222', 'machinearash');
    const kickApi = {
      authorizeUrl: (_redirect: string, state: string) => `https://id.kick.com/oauth/authorize?state=${state}`,
      identifyStreamer: async () => ({ id: '222', login: 'machinearash', userToken: 't' }),
      listSubscriptions: async () => [],
      deleteSubscriptions: async () => {},
      subscribe: async () => [],
    } as unknown as KickApi;
    const subscriptionHealth = {
      finding: (platform: HealthPlatform) => findings.get(platform),
      clear: vi.fn((platform: HealthPlatform) => void findings.delete(platform)),
    };
    app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD: password,
        KICK_CLIENT_ID: '01JXCLIENT',
        KICK_CLIENT_SECRET: 'kick-secret',
      }),
      {
        donations: store.donations,
        leaderboard: store.leaderboard,
        connections: store.connections,
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        adminSessionSecret: 'a'.repeat(64),
        kick: { api: kickApi, publicKey: { current: async () => '', refresh: async () => null } },
        subscriptionHealth,
      },
    );
    return { app, subscriptionHealth };
  }

  async function signIn(server: FastifyInstance): Promise<string> {
    const response = await server.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password }).toString(),
    });
    const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin')!;
    return `${cookie.name}=${cookie.value}`;
  }

  it('shows what the daily check found, with a reconnect button, and clears it on reconnect', async () => {
    const findings = new Map<HealthPlatform, HealthFinding>([
      ['kick', { checkedAt: '2026-10-13T12:00:00.000Z', problem: 'channel.followed missing' }],
    ]);
    const { app: server, subscriptionHealth } = build(findings);
    const cookie = await signIn(server);
    const page = await server.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    expect(page.body).toContain('Connected as <strong>machinearash</strong>');
    expect(page.body).toContain('The daily check found some Kick alerts are no longer set up');
    expect(page.body).toContain('(channel.followed missing)');
    expect(page.body).toContain('Reconnect Kick');

    const start = await server.inject({ method: 'GET', url: '/admin/kick/connect', headers: { cookie } });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    await server.inject({ method: 'GET', url: `/admin/kick/callback?code=abc&state=${state}` });
    expect(subscriptionHealth.clear).toHaveBeenCalledWith('kick');
    expect((await server.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).not.toContain('daily check found');
  });

  it('shows no warning when the check found everything in place', async () => {
    const { app: server } = build(new Map([['kick', { checkedAt: 'x', problem: null }]]));
    const cookie = await signIn(server);
    expect((await server.inject({ method: 'GET', url: '/admin', headers: { cookie } })).body).not.toContain('daily check found');
  });
});
