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
import { TunnelIntegrationService } from '../app/tunnel-integration-service.js';
import { TunnelSetupStore } from '../app/tunnel-setup-store.js';
import { WindowsAutoStartService } from '../app/windows-autostart-service.js';
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
  const tunnelSetupStore = databaseFilename === ':memory:' ? null : new TunnelSetupStore(path.dirname(databaseFilename));
  const tunnelEnv: NodeJS.ProcessEnv = { ...process.env };
  if (tunnelSetupStore) {
    const persisted = await tunnelSetupStore.snapshot();
    if (!tunnelEnv.CONTROL_PLANE_TUNNEL_ID && persisted.tunnelId) tunnelEnv.CONTROL_PLANE_TUNNEL_ID = persisted.tunnelId;
    if (!tunnelEnv.CONTROL_PLANE_API_KEY && persisted.runtimeApiKeyConfigured) {
      const storedKey = await tunnelSetupStore.runtimeApiKey();
      if (storedKey) tunnelEnv.CONTROL_PLANE_API_KEY = storedKey;
    }
    if (!tunnelEnv.MCP_TUNNEL_AUTO_CONNECT && persisted.autoConnect) tunnelEnv.MCP_TUNNEL_AUTO_CONNECT = '1';
  }
  const tunnel = new TunnelIntegrationService({ host: config.host, port: config.port, env: tunnelEnv, ...(tunnelSetupStore ? { setupStore: tunnelSetupStore } : {}) });
  const autoStart = new WindowsAutoStartService({
    projectRoot: process.cwd(),
    runtimeRoot: databaseFilename === ':memory:' ? path.resolve('.runtime') : path.dirname(databaseFilename),
    host: config.host,
    port: config.port,
  });
  const controlCenter = new ControlCenterService(services.projects, services.authorization, services.permissionSessions, services.policies, services.aiJobs, services.previews, services.git, services.processes, tunnel, autoStart, services.auditUsage, { ...config, databasePath: databaseFilename });
  const mcpHandler = createMcpHandler(() => createMcpServer({
    authorization: services.authorization,
    filesystem: services.filesystem,
    projectDiscovery: services.projectDiscovery,
    readiness: services.readiness,
    tasks: services.tasks,
    commandRecipes: services.commandRecipes,
    git: services.git,
    processes: services.processes,
    skills: services.skills,
    workspace: services.workspace,
    applyVerify: services.applyVerify,
    brain: services.brain,
    contextImpact: services.contextImpact,
    codingCycle: services.codingCycle,
    aiJobs: services.aiJobs,
    previews: services.previews,
    auditUsage: services.auditUsage,
  }), {
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
      const auditStarted = Date.now();
      const mutationMethod = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
      if (mutationMethod) {
        res.once('finish', () => {
          const projectId = /^\/api\/projects\/([^/]+)/u.exec(pathname)?.[1];
          services.auditUsage.recordAudit({
            category: 'control_center_api',
            action: `${req.method ?? 'UNKNOWN'} ${pathname}`,
            actorType: 'local_control_center',
            ...(projectId ? { projectId: decodeURIComponent(projectId) } : {}),
            status: res.statusCode >= 400 ? 'failure' : 'success',
            durationMs: Date.now() - auditStarted,
            ...(res.statusCode >= 400 ? { errorCode: `HTTP_${res.statusCode}` } : {}),
            metadata: { localOnly: true },
          });
        });
      }
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
      const projectAccessMatch = /^\/api\/projects\/([^/]+)\/access$/u.exec(pathname);
      if (projectAccessMatch && req.method === 'GET') {
        writeJson(res, 200, { access: await controlCenter.projectAccess(decodeURIComponent(projectAccessMatch[1] ?? '')) });
        return;
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
      const projectJobsMatch = /^\/api\/projects\/([^/]+)\/ai-jobs$/u.exec(pathname);
      if (projectJobsMatch) {
        const projectId = decodeURIComponent(projectJobsMatch[1] ?? '');
        if (req.method === 'GET') {
          writeJson(res, 200, { jobs: await controlCenter.listAiJobs(projectId) });
          return;
        }
        if (req.method === 'POST') {
          writeJson(res, 201, { job: await controlCenter.createAiJob(projectId, await readJsonBody(req)) });
          return;
        }
      }
      const aiJobMatch = /^\/api\/ai-jobs\/([^/]+)$/u.exec(pathname);
      if (aiJobMatch && req.method === 'GET') {
        writeJson(res, 200, { job: await controlCenter.aiJobStatus(decodeURIComponent(aiJobMatch[1] ?? '')) });
        return;
      }
      const cancelAiJobMatch = /^\/api\/ai-jobs\/([^/]+)\/cancel$/u.exec(pathname);
      if (cancelAiJobMatch && req.method === 'POST') {
        writeJson(res, 200, { job: await controlCenter.cancelAiJob(decodeURIComponent(cancelAiJobMatch[1] ?? '')) });
        return;
      }
      const projectGitStatusMatch = /^\/api\/projects\/([^/]+)\/git\/status$/u.exec(pathname);
      if (projectGitStatusMatch && req.method === 'GET') {
        writeJson(res, 200, { git: await controlCenter.gitStatus(decodeURIComponent(projectGitStatusMatch[1] ?? '')) });
        return;
      }
      const projectGitLogMatch = /^\/api\/projects\/([^/]+)\/git\/log$/u.exec(pathname);
      if (projectGitLogMatch && req.method === 'GET') {
        const projectId = decodeURIComponent(projectGitLogMatch[1] ?? '');
        const limitText = requestUrl.searchParams.get('limit');
        const limit = limitText === null ? 20 : Number(limitText);
        writeJson(res, 200, { gitLog: await controlCenter.gitLog(projectId, Number.isFinite(limit) ? limit : 20) });
        return;
      }
      const projectGitBranchesMatch = /^\/api\/projects\/([^/]+)\/git\/branches$/u.exec(pathname);
      if (projectGitBranchesMatch && req.method === 'GET') {
        writeJson(res, 200, { gitBranches: await controlCenter.gitBranches(decodeURIComponent(projectGitBranchesMatch[1] ?? '')) });
        return;
      }
      const projectProcessProfilesMatch = /^\/api\/projects\/([^/]+)\/process-profiles$/u.exec(pathname);
      if (projectProcessProfilesMatch && req.method === 'GET') {
        writeJson(res, 200, { processProfiles: await controlCenter.processProfiles(decodeURIComponent(projectProcessProfilesMatch[1] ?? '')) });
        return;
      }
      const projectProcessesMatch = /^\/api\/projects\/([^/]+)\/processes$/u.exec(pathname);
      if (projectProcessesMatch) {
        const projectId = decodeURIComponent(projectProcessesMatch[1] ?? '');
        if (req.method === 'GET') {
          writeJson(res, 200, { processes: await controlCenter.listProcesses(projectId) });
          return;
        }
        if (req.method === 'POST') {
          writeJson(res, 201, { process: await controlCenter.startProcess(projectId, await readJsonBody(req)) });
          return;
        }
      }
      const projectProcessStatusMatch = /^\/api\/projects\/([^/]+)\/processes\/([^/]+)$/u.exec(pathname);
      if (projectProcessStatusMatch && req.method === 'GET') {
        writeJson(res, 200, { process: await controlCenter.processStatus(
          decodeURIComponent(projectProcessStatusMatch[1] ?? ''),
          decodeURIComponent(projectProcessStatusMatch[2] ?? ''),
        ) });
        return;
      }
      const projectProcessStopMatch = /^\/api\/projects\/([^/]+)\/processes\/([^/]+)\/stop$/u.exec(pathname);
      if (projectProcessStopMatch && req.method === 'POST') {
        writeJson(res, 200, { process: await controlCenter.stopProcess(
          decodeURIComponent(projectProcessStopMatch[1] ?? ''),
          decodeURIComponent(projectProcessStopMatch[2] ?? ''),
        ) });
        return;
      }
      const previewProfilesMatch = /^\/api\/projects\/([^/]+)\/preview-profiles$/u.exec(pathname);
      if (previewProfilesMatch && req.method === 'GET') {
        writeJson(res, 200, { previewProfiles: await controlCenter.previewProfiles(decodeURIComponent(previewProfilesMatch[1] ?? '')) });
        return;
      }
      const projectPreviewsMatch = /^\/api\/projects\/([^/]+)\/previews$/u.exec(pathname);
      if (projectPreviewsMatch) {
        const projectId = decodeURIComponent(projectPreviewsMatch[1] ?? '');
        if (req.method === 'GET') {
          writeJson(res, 200, { previews: await controlCenter.listPreviews(projectId) });
          return;
        }
        if (req.method === 'POST') {
          writeJson(res, 201, { preview: await controlCenter.startPreview(projectId, await readJsonBody(req)) });
          return;
        }
      }
      const previewMatch = /^\/api\/previews\/([^/]+)$/u.exec(pathname);
      if (previewMatch && req.method === 'GET') {
        writeJson(res, 200, { preview: await controlCenter.previewStatus(decodeURIComponent(previewMatch[1] ?? '')) });
        return;
      }
      const stopPreviewMatch = /^\/api\/previews\/([^/]+)\/stop$/u.exec(pathname);
      if (stopPreviewMatch && req.method === 'POST') {
        writeJson(res, 200, { preview: await controlCenter.stopPreview(decodeURIComponent(stopPreviewMatch[1] ?? '')) });
        return;
      }
      const reviewPreviewMatch = /^\/api\/previews\/([^/]+)\/review$/u.exec(pathname);
      if (reviewPreviewMatch && req.method === 'POST') {
        writeJson(res, 200, { review: await controlCenter.reviewPreview(decodeURIComponent(reviewPreviewMatch[1] ?? ''), await readJsonBody(req)) });
        return;
      }
      if (pathname === '/api/tunnel/status' && req.method === 'GET') {
        writeJson(res, 200, { tunnel: await controlCenter.tunnelStatus() });
        return;
      }
      if (pathname === '/api/tunnel/setup' && req.method === 'GET') {
        writeJson(res, 200, await controlCenter.tunnelSetupStatus());
        return;
      }
      if (pathname === '/api/tunnel/setup' && req.method === 'PUT') {
        writeJson(res, 200, await controlCenter.tunnelConfigure(await readJsonBody(req)));
        return;
      }
      if (pathname === '/api/tunnel/auto-connect' && req.method === 'PUT') {
        writeJson(res, 200, await controlCenter.tunnelSetAutoConnect(await readJsonBody(req)));
        return;
      }
      if (pathname === '/api/tunnel/windows-autostart' && req.method === 'GET') {
        writeJson(res, 200, { autoStart: await controlCenter.tunnelAutoStartStatus() });
        return;
      }
      if (pathname === '/api/tunnel/windows-autostart' && req.method === 'PUT') {
        writeJson(res, 200, { autoStart: await controlCenter.tunnelSetWindowsAutoStart(await readJsonBody(req)) });
        return;
      }
      if (pathname === '/api/tunnel/runtime-api-key' && req.method === 'DELETE') {
        writeJson(res, 200, await controlCenter.tunnelClearStoredRuntimeApiKey());
        return;
      }
      if (pathname === '/api/tunnel/doctor' && req.method === 'POST') {
        writeJson(res, 200, { doctor: await controlCenter.tunnelDoctor() });
        return;
      }
      if (pathname === '/api/tunnel/connect' && req.method === 'POST') {
        writeJson(res, 200, { tunnel: await controlCenter.tunnelConnect() });
        return;
      }
      if (pathname === '/api/tunnel/disconnect' && req.method === 'POST') {
        writeJson(res, 200, { tunnel: await controlCenter.tunnelDisconnect() });
        return;
      }
      if (pathname === '/api/audit' && req.method === 'GET') {
        const limitText = requestUrl.searchParams.get('limit');
        const statusText = requestUrl.searchParams.get('status');
        const category = requestUrl.searchParams.get('category') ?? undefined;
        const projectId = requestUrl.searchParams.get('project_id') ?? undefined;
        const query = requestUrl.searchParams.get('q') ?? undefined;
        const limit = limitText === null ? undefined : Number(limitText);
        const status = statusText === 'success' || statusText === 'failure' ? statusText : undefined;
        writeJson(res, 200, { auditEvents: controlCenter.auditEvents({ ...(limit === undefined ? {} : { limit }), ...(status === undefined ? {} : { status }), ...(category === undefined ? {} : { category }), ...(projectId === undefined ? {} : { projectId }), ...(query === undefined ? {} : { query }) }) });
        return;
      }
      if (pathname === '/api/usage' && req.method === 'GET') {
        const daysText = requestUrl.searchParams.get('days');
        const days = daysText === null ? undefined : Number(daysText);
        const projectId = requestUrl.searchParams.get('project_id') ?? undefined;
        writeJson(res, 200, { usage: controlCenter.usageDashboard({ ...(days === undefined ? {} : { days }), ...(projectId === undefined ? {} : { projectId }) }) });
        return;
      }
      if (pathname === '/api/usage/llm' && req.method === 'POST') {
        writeJson(res, 201, { usageEvent: controlCenter.recordLlmUsage(await readJsonBody(req)) });
        return;
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
    await Promise.all([
      services.previews.closeAll().catch(() => undefined),
      services.processes.closeAll().catch(() => undefined),
    ]);
    database.close();
    await mcpHandler.close();
    throw error;
  }

  logger.info('http_started', 'HTTP runtime started', { host: config.host, port: config.port });
  if (tunnel.autoConnectEnabled()) {
    void tunnel.connect()
      .then((status) => logger.info('tunnel_auto_connected', 'Secure MCP tunnel auto-connect completed', { state: status.state }))
      .catch((error: unknown) => logger.error('tunnel_auto_connect_failed', error));
  }
  let closed = false;

  return {
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([serverClosed, mcpHandler.close(), services.previews.closeAll(), services.processes.closeAll()]);
      database.close();
      logger.info('http_stopped', 'HTTP runtime stopped');
    },
  };
}
