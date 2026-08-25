import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { createMcpServer } from '../app/create-mcp-server.js';
import { HealthService } from '../app/health-service.js';

const host = process.env.MCP_HOST ?? '127.0.0.1';
const port = Number(process.env.MCP_PORT ?? '7317');
const health = new HealthService();
const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

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

  const mcp = createMcpServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcp.connect(transport);
  await transport.handleRequest(req, res);
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
  process.once(signal, () => httpServer.close(() => process.exit(0)));
}
