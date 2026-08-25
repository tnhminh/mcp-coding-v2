import type { AuthorizationPolicy } from './policy.js';

export interface PolicyRepository {
  save(policy: AuthorizationPolicy): Promise<void>;
  findById(id: string): Promise<AuthorizationPolicy | null>;
  list(): Promise<AuthorizationPolicy[]>;
  listApplicable(projectId: string): Promise<AuthorizationPolicy[]>;
  remove(id: string): Promise<boolean>;
}
