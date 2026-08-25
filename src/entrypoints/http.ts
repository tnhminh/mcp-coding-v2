import { loadConfig } from '../app/config.js';
import { JsonLogger } from '../infra/json-logger.js';
import { startHttpRuntime } from '../runtime/http-runtime.js';

const bootstrapLogger = new JsonLogger('info');

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger(config.logLevel);
  const runtime = await startHttpRuntime(config, logger);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutdown_requested', 'Shutdown signal received', { signal });
      void runtime
        .close()
        .catch((error: unknown) => logger.error('shutdown_failed', error))
        .finally(() => process.exit(0));
    });
  }
}

void main().catch((error: unknown) => {
  bootstrapLogger.error('startup_failed', error);
  process.exitCode = 1;
});
