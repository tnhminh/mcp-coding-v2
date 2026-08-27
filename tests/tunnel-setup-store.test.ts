import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { TunnelSetupStore, type SecretProtector } from '../src/app/tunnel-setup-store.js';

class FakeProtector implements SecretProtector {
  readonly provider = 'fake-test-protector';
  readonly available = true;
  protect(secret: string): Promise<string> { return Promise.resolve(Buffer.from(`protected:${secret}`, 'utf8').toString('base64')); }
  unprotect(payload: string): Promise<string> {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    if (!decoded.startsWith('protected:')) return Promise.reject(new Error('invalid payload'));
    return Promise.resolve(decoded.slice('protected:'.length));
  }
}

describe('persistent tunnel setup store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('persists non-secret tunnel settings and only encrypted API-key payload', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-tunnel-setup-'));
    roots.push(root);
    const store = new TunnelSetupStore(root, new FakeProtector());
    const secret = 'sk-runtime-super-secret-value';
    const snapshot = await store.configure({
      tunnelId: 'tunnel_abcdefgh12345678',
      runtimeApiKey: secret,
      autoConnect: true,
    });

    expect(snapshot).toMatchObject({
      tunnelId: 'tunnel_abcdefgh12345678',
      tunnelIdConfigured: true,
      runtimeApiKeyConfigured: true,
      autoConnect: true,
      secretProvider: 'fake-test-protector',
      secretProviderAvailable: true,
    });
    expect(await store.runtimeApiKey()).toBe(secret);

    const settings = await readFile(path.join(root, 'tunnel', 'setup.json'), 'utf8');
    const encrypted = await readFile(path.join(root, 'tunnel', 'runtime-api-key.dpapi'), 'utf8');
    expect(settings).toContain('tunnel_abcdefgh12345678');
    expect(settings).not.toContain(secret);
    expect(encrypted).not.toContain(secret);
  });

  test('preserves encrypted key when settings change and can clear it explicitly', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-tunnel-setup-'));
    roots.push(root);
    const store = new TunnelSetupStore(root, new FakeProtector());
    await store.configure({ tunnelId: 'tunnel_abcdefgh12345678', runtimeApiKey: 'sk-test-123456789', autoConnect: false });
    expect((await store.setAutoConnect(true)).runtimeApiKeyConfigured).toBe(true);
    expect((await store.configure({ tunnelId: 'tunnel_zzzzzzzz12345678', autoConnect: true })).runtimeApiKeyConfigured).toBe(true);
    expect(await store.runtimeApiKey()).toBe('sk-test-123456789');
    expect((await store.clearRuntimeApiKey()).runtimeApiKeyConfigured).toBe(false);
    expect(await store.runtimeApiKey()).toBeNull();
  });
});
