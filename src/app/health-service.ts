export interface HealthSnapshot {
  service: string;
  version: string;
  status: 'ok';
  timestamp: string;
}

export class HealthService {
  constructor(
    private readonly service = 'mcp-coding-v2',
    private readonly version = '0.1.0',
  ) {}

  snapshot(now = new Date()): HealthSnapshot {
    return {
      service: this.service,
      version: this.version,
      status: 'ok',
      timestamp: now.toISOString(),
    };
  }
}
