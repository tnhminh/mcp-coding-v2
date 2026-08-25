import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer } from '../app/create-mcp-server.js';
import { HealthService } from '../app/health-service.js';

const host = process.env.MCP_HOST ?? '127.0.0.1';
const port = Number(process.env.MCP_PORT ?? '7317');
const health = new HealthService();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();
const mcpHandler = createMcpHandler(() => createMcpServer(), {
  legacy: 'reject',
  onerror: (error) => console.error('[mcp-coding-v2][mcp]', error),
});
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error('[mcp-coding-v2][http-adapter]', error),
});

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.url === '/health/live' || req.url === '/health/ready') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(health.snapshot()));
    return;
  }

  if (req.url !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  if (!validateHost(req, res) || !validateOrigin(req, res)) return;
  await handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
}

const httpServer = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    console.error('[mcp-coding-v2][http]', error);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    if (!res.writableEnded) res.end(JSON.stringify({ error: 'internal_error' }));
  });
});

httpServer.listen(port, host, () => {
  console.error(`[mcp-coding-v2] HTTP listening on http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    httpServer.close(() => {
      void mcpHandler.close().finally(() => process.exit(0));
    });
  });
}
