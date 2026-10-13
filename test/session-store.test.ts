import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteSessionStore } from '../src/admin/session-store.ts';
import { createAlertHub } from '../src/alerts/alert-hub.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDatabase, type Database } from '../src/database.ts';
import { createDonationRepository } from '../src/donations/donation-repository.ts';
import { createLeaderboardQueries } from '../src/donations/leaderboard.ts';
import { createConnectionStore } from '../src/platforms/connection-store.ts';

const password = 'correct horse battery staple';
const secret = 'a'.repeat(64);

describe('admin sign-ins kept in the database', () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  /** One server process over a database; a second call is the same server after a restart. */
  function start(database: Database, now = () => new Date()) {
    const app = buildApp(
      loadConfig({
        PUBLIC_BASE_URL: 'https://dono.example.com',
        NOWPAYMENTS_API_KEY: 'k',
        NOWPAYMENTS_IPN_SECRET: 's',
        OVERLAY_TOKEN: 'overlay-token-for-tests-0123456789',
        LOG_LEVEL: 'fatal',
        ADMIN_PASSWORD: password,
      }),
      {
        donations: createDonationRepository(database),
        leaderboard: createLeaderboardQueries(database),
        connections: createConnectionStore(database),
        nowPayments: { createInvoice: async () => ({ invoiceId: '1', invoiceUrl: 'https://nowpayments.io/x' }) },
        alertHub: createAlertHub(),
        adminSessionSecret: secret,
        adminSessionStore: createSqliteSessionStore(database, now),
      },
    );
    apps.push(app);
    return app;
  }

  async function signIn(app: FastifyInstance): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ password }).toString(),
    });
    const cookie = response.cookies.find((candidate) => candidate.name === 'crypto_dono_admin')!;
    return `${cookie.name}=${cookie.value}`;
  }

  const adminPage = (app: FastifyInstance, cookie: string) => app.inject({ method: 'GET', url: '/admin', headers: { cookie } });

  it('keeps the admin signed in across a restart', async () => {
    const database = openDatabase(':memory:');
    const cookie = await signIn(start(database));
    const afterRestart = start(database);
    expect((await adminPage(afterRestart, cookie)).statusCode).toBe(200);
  });

  it('stores only a hash of the session id', async () => {
    const database = openDatabase(':memory:');
    const cookie = await signIn(start(database));
    const sessionId = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
    const rows = database.prepare('SELECT id_hash, data FROM admin_sessions').all() as { id_hash: string; data: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(sessionId);
  });

  it('extends the sign-in on each visit, and ends it 14 days after the last one', async () => {
    const database = openDatabase(':memory:');
    let clock = new Date('2026-10-01T00:00:00.000Z');
    const now = () => clock;
    const app = start(database, now);
    const cookie = await signIn(app);
    const expiry = () => (database.prepare('SELECT expires_at FROM admin_sessions').get() as { expires_at: string }).expires_at;
    const first = expiry();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adminPage(app, cookie);
    expect(expiry() > first).toBe(true);

    clock = new Date(Date.parse(expiry()) + 1000);
    const afterLongBreak = await adminPage(start(database, now), cookie);
    expect(afterLongBreak.headers.location).toBe('/admin/login');
  });

  it('forgets the sign-in on sign-out', async () => {
    const database = openDatabase(':memory:');
    const app = start(database);
    const cookie = await signIn(app);
    await app.inject({ method: 'POST', url: '/admin/logout', headers: { cookie } });
    expect(database.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get()).toEqual({ count: 0 });
    expect((await adminPage(start(database), cookie)).headers.location).toBe('/admin/login');
  });
});
