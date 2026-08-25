import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { AppConfig } from '../app/config.js';
import { ControlCenterService } from '../app/control-center-service.js';
import { AppError, toPublicError } from '../app/errors.js';
import { createMcpServer } from '../app/create-mcp-server.js';
import { createRuntimeServices } from '../app/runtime-services.js';
import { HealthService } from '../app/health-service.js';
import { controlCenterCss, controlCenterHtml, controlCenterJs } from '../control-center/ui.js';
import { JsonLogger } from '../infra/json-logger.js';
import { openSqliteDatabase } from '../infra/sqlite/database.js';


export interface HttpRuntime {
  server: Server;
  close: () => Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 128 * 1024) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Request body is too large.', httpStatus: 413, expose: true });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.', httpStatus: 400, expose: true, cause: error });
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function startHttpRuntime(config: AppConfig, logger: JsonLogger): Promise<HttpRuntime> {
  const health = new HealthService();
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const databaseFilename = config.databasePath === ':memory:' ? ':memory:' : path.resolve(config.databasePath);
  if (databaseFilename !== ':memory:') await mkdir(path.dirname(databaseFilename), { recursive: true });
  const database = openSqliteDatabase(databaseFilename);
  const services = createRuntimeServices(database.database, databaseFilename);
  const controlCenter = new ControlCenterService(services.projects, services.permissionSessions, services.policies, { ...config, databasePath: databaseFilename });
  const mcpHandler = createMcpHandler(() => createMcpServer({
    filesystem: services.filesystem,
    projectDiscovery: services.projectDiscovery,
    tasks: services.tasks,
    skills: services.skills,
    workspace: services.workspace,
    applyVerify: services.applyVerify,
  }), {
    legacy: 'reject',
    onerror: (error) => logger.error('mcp_request_failed', error),
  });
  const handleMcp = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error('http_adapter_failed', error),
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (pathname === '/health/live' || pathname === '/health/ready') {
      writeJson(res, 200, health.snapshot());
      return;
    }

    if (pathname === '/') {
      res.writeHead(302, { location: '/control-center' });
      res.end();
      return;
    }

    if (pathname === '/control-center' || pathname === '/control-center/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(controlCenterHtml);
      return;
    }
    if (pathname === '/control-center/app.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      res.end(controlCenterCss);
      return;
    }
    if (pathname === '/control-center/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(controlCenterJs);
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (pathname === '/api/control-center/overview' && req.method === 'GET') {
        writeJson(res, 200, await controlCenter.overview());
        return;
      }
      if (pathname === '/api/projects' && req.method === 'GET') {
        writeJson(res, 200, { projects: await controlCenter.listProjects() });
        return;
      }
      if (pathname === '/api/projects' && req.method === 'POST') {
        writeJson(res, 201, { project: await controlCenter.createProject(await readJsonBody(req)) });
        return;
      }
      const projectMatch = /^\/api\/projects\/([^/]+)$/u.exec(pathname);
      if (projectMatch) {
        const projectId = decodeURIComponent(projectMatch[1] ?? '');
        if (req.method === 'PUT') {
          writeJson(res, 200, { project: await controlCenter.updateProject(projectId, await readJsonBody(req)) });
          return;
        }
        if (req.method === 'DELETE') {
          await controlCenter.removeProject(projectId);
          writeJson(res, 200, { removed: true });
          return;
        }
      }
      const projectSessionsMatch = /^\/api\/projects\/([^/]+)\/permission-sessions$/u.exec(pathname);
      if (projectSessionsMatch) {
        const projectId = decodeURIComponent(projectSessionsMatch[1] ?? '');
        if (req.method === 'GET') {
          writeJson(res, 200, { permissionSessions: await controlCenter.listPermissionSessions(projectId) });
          return;
        }
        if (req.method === 'POST') {
          writeJson(res, 201, { permissionSession: await controlCenter.createPermissionSession(projectId, await readJsonBody(req)) });
          return;
        }
      }
      const revokeSessionMatch = /^\/api\/permission-sessions\/([^/]+)\/revoke$/u.exec(pathname);
      if (revokeSessionMatch && req.method === 'POST') {
        await controlCenter.revokePermissionSession(decodeURIComponent(revokeSessionMatch[1] ?? ''));
        writeJson(res, 200, { revoked: true });
        return;
      }
      if (pathname === '/api/policies' && req.method === 'GET') {
        writeJson(res, 200, { policies: await controlCenter.listPolicies() });
        return;
      }
      if (pathname === '/api/policies' && req.method === 'POST') {
        writeJson(res, 201, { policy: await controlCenter.createPolicy(await readJsonBody(req)) });
        return;
      }
      const policyMatch = /^\/api\/policies\/([^/]+)$/u.exec(pathname);
      if (policyMatch) {
        const policyId = decodeURIComponent(policyMatch[1] ?? '');
        if (req.method === 'PUT') {
          writeJson(res, 200, { policy: await controlCenter.updatePolicy(policyId, await readJsonBody(req)) });
          return;
        }
        if (req.method === 'DELETE') {
          await controlCenter.removePolicy(policyId);
          writeJson(res, 200, { removed: true });
          return;
        }
      }
      if (pathname === '/api/settings' && req.method === 'GET') {
        writeJson(res, 200, controlCenter.settings());
        return;
      }
      if (pathname === '/api/tools' && req.method === 'GET') {
        writeJson(res, 200, { tools: controlCenter.tools() });
        return;
      }
      throw new AppError({ code: 'NOT_FOUND', message: 'API route not found.', httpStatus: 404, expose: true });
    }

    if (pathname === '/mcp') {
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      await handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
      return;
    }

    throw new AppError({ code: 'NOT_FOUND', message: 'Route not found.', httpStatus: 404, expose: true });
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      logger.error('http_request_failed', error, { method: req.method, url: req.url });
      const publicError = toPublicError(error);
      if (!res.headersSent) {
        res.writeHead(publicError.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      }
      if (!res.writableEnded) res.end(JSON.stringify(publicError.body));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    database.close();
    await mcpHandler.close();
    throw error;
  }

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
      database.close();
      logger.info('http_stopped', 'HTTP runtime stopped');
    },
  };
}
