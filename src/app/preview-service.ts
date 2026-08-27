import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { killProcessTree, redactProcessOutput, sanitizedEnvironment } from './safe-process-runner.js';
import { isSensitiveRelativePath } from './secure-filesystem-service.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

const MAX_STATIC_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_LOG_BYTES = 128 * 1024;
const PREVIEW_START_TIMEOUT_MS = 20_000;
const STATIC_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.map', '.txt', '.xml', '.webmanifest',
]);
const HIDDEN_OR_INTERNAL = new Set(['.git', '.runtime', 'node_modules']);
const DEV_SCRIPT_NAMES = ['dev', 'start', 'serve', 'preview'] as const;
const packageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
type PreviewKind = 'static' | 'dev';
type PreviewState = 'running' | 'stopped' | 'failed';
type Framework = 'static' | 'vite' | 'next' | 'astro' | 'webpack' | 'react-scripts';

export interface PreviewProfile {
  id: string;
  kind: PreviewKind;
  label: string;
  framework: Framework;
  script: string | null;
}

export interface PreviewSession {
  id: string;
  projectId: string;
  profileId: string;
  kind: PreviewKind;
  framework: Framework;
  url: string;
  port: number;
  state: PreviewState;
  startedAt: string;
  stoppedAt: string | null;
  stdout: string;
  stderr: string;
}

export type BrowserAction =
  | { type: 'click'; selector: string }
  | { type: 'click_text'; text: string }
  | { type: 'fill'; selector: string; value: string }
  | { type: 'press'; selector: string; key: string }
  | { type: 'wait'; milliseconds: number };

export interface BrowserReviewResult {
  previewId: string;
  url: string;
  title: string;
  httpStatus: number | null;
  bodyText: string;
  headings: Array<{ level: number; text: string }>;
  interactive: Array<{ tag: string; text: string; type: string | null; name: string | null; id: string | null; ariaLabel: string | null }>;
  consoleMessages: Array<{ type: string; text: string }>;
  pageErrors: string[];
  failedRequests: Array<{ url: string; failure: string }>;
  blockedRequests: string[];
  actionResults: Array<{ type: BrowserAction['type']; success: boolean; detail: string }>;
  screenshotBase64: string;
}

interface PackageMetadata {
  manager: PackageManager;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

interface InternalPreview {
  session: PreviewSession;
  server?: Server;
  child?: ChildProcess;
  stdoutBuffer: Buffer;
  stderrBuffer: Buffer;
}

function packageManagerFrom(value: string | undefined): PackageManager {
  const declared = value?.split('@')[0]?.toLowerCase();
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  return 'npm';
}

function frameworkFor(metadata: PackageMetadata, scriptBody: string): Framework | null {
  const deps = metadata.dependencies;
  if ('vite' in deps || /\bvite\b/iu.test(scriptBody)) return 'vite';
  if ('next' in deps || /\bnext\b/iu.test(scriptBody)) return 'next';
  if ('astro' in deps || /\bastro\b/iu.test(scriptBody)) return 'astro';
  if ('webpack-dev-server' in deps || /webpack(?:-dev-server|\s+serve)/iu.test(scriptBody)) return 'webpack';
  if ('react-scripts' in deps || /\breact-scripts\s+start\b/iu.test(scriptBody)) return 'react-scripts';
  return null;
}

function mimeType(extension: string): string {
  const mapping: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
  };
  return mapping[extension] ?? 'application/octet-stream';
}

function safeStaticRelativePath(pathname: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); }
  catch (error) { throw new AppError({ code: 'PATH_INVALID', message: 'Preview URL path is invalid.', httpStatus: 400, expose: true, cause: error }); }
  if (decoded.includes('\0')) throw new AppError({ code: 'PATH_INVALID', message: 'Preview URL path is invalid.', httpStatus: 400, expose: true });
  let relativePath = decoded.replace(/^\/+/, '');
  if (!relativePath || relativePath.endsWith('/')) relativePath += 'index.html';
  const segments = relativePath.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('.') || HIDDEN_OR_INTERNAL.has(segment.toLowerCase())) || isSensitiveRelativePath(relativePath)) {
    throw new AppError({ code: 'SENSITIVE_PATH', message: 'Sensitive, hidden, or internal paths are not served by project previews.', httpStatus: 403, expose: true });
  }
  return relativePath;
}

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= MAX_PREVIEW_LOG_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PREVIEW_LOG_BYTES - current.length)]);
}

function publicSession(preview: InternalPreview): PreviewSession {
  return {
    ...preview.session,
    stdout: redactProcessOutput(preview.stdoutBuffer.toString('utf8')),
    stderr: redactProcessOutput(preview.stderrBuffer.toString('utf8')),
  };
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve preview port'));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function packageCommand(manager: PackageManager, script: string, framework: Framework, port: number): { executable: string; args: string[]; env: Record<string, string> } {
  const forwarded = framework === 'next'
    ? ['--hostname', '127.0.0.1', '--port', String(port)]
    : framework === 'react-scripts'
      ? []
      : ['--host', '127.0.0.1', '--port', String(port)];
  const managerArgs = ['run', script, ...(forwarded.length > 0 ? ['--', ...forwarded] : [])];
  const env = { HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', PORT: String(port), BROWSER: 'none' };
  if (process.platform !== 'win32') return { executable: manager, args: managerArgs, env };
  const shell = process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
  const command = `${manager}.cmd ${managerArgs.join(' ')}`;
  return { executable: shell, args: ['/d', '/s', '/c', command], env };
}

function browserExecutablePath(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

async function waitForPreview(url: string, preview: InternalPreview): Promise<void> {
  const deadline = Date.now() + PREVIEW_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (preview.child && preview.child.exitCode !== null) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status < 500) return;
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new AppError({ code: 'COMMAND_FAILED', message: 'Preview server did not become reachable on its reserved loopback port.', httpStatus: 500, expose: true });
}

export class PreviewService {
  private readonly previews = new Map<string, InternalPreview>();

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
  ) {}

  async profiles(request: { projectId: string; permissionSessionId?: string }): Promise<PreviewProfile[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const profiles: PreviewProfile[] = [];
    if (await this.exists(resolver, 'index.html')) {
      profiles.push({ id: 'static', kind: 'static', label: 'Static project root (index.html)', framework: 'static', script: null });
    }
    const metadata = await this.packageMetadata(resolver);
    if (metadata) {
      for (const script of DEV_SCRIPT_NAMES) {
        const body = metadata.scripts[script];
        if (!body) continue;
        const framework = frameworkFor(metadata, body);
        if (!framework) continue;
        profiles.push({ id: `package:${script}`, kind: 'dev', label: `${framework} via ${script}`, framework, script });
      }
    }
    return profiles;
  }

  async list(request: { projectId: string; permissionSessionId?: string }): Promise<PreviewSession[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    return [...this.previews.values()]
      .filter((preview) => preview.session.projectId === request.projectId)
      .map((preview) => publicSession(preview))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  }

  async start(request: { projectId: string; permissionSessionId?: string; profileId: string }): Promise<PreviewSession> {
    const profiles = await this.profiles(request);
    const profile = profiles.find((candidate) => candidate.id === request.profileId);
    if (!profile) throw new AppError({ code: 'NOT_FOUND', message: 'Requested preview profile is not available for this project.', httpStatus: 404, expose: true });
    if (profile.kind === 'dev') {
      await this.authorization.resolvePermissionSession({
        projectId: request.projectId,
        ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
        capabilities: ['filesystem.read', 'command.run'],
      });
    }
    return profile.kind === 'static' ? this.startStatic(request.projectId, profile) : this.startDev(request.projectId, profile);
  }

  async status(request: { previewId: string; permissionSessionId?: string }): Promise<PreviewSession> {
    const preview = this.requirePreview(request.previewId);
    await this.authorization.authorize({ projectId: preview.session.projectId, ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }), capability: 'filesystem.read' });
    return publicSession(preview);
  }

  async stop(request: { previewId: string; permissionSessionId?: string }): Promise<PreviewSession> {
    const preview = this.requirePreview(request.previewId);
    await this.authorization.resolvePermissionSession({
      projectId: preview.session.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: preview.session.kind === 'dev' ? ['filesystem.read', 'command.run'] : ['filesystem.read'],
    });
    await this.stopInternal(preview);
    return publicSession(preview);
  }

  async review(request: { previewId: string; permissionSessionId?: string; path?: string; actions?: readonly BrowserAction[] }): Promise<BrowserReviewResult> {
    const preview = this.requirePreview(request.previewId);
    if (preview.session.state !== 'running') throw new AppError({ code: 'CONFLICT', message: 'Browser review requires a running preview.', httpStatus: 409, expose: true });
    await this.authorization.resolvePermissionSession({
      projectId: preview.session.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'command.run'],
    });
    const executablePath = browserExecutablePath();
    if (!executablePath) throw new AppError({ code: 'SERVICE_UNAVAILABLE', message: 'No supported local Edge/Chrome executable was found for browser review.', httpStatus: 503, expose: true });

    const baseUrl = new URL(preview.session.url);
    const relativePath = request.path ?? '/';
    if (!relativePath.startsWith('/') || relativePath.startsWith('//')) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Browser review path must be a project-preview relative path beginning with /.', httpStatus: 400, expose: true });
    }
    const targetUrl = new URL(relativePath, baseUrl);
    if (targetUrl.origin !== baseUrl.origin) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Browser review cannot navigate outside the preview origin.', httpStatus: 400, expose: true });

    const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-extensions', '--disable-background-networking'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const blockedRequests: string[] = [];
    const consoleMessages: Array<{ type: string; text: string }> = [];
    const pageErrors: string[] = [];
    const failedRequests: Array<{ url: string; failure: string }> = [];
    try {
      await context.route('**/*', async (route) => {
        const requestUrl = route.request().url();
        let parsed: URL;
        try { parsed = new URL(requestUrl); }
        catch { blockedRequests.push(requestUrl); await route.abort('blockedbyclient'); return; }
        if (['data:', 'blob:'].includes(parsed.protocol) || parsed.origin === baseUrl.origin) {
          await route.continue();
          return;
        }
        if (blockedRequests.length < 100) blockedRequests.push(requestUrl);
        await route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', async (ws) => {
        let parsed: URL;
        try { parsed = new URL(ws.url()); }
        catch { await ws.close({ code: 1008, reason: 'blocked' }); return; }
        if (parsed.origin === baseUrl.origin) {
          ws.connectToServer();
          return;
        }
        if (blockedRequests.length < 100) blockedRequests.push(ws.url());
        await ws.close({ code: 1008, reason: 'external websocket blocked' });
      });

      const page = await context.newPage();
      page.on('console', (message) => { if (consoleMessages.length < 100) consoleMessages.push({ type: message.type(), text: message.text().slice(0, 1000) }); });
      page.on('pageerror', (error) => { if (pageErrors.length < 50) pageErrors.push(error.message.slice(0, 2000)); });
      page.on('requestfailed', (failed) => {
        if (failedRequests.length < 50) failedRequests.push({ url: failed.url(), failure: failed.failure()?.errorText ?? 'request failed' });
      });
      const response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const actionResults: BrowserReviewResult['actionResults'] = [];
      for (const action of request.actions ?? []) {
        try {
          if (action.type === 'click') await page.locator(action.selector).first().click({ timeout: 5_000 });
          else if (action.type === 'click_text') await page.getByText(action.text, { exact: false }).first().click({ timeout: 5_000 });
          else if (action.type === 'fill') await page.locator(action.selector).first().fill(action.value, { timeout: 5_000 });
          else if (action.type === 'press') await page.locator(action.selector).first().press(action.key, { timeout: 5_000 });
          else await page.waitForTimeout(Math.min(Math.max(action.milliseconds, 0), 5_000));
          actionResults.push({ type: action.type, success: true, detail: 'ok' });
        } catch (error) {
          actionResults.push({ type: action.type, success: false, detail: error instanceof Error ? error.message.slice(0, 1000) : 'action failed' });
        }
      }
      await page.waitForTimeout(150);
      const title = await page.title();
      const bodyText = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 12_000);
      const dom = await page.evaluate(() => ({
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 50).map((node) => ({
          level: Number(node.tagName.slice(1)),
          text: (node.textContent ?? '').trim().slice(0, 500),
        })),
        interactive: Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"]')).slice(0, 100).map((node) => {
          const element = node as HTMLElement;
          const input = node as HTMLInputElement;
          return {
            tag: node.tagName.toLowerCase(),
            text: (node.textContent ?? '').trim().slice(0, 300),
            type: input.type || null,
            name: input.name || null,
            id: element.id || null,
            ariaLabel: element.getAttribute('aria-label'),
          };
        }),
      }));
      const screenshotBase64 = (await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false })).toString('base64');
      return {
        previewId: preview.session.id,
        url: page.url(),
        title,
        httpStatus: response?.status() ?? null,
        bodyText,
        headings: dom.headings,
        interactive: dom.interactive,
        consoleMessages,
        pageErrors,
        failedRequests,
        blockedRequests,
        actionResults,
        screenshotBase64,
      };
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.previews.values()].map((preview) => this.stopInternal(preview).catch(() => undefined)));
  }

  private async startStatic(projectId: string, profile: PreviewProfile): Promise<PreviewSession> {
    const resolver = await this.paths.forProject(projectId);
    const id = randomUUID();
    const preview: InternalPreview = {
      session: { id, projectId, profileId: profile.id, kind: profile.kind, framework: profile.framework, url: '', port: 0, state: 'running', startedAt: new Date().toISOString(), stoppedAt: null, stdout: '', stderr: '' },
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
    };
    const server = createServer((req, res) => {
      void this.serveStaticRequest(resolver, req.url ?? '/', res).catch((error: unknown) => {
        const statusCode = error instanceof AppError ? error.httpStatus : 500;
        if (!res.headersSent) res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        if (!res.writableEnded) res.end(error instanceof AppError && error.expose ? error.message : 'Preview request failed.');
      });
    });
    preview.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new AppError({ code: 'INTERNAL_ERROR', message: 'Static preview did not expose a TCP port.' });
    }
    preview.session.port = address.port;
    preview.session.url = `http://127.0.0.1:${address.port}/`;
    this.previews.set(id, preview);
    return publicSession(preview);
  }

  private async startDev(projectId: string, profile: PreviewProfile): Promise<PreviewSession> {
    if (!profile.script) throw new AppError({ code: 'INTERNAL_ERROR', message: 'Dev preview profile has no script.' });
    const resolver = await this.paths.forProject(projectId);
    const metadata = await this.packageMetadata(resolver);
    if (!metadata) throw new AppError({ code: 'NOT_FOUND', message: 'package.json is required for a dev preview.', httpStatus: 404, expose: true });
    const port = await reserveLoopbackPort();
    const spec = packageCommand(metadata.manager, profile.script, profile.framework, port);
    const id = randomUUID();
    const preview: InternalPreview = {
      session: { id, projectId, profileId: profile.id, kind: profile.kind, framework: profile.framework, url: `http://127.0.0.1:${port}/`, port, state: 'running', startedAt: new Date().toISOString(), stoppedAt: null, stdout: '', stderr: '' },
      stdoutBuffer: Buffer.alloc(0),
      stderrBuffer: Buffer.alloc(0),
    };
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: resolver.canonicalRoot,
        env: sanitizedEnvironment(spec.env),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new AppError({ code: 'COMMAND_FAILED', message: 'Dev preview process could not be started.', httpStatus: 500, expose: true, cause: error });
    }
    preview.child = child;
    child.stdout?.on('data', (chunk: Buffer) => { preview.stdoutBuffer = appendBounded(preview.stdoutBuffer, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { preview.stderrBuffer = appendBounded(preview.stderrBuffer, chunk); });
    child.once('error', (error) => {
      preview.stderrBuffer = appendBounded(preview.stderrBuffer, Buffer.from(error.message));
      preview.session.state = 'failed';
      preview.session.stoppedAt = new Date().toISOString();
    });
    child.once('close', (code) => {
      if (preview.session.state === 'running') preview.session.state = code === 0 ? 'stopped' : 'failed';
      preview.session.stoppedAt ??= new Date().toISOString();
    });
    this.previews.set(id, preview);
    try {
      await waitForPreview(preview.session.url, preview);
    } catch (error) {
      await this.stopInternal(preview);
      throw error;
    }
    return publicSession(preview);
  }

  private async stopInternal(preview: InternalPreview): Promise<void> {
    if (preview.session.state === 'stopped') return;
    if (preview.server) {
      await new Promise<void>((resolve) => preview.server?.close(() => resolve()));
    }
    if (preview.child && preview.child.exitCode === null) await killProcessTree(preview.child);
    preview.session.state = 'stopped';
    preview.session.stoppedAt ??= new Date().toISOString();
  }

  private requirePreview(previewId: string): InternalPreview {
    const preview = this.previews.get(z.string().uuid().parse(previewId));
    if (!preview) throw new AppError({ code: 'NOT_FOUND', message: 'Preview session was not found in this runtime.', httpStatus: 404, expose: true });
    return preview;
  }

  private async serveStaticRequest(resolver: ProjectPathResolver, requestUrl: string, res: ServerResponse): Promise<void> {
    const pathname = new URL(requestUrl, 'http://127.0.0.1').pathname;
    let requested = safeStaticRelativePath(pathname);
    let resolved;
    try {
      resolved = await resolver.resolveExisting(requested);
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND' && path.extname(requested) === '') {
        requested = 'index.html';
        resolved = await resolver.resolveExisting(requested);
      } else throw error;
    }
    const extension = path.extname(resolved.relativePath).toLowerCase();
    if (!STATIC_EXTENSIONS.has(extension)) throw new AppError({ code: 'SENSITIVE_PATH', message: 'This asset type is not exposed by static preview.', httpStatus: 403, expose: true });
    const info = await stat(resolved.absolutePath);
    if (!info.isFile()) throw new AppError({ code: 'PATH_INVALID', message: 'Preview path must refer to a file.', httpStatus: 400, expose: true });
    if (info.size > MAX_STATIC_ASSET_BYTES) throw new AppError({ code: 'FILE_TOO_LARGE', message: 'Preview asset exceeds 8 MiB.', httpStatus: 413, expose: true });
    const body = await readFile(resolved.absolutePath);
    res.writeHead(200, {
      'content-type': mimeType(extension),
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  private async packageMetadata(resolver: ProjectPathResolver): Promise<PackageMetadata | null> {
    try {
      const resolved = await resolver.resolveExisting('package.json');
      const info = await stat(resolved.absolutePath);
      if (!info.isFile() || info.size > 256 * 1024) return null;
      const parsed = packageJsonSchema.safeParse(JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as unknown);
      if (!parsed.success) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      return {
        manager: packageManagerFrom(parsed.data.packageManager),
        scripts: parsed.data.scripts ?? {},
        dependencies: { ...(parsed.data.dependencies ?? {}), ...(parsed.data.devDependencies ?? {}) },
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (error instanceof SyntaxError) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json contains invalid JSON.', httpStatus: 400, expose: true, cause: error });
      throw error;
    }
  }

  private async exists(resolver: ProjectPathResolver, relativePath: string): Promise<boolean> {
    try { await resolver.resolveExisting(relativePath); return true; }
    catch (error) { if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false; throw error; }
  }
}
