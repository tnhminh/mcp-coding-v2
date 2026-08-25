import { z } from 'zod';
import { AppError } from './errors.js';

const loopbackHostSchema = z.enum(['127.0.0.1', '::1', 'localhost']);
const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

const configSchema = z.object({
  MCP_HOST: loopbackHostSchema.default('127.0.0.1'),
  MCP_PORT: z.coerce.number().int().min(1).max(65_535).default(7317),
  LOG_LEVEL: logLevelSchema.default('info'),
  MCP_DATABASE_PATH: z.string().trim().min(1).max(4096).default('.runtime/mcp-coding-v2.sqlite'),
});

export type LogLevel = z.infer<typeof logLevelSchema>;

export interface AppConfig {
  host: z.infer<typeof loopbackHostSchema>;
  port: number;
  logLevel: LogLevel;
  databasePath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse({
    MCP_HOST: env.MCP_HOST,
    MCP_PORT: env.MCP_PORT,
    LOG_LEVEL: env.LOG_LEVEL,
    MCP_DATABASE_PATH: env.MCP_DATABASE_PATH,
  });

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'configuration'))];
    throw new AppError({
      code: 'CONFIG_INVALID',
      message: `Invalid configuration fields: ${fields.join(', ')}`,
      httpStatus: 500,
      expose: true,
      cause: result.error,
    });
  }

  return {
    host: result.data.MCP_HOST,
    port: result.data.MCP_PORT,
    logLevel: result.data.LOG_LEVEL,
    databasePath: result.data.MCP_DATABASE_PATH,
  };
}
