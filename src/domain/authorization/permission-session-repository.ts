import type { PermissionSession } from './permission-session.js';

export interface PermissionSessionRepository {
  save(session: PermissionSession): Promise<void>;
  findById(id: string): Promise<PermissionSession | null>;
  listByProject(projectId: string): Promise<PermissionSession[]>;
  revoke(id: string, revokedAt: string): Promise<boolean>;
}
