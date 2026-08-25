import { describe, expect, it } from 'vitest';
import { HealthService } from '../src/app/health-service.js';

describe('HealthService', () => {
  it('returns deterministic machine-readable health data', () => {
    const now = new Date('2026-08-25T12:00:00.000Z');
    expect(new HealthService().snapshot(now)).toEqual({
      service: 'mcp-coding-v2',
      version: '0.1.0',
      status: 'ok',
      timestamp: '2026-08-25T12:00:00.000Z',
    });
  });
});
