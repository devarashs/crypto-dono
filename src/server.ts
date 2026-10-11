/**
 * Process entry point: read configuration, start the HTTP server, and shut down
 * cleanly on SIGINT/SIGTERM so `docker stop` does not cut off in-flight requests.
 */
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';

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

const config = loadConfigOrExit();
const app = buildApp(config);

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
