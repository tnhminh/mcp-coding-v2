import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { capabilitySchema, type Capability } from './capability.js';

export const policyEffectSchema = z.enum(['allow', 'deny']);
export type PolicyEffect = z.infer<typeof policyEffectSchema>;

export interface AuthorizationPolicy {
  id: string;
  name: string;
  projectId: string | null;
  capability: Capability;
  effect: PolicyEffect;
  enabled: boolean;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAuthorizationPolicyInput {
  name: string;
  projectId?: string | null;
  capability: Capability;
  effect: PolicyEffect;
  enabled?: boolean;
  reason?: string | null;
}

export function createAuthorizationPolicy(
  input: CreateAuthorizationPolicyInput,
  options: { id?: string; now?: Date } = {},
): AuthorizationPolicy {
  const now = (options.now ?? new Date()).toISOString();
  return {
    id: options.id ?? randomUUID(),
    name: z.string().trim().min(1).max(160).parse(input.name),
    projectId: input.projectId == null ? null : z.string().uuid().parse(input.projectId),
    capability: capabilitySchema.parse(input.capability),
    effect: policyEffectSchema.parse(input.effect),
    enabled: z.boolean().parse(input.enabled ?? true),
    reason: z.string().trim().max(500).nullable().parse(input.reason ?? null),
    createdAt: now,
    updatedAt: now,
  };
}
