import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HealthService } from './health-service.js';

export function createMcpServer(): McpServer {
  const health = new HealthService();
  const server = new McpServer(
    { name: 'mcp-coding-v2', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    'system_health',
    {
      title: 'System health',
      description: 'Return a minimal non-sensitive health snapshot for the MCP control plane.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        service: z.string(),
        version: z.string(),
        status: z.literal('ok'),
        timestamp: z.string(),
      }),
      annotations: { readOnlyHint: true },
    },
    () => {
      const output = health.snapshot();
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  return server;
}
