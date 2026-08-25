import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from '../app/config.js';
import { createMcpServer } from '../app/create-mcp-server.js';
import { createRuntimeServices } from '../app/runtime-services.js';
import { JsonLogger } from '../infra/json-logger.js';
import { openSqliteDatabase } from '../infra/sqlite/database.js';

const bootstrapLogger = new JsonLogger('info');

function main(): void {
  const config = loadConfig();
  const logger = new JsonLogger(config.logLevel);
  const databaseFilename = config.databasePath === ':memory:' ? ':memory:' : path.resolve(config.databasePath);
  if (databaseFilename !== ':memory:') mkdirSync(path.dirname(databaseFilename), { recursive: true });
  const database = openSqliteDatabase(databaseFilename);
  const services = createRuntimeServices(database.database, databaseFilename);
  const handle = serveStdio(() => createMcpServer({
    filesystem: services.filesystem,
    projectDiscovery: services.projectDiscovery,
    tasks: services.tasks,
    skills: services.skills,
    workspace: services.workspace,
    applyVerify: services.applyVerify,
  }), {
    legacy: 'reject',
    onerror: (error) => logger.error('stdio_transport_failed', error),
  });
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
    database.close();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info('shutdown_requested', 'Shutdown signal received', { signal, transport: 'stdio' });
      void close()
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
