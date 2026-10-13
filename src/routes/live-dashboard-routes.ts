/**
 * The live dashboard, behind the admin session (registered by the admin routes).
 *
 *   GET /admin/live          the page
 *   GET /admin/live/stream   Server-Sent Events: a snapshot of recent activity,
 *                            then each new item as it happens
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { activityFromDonation, activityFromEvent, mergeActivity, type ActivityItem } from '../dashboard/activity.ts';
import type { DashboardHub } from '../dashboard/dashboard-hub.ts';
import type { DonationRepository } from '../donations/donation-repository.ts';
import type { EventLog } from '../events/event-log.ts';
import type { StreamEventKind } from '../events/stream-event.ts';
import { publicPageWithScriptPolicy } from '../web/content-security-policy.ts';
import { renderLiveDashboardPage } from '../web/live-dashboard-page.ts';
import { sendHtml } from './donation-routes.ts';

export type LiveDashboardDependencies = {
  readonly hub: DashboardHub;
  readonly donations: DonationRepository;
  /** Absent only in tests that do not store events. */
  readonly eventLog?: EventLog;
  readonly eventTemplates: Readonly<Record<StreamEventKind, string>>;
};

/** How much history the page starts with. */
const snapshotSize = 50;
const heartbeatIntervalMs = 15_000;

export function registerLiveDashboardRoutes(
  app: FastifyInstance,
  dependencies: LiveDashboardDependencies,
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
  const { hub, donations, eventLog, eventTemplates } = dependencies;

  function recentActivity(): ActivityItem[] {
    const events = (eventLog?.recent(snapshotSize) ?? []).map((event) => activityFromEvent(event, eventTemplates));
    const paid = donations
      .listPage({ paidOnly: true, limit: snapshotSize })
      .donations.flatMap((donation) => activityFromDonation(donation) ?? []);
    return mergeActivity([events, paid], snapshotSize);
  }

  app.get('/admin/live', { preHandler: requireAdmin }, async (_request, reply) => {
    // The page runs its own script to receive updates; still no inline script.
    reply.header('content-security-policy', publicPageWithScriptPolicy);
    return sendHtml(reply, 200, renderLiveDashboardPage());
  });

  app.get('/admin/live/stream', { preHandler: requireAdmin }, async (request, reply) => {
    // Hijacked like the overlay's stream: an event stream outlives send().
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');

    // Subscribed before the snapshot is read, so nothing falls in between; the
    // page drops an item it already has.
    const unsubscribe = hub.subscribe((message) => {
      response.write(`event: ${message.type}\ndata: ${JSON.stringify(message.item)}\n\n`);
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify(recentActivity())}\n\n`);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), heartbeatIntervalMs);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
