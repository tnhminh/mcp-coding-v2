import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../app/config.js';
import { createMcpServer } from '../app/create-mcp-server.js';
import { JsonLogger } from '../infra/json-logger.js';

const bootstrapLogger = new JsonLogger('info');

function main(): void {
  const config = loadConfig();
  const logger = new JsonLogger(config.logLevel);
  const handle = serveStdio(() => createMcpServer(), {
    legacy: 'reject',
    onerror: (error) => logger.error('stdio_transport_failed', error),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutdown_requested', 'Shutdown signal received', { signal, transport: 'stdio' });
      void handle
        .close()
        .catch((error: unknown) => logger.error('shutdown_failed', error, { transport: 'stdio' }))
        .finally(() => process.exit(0));
    });
  }
}

try {
  main();
} catch (error: unknown) {
  bootstrapLogger.error('startup_failed', error, { transport: 'stdio' });
  process.exitCode = 1;
}
