import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capabilitySchema, type Capability } from './capability.js';

const principalIdSchema = z.string().trim().min(1).max(160);
const noteSchema = z.string().trim().max(500).nullable();

export interface PermissionSession {
  id: string;
  projectId: string;
  principalId: string;
  capabilities: Capability[];
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  note: string | null;
}

export interface CreatePermissionSessionInput {
  projectId: string;
  principalId: string;
  capabilities: readonly Capability[];
  ttlSeconds: number;
  note?: string | null;
}

export function createPermissionSession(
  input: CreatePermissionSessionInput,
  options: { id?: string; now?: Date } = {},
): PermissionSession {
  const now = options.now ?? new Date();
  const ttlSeconds = z.number().int().min(60).max(86_400).parse(input.ttlSeconds);
  const capabilities = [...new Set(z.array(capabilitySchema).min(1).parse(input.capabilities))];
  return {
    id: options.id ?? randomUUID(),
    projectId: z.string().uuid().parse(input.projectId),
    principalId: principalIdSchema.parse(input.principalId),
    capabilities,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    revokedAt: null,
    note: noteSchema.parse(input.note ?? null),
  };
}

export function isPermissionSessionActive(session: PermissionSession, now: Date = new Date()): boolean {
  return session.revokedAt === null && Date.parse(session.expiresAt) > now.getTime();
}
