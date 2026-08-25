import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../app/create-mcp-server.js';

const handle = serveStdio(() => createMcpServer(), {
  legacy: 'reject',
  onerror: (error) => console.error('[mcp-coding-v2][stdio]', error),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
