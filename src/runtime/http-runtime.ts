import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AppConfig } from '../app/config.js';
import { AppError, toPublicError } from '../app/errors.js';
import { createMcpServer } from '../app/create-mcp-server.js';
import { HealthService } from '../app/health-service.js';
import type { JsonLogger } from '../infra/json-logger.js';

export interface HttpRuntime {
  server: Server;
  close: () => Promise<void>;
}

export async function startHttpRuntime(config: AppConfig, logger: JsonLogger): Promise<HttpRuntime> {
  const health = new HealthService();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const mcpHandler = createMcpHandler(() => createMcpServer(), {
    legacy: 'reject',
    onerror: (error) => logger.error('mcp_request_failed', error),
  });
  const handleMcp = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error('http_adapter_failed', error),
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === '/health/live' || req.url === '/health/ready') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(health.snapshot()));
      return;
    }

    if (req.url !== '/mcp') {
      const publicError = toPublicError(
        new AppError({ code: 'NOT_FOUND', message: 'Route not found.', httpStatus: 404, expose: true }),
      );
      res.writeHead(publicError.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(publicError.body));
      return;
    }

    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    await handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      logger.error('http_request_failed', error, { method: req.method, url: req.url });
      const publicError = toPublicError(error);
      if (!res.headersSent) {
        res.writeHead(publicError.status, { 'content-type': 'application/json; charset=utf-8' });
      }
      if (!res.writableEnded) res.end(JSON.stringify(publicError.body));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info('http_started', 'HTTP runtime started', { host: config.host, port: config.port });
  let closed = false;

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([serverClosed, mcpHandler.close()]);
      logger.info('http_stopped', 'HTTP runtime stopped');
    },
  };
}
