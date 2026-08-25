import type { Capability } from '../domain/authorization/capability.js';
import type { PermissionSessionRepository } from '../domain/authorization/permission-session-repository.js';
import { isPermissionSessionActive, type PermissionSession } from '../domain/authorization/permission-session.js';
import type { PolicyRepository } from '../domain/authorization/policy-repository.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';
import { AppError } from './errors.js';

export interface AuthorizationRequest {
  projectId: string;
  permissionSessionId: string;
  capability: Capability;
  now?: Date;
}

export class AuthorizationService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: PermissionSessionRepository,
    private readonly policies: PolicyRepository,
  ) {}

  async authorize(request: AuthorizationRequest): Promise<PermissionSession> {
    const project = await this.projects.findById(request.projectId);
    if (!project || project.status !== 'active') {
      throw new AppError({ code: 'AUTHORIZATION_DENIED', message: 'Project is unavailable for privileged operations.', httpStatus: 403, expose: true });
    }

    const session = await this.sessions.findById(request.permissionSessionId);
    if (!session || session.projectId !== request.projectId) {
      throw new AppError({ code: 'PERMISSION_REQUIRED', message: 'A valid project permission session is required.', httpStatus: 403, expose: true });
    }
    if (!isPermissionSessionActive(session, request.now ?? new Date())) {
      throw new AppError({ code: 'PERMISSION_EXPIRED', message: 'Permission session is expired or revoked.', httpStatus: 403, expose: true });
    }
    if (!session.capabilities.includes(request.capability)) {
      throw new AppError({ code: 'AUTHORIZATION_DENIED', message: `Permission session does not grant ${request.capability}.`, httpStatus: 403, expose: true });
    }

    const policies = await this.policies.listApplicable(request.projectId);
    const denied = policies.find((policy) => policy.capability === request.capability && policy.effect === 'deny');
    if (denied) {
      throw new AppError({ code: 'POLICY_DENIED', message: `Operation denied by policy: ${denied.name}.`, httpStatus: 403, expose: true });
    }
    return session;
  }
}
