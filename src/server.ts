/**
 * Process entry point: read configuration, start the HTTP server, and shut down
 * cleanly on SIGINT/SIGTERM so `docker stop` does not cut off in-flight requests.
 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig, soundboardFileName } from './config.ts';
import { openDatabase } from './database.ts';
import { join, dirname } from 'node:path';
import { loadOrCreateSessionSecret } from './admin/admin-auth.ts';
import { createAlertHub } from './alerts/alert-hub.ts';
import { createAlertSpeech } from './tts/alert-speech.ts';
import { createPiperClient } from './tts/piper-client.ts';
import { createDonationRepository } from './donations/donation-repository.ts';
import { createLeaderboardQueries } from './donations/leaderboard.ts';
import { createConnectionStore } from './platforms/connection-store.ts';
import { createTwitchApi } from './twitch/twitch-api.ts';
import { createKickApi } from './kick/kick-api.ts';
import { createSubscriptionHealth } from './platforms/subscription-health.ts';
import { twitchWebhookPath } from './routes/twitch-webhook-routes.ts';
import { createKickPublicKeySource } from './kick/kick-public-key.ts';
import { createNowPaymentsClient } from './nowpayments/nowpayments-client.ts';

function loadConfigOrExit() {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      // Plain stderr rather than the logger: the logger's level is itself config,
      // and this message is meant for a human editing their .env file.
      console.error(`${error.message}\n\nSee .env.example for every variable and its meaning.`);
      process.exit(1);
    }
    throw error;
  }
}

function openDatabaseOrExit(path: string) {
  try {
    return openDatabase(path);
  } catch (error) {
    // By far the commonest cause is a mounted directory the container user
    // cannot write, so name it rather than leave a bare SQLite error code.
    console.error(
      `Cannot open the database at ${path}: ${error instanceof Error ? error.message : String(error)}\n\n` +
        'Check that its directory exists and is writable by the user running this service ' +
        '(in Docker, the "node" user, uid 1000).',
    );
    process.exit(1);
  }
}

const config = loadConfigOrExit();
// Opened, and migrated, before listening: a schema problem should stop the boot,
// not surface as a failed donation.
const database = openDatabaseOrExit(config.databasePath);
const connections = createConnectionStore(database);
const twitchApi =
  config.twitch === null ? undefined : createTwitchApi({ clientId: config.twitch.clientId, clientSecret: config.twitch.clientSecret });
const kickApi = config.kick === null ? undefined : createKickApi({ clientId: config.kick.clientId, clientSecret: config.kick.clientSecret });
const subscriptionHealth = createSubscriptionHealth({
  connections,
  ...(twitchApi !== undefined && { twitch: { api: twitchApi, callbackUrl: `${config.publicBaseUrl}${twitchWebhookPath}` } }),
  ...(kickApi !== undefined && { kick: { api: kickApi } }),
});
const app = buildApp(config, {
  donations: createDonationRepository(database),
  leaderboard: createLeaderboardQueries(database),
  connections,
  subscriptionHealth,
  // The EventSub signing secret lives next to the database, like the session key.
  ...(twitchApi !== undefined && {
    twitch: {
      api: twitchApi,
      eventSubSecret: loadOrCreateSessionSecret(join(dirname(config.databasePath), 'twitch-eventsub-secret')),
    },
  }),
  ...(kickApi !== undefined && { kick: { api: kickApi, publicKey: createKickPublicKeySource() } }),
  nowPayments: createNowPaymentsClient({
    apiKey: config.nowPayments.apiKey,
    baseUrl: config.nowPayments.baseUrl,
  }),
  // Next to the database, so it lives in the same persistent volume.
  ...(config.adminPassword !== null && {
    adminSessionSecret: loadOrCreateSessionSecret(join(dirname(config.databasePath), 'session-secret')),
  }),
  alertHub: createAlertHub((error) => app.log.error({ err: error }, 'An overlay listener failed')),
  ...(config.tts !== null && {
    alertSpeech: createAlertSpeech({
      synthesize: createPiperClient({ baseUrl: config.tts.url }).synthesize,
      onError: (error, alertId) => app.log.warn({ err: error, alertId }, 'Text-to-speech failed; alert shown without speech'),
    }),
  }),
});
app.addHook('onClose', async () => {
  database.close();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'Shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      },
    );
  });
}

await app.listen({ host: config.host, port: config.port });
app.log.info(`Public address: ${config.publicBaseUrl}`);
app.log.info(`Database: ${config.databasePath}`);
app.log.info(`NOWPayments: ${config.nowPayments.sandbox ? 'sandbox' : 'production'}`);
app.log.info(`Text-to-speech: ${config.tts === null ? 'off' : config.tts.url}`);
app.log.info(`Twitch: ${config.twitch === null ? 'off (set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET)' : 'configured; connect it from /admin'}`);
app.log.info(`Kick: ${config.kick === null ? 'off (set KICK_CLIENT_ID and KICK_CLIENT_SECRET)' : 'configured; connect it from /admin'}`);
app.log.info(`Admin page: ${config.adminPassword === null ? 'off (set ADMIN_PASSWORD)' : '/admin'}`);
if (config.soundboardIssues.length > 0) {
  app.log.error(`Soundboard: off, because ${soundboardFileName} has problems. Fix them and restart:`);
  for (const issue of config.soundboardIssues) app.log.error(`  ${soundboardFileName}: ${issue}`);
} else {
  app.log.info(`Soundboard: ${config.soundboard === null ? `off (no ${soundboardFileName})` : `${config.soundboard.length} sounds at /sounds`}`);
}

/**
 * Checks Twitch and Kick still hold their alert subscriptions: shortly after
 * start (once the server answers Twitch's challenges), then daily. Findings
 * show on the admin page; see platforms/subscription-health.ts.
 */
const healthCheckDelayMs = 60_000;
const healthCheckIntervalMs = 24 * 60 * 60 * 1000;
async function checkSubscriptions(): Promise<void> {
  const results = await subscriptionHealth.check();
  for (const [platform, problem] of Object.entries(results)) {
    if (problem === null) app.log.info(`${platform} subscriptions: all in place`);
    else app.log.warn(`${platform} subscriptions: ${problem}. Reconnect it from /admin.`);
  }
}
setTimeout(() => void checkSubscriptions(), healthCheckDelayMs).unref();
setInterval(() => void checkSubscriptions(), healthCheckIntervalMs).unref();
