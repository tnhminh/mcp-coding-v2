import { createServer as createNetServer } from 'node:net';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/app/config.js';
import { AppError, toPublicError } from '../src/app/errors.js';
import { JsonLogger } from '../src/infra/json-logger.js';
import { startHttpRuntime } from '../src/runtime/http-runtime.js';

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to reserve test port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

describe('runtime foundation', () => {
  test('configuration has secure loopback defaults and validates unsafe values', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 7317,
      logLevel: 'info',
      databasePath: '.runtime/mcp-coding-v2.sqlite',
    });
    expect(() => loadConfig({ MCP_HOST: '0.0.0.0' })).toThrowError(AppError);
    expect(() => loadConfig({ MCP_PORT: '70000' })).toThrowError(AppError);
    expect(() => loadConfig({ LOG_LEVEL: 'verbose' })).toThrowError(AppError);
  });

  test('public error projection exposes only explicitly safe messages', () => {
    const safe = toPublicError(
      new AppError({ code: 'NOT_FOUND', message: 'Missing route', httpStatus: 404, expose: true }),
    );
    expect(safe).toEqual({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Missing route' } } });

    const hidden = toPublicError(new Error('database password leaked here'));
    expect(hidden.body.error.message).toBe('An internal error occurred.');
    expect(JSON.stringify(hidden)).not.toContain('password leaked');
  });

  test('JSON logger emits structured lines and redacts sensitive fields', () => {
    const lines: string[] = [];
    const logger = new JsonLogger('debug', (line) => lines.push(line));
    logger.info('test_event', 'hello', {
      project: 'demo',
      token: 'should-not-appear',
      nested: { password: 'also-hidden' },
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('test_event');
    expect(JSON.stringify(parsed)).not.toContain('should-not-appear');
    expect(JSON.stringify(parsed)).not.toContain('also-hidden');
    expect(JSON.stringify(parsed)).toContain('[REDACTED]');
    expect(parsed.service).toBe('mcp-coding-v2');

    logger.error('secret_error', new Error('token=must-not-leak'));
    expect(lines[1]).not.toContain('must-not-leak');
  });

  test('HTTP runtime starts, serves health, and closes idempotently', async () => {
    const port = await reservePort();
    const logger = new JsonLogger('error', () => undefined);
    const runtime = await startHttpRuntime(
      { host: '127.0.0.1', port, logLevel: 'error', databasePath: ':memory:' },
      logger,
    );

    const response = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(response.status).toBe(200);

    await runtime.close();
    await runtime.close();
    await expect(fetch(`http://127.0.0.1:${port}/health/ready`)).rejects.toThrow();
  });
});
