import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WindowsAutoStartService } from '../src/app/windows-autostart-service.js';
import type { SafeProcessResult } from '../src/app/safe-process-runner.js';

function result(success = true): SafeProcessResult {
  return { executable: 'reg.exe', args: [], success, exitCode: success ? 0 : 1, signal: null, stdout: '', stderr: '', durationMs: 1, timedOut: false, cancelled: false, outputTruncated: false };
}

describe('Windows auto-start service', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  test('creates a secret-free per-user launcher and registry command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-autostart-'));
    roots.push(root);
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    let enabled = false;
    const service = new WindowsAutoStartService({
      projectRoot: root,
      runtimeRoot: root,
      host: '127.0.0.1',
      port: 7317,
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      commandRunner: (spec) => {
        calls.push({ executable: spec.executable, args: spec.args });
        if (spec.args[0] === 'query') return Promise.resolve(result(enabled));
        if (spec.args[0] === 'add') { enabled = true; return Promise.resolve(result(true)); }
        if (spec.args[0] === 'delete') { enabled = false; return Promise.resolve(result(true)); }
        return Promise.resolve(result(false));
      },
    });

    if (process.platform !== 'win32') {
      expect((await service.status()).supported).toBe(false);
      return;
    }

    expect((await service.status()).enabled).toBe(false);
    expect((await service.enable()).enabled).toBe(true);
    const launcher = await readFile(path.join(root, 'tunnel', 'autostart.ps1'), 'utf8');
    expect(launcher).toContain('dist/entrypoints/http.js');
    expect(launcher).toContain('127.0.0.1:7317/health/ready');
    expect(launcher).not.toContain('CONTROL_PLANE_API_KEY');
    expect(launcher).not.toContain('sk-');
    expect(JSON.stringify(calls)).not.toContain('CONTROL_PLANE_API_KEY');
    expect((await service.disable()).enabled).toBe(false);
  });
});
