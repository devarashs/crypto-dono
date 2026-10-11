/**
 * Process entry point: read configuration, start the HTTP server, and shut down
 * cleanly on SIGINT/SIGTERM so `docker stop` does not cut off in-flight requests.
 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { openDatabase } from './database.ts';
import { createDonationRepository } from './donations/donation-repository.ts';
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
const app = buildApp(config, {
  donations: createDonationRepository(database),
  nowPayments: createNowPaymentsClient({
    apiKey: config.nowPayments.apiKey,
    baseUrl: config.nowPayments.baseUrl,
  }),
  // Placeholder until the OBS overlay exists: the alert is logged, not shown.
  onDonationAlert: (donation) => {
    app.log.info(
      { donationId: donation.publicId, donorName: donation.donorName, amountMinor: donation.amountMinor },
      'Donation ready to alert',
    );
  },
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
