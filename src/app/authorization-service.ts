import { allCapabilities, type Capability } from '../domain/authorization/capability.js';
import type { PermissionSessionRepository } from '../domain/authorization/permission-session-repository.js';
import { isPermissionSessionActive, type PermissionSession } from '../domain/authorization/permission-session.js';
import type { PolicyRepository } from '../domain/authorization/policy-repository.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';
import { AppError } from './errors.js';

export interface AuthorizationRequest {
  projectId: string;
  permissionSessionId?: string;
  capability: Capability;
  now?: Date;
}

export interface ResolvePermissionSessionRequest {
  projectId: string;
  permissionSessionId?: string;
  capabilities: readonly Capability[];
  now?: Date;
}

export interface CapabilityAccessStatus {
  capability: Capability;
  state: 'granted' | 'missing' | 'ambiguous' | 'policy_denied' | 'project_unavailable' | 'session_invalid';
  usable: boolean;
  reason: string;
}

export interface ProjectAccessSnapshot {
  projectId: string;
  projectActive: boolean;
  resolution: 'explicit' | 'automatic' | 'missing' | 'ambiguous' | 'invalid';
  capabilities: CapabilityAccessStatus[];
  codingEnvelope: {
    required: readonly Capability[];
    usable: boolean;
    state: 'granted' | 'missing' | 'ambiguous' | 'policy_denied' | 'project_unavailable' | 'session_invalid';
  };
}

function dominantSession(candidates: readonly PermissionSession[]): PermissionSession | undefined {
  if (candidates.length === 0) return undefined;
  const principals = new Set(candidates.map((session) => session.principalId));
  if (principals.size !== 1) return undefined;
  const dominant = candidates.filter((candidate) =>
    candidates.every((other) => other.capabilities.every((capability) => candidate.capabilities.includes(capability)))
  );
  return [...dominant].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

export class AuthorizationService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: PermissionSessionRepository,
    private readonly policies: PolicyRepository,
  ) {}

  async authorize(request: AuthorizationRequest): Promise<PermissionSession> {
    return this.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: [request.capability],
      ...(request.now === undefined ? {} : { now: request.now }),
    });
  }

  async inspectAccess(request: { projectId: string; permissionSessionId?: string; now?: Date }): Promise<ProjectAccessSnapshot> {
    const project = await this.projects.findById(request.projectId);
    const codingRequired = ['filesystem.read', 'filesystem.write', 'command.run'] as const satisfies readonly Capability[];
    if (!project || project.status !== 'active') {
      return {
        projectId: request.projectId,
        projectActive: false,
        resolution: 'invalid',
        capabilities: allCapabilities.map((capability) => ({
          capability,
          state: 'project_unavailable',
          usable: false,
          reason: 'Project is unavailable for privileged operations.',
        })),
        codingEnvelope: { required: codingRequired, usable: false, state: 'project_unavailable' },
      };
    }

    const now = request.now ?? new Date();
    const policies = await this.policies.listApplicable(request.projectId);
    const deniedCapabilities = new Set(policies.filter((policy) => policy.effect === 'deny').map((policy) => policy.capability));
    const activeSessions = (await this.sessions.listByProject(request.projectId)).filter((session) => isPermissionSessionActive(session, now));

    let explicit: PermissionSession | null = null;
    let explicitInvalid = false;
    if (request.permissionSessionId) {
      explicit = await this.sessions.findById(request.permissionSessionId);
      explicitInvalid = !explicit || explicit.projectId !== request.projectId || !isPermissionSessionActive(explicit, now);
    }

    const accessFor = (capability: Capability): CapabilityAccessStatus => {
      if (deniedCapabilities.has(capability)) {
        return { capability, state: 'policy_denied', usable: false, reason: 'An enabled authorization policy denies this capability.' };
      }
      if (request.permissionSessionId) {
        if (explicitInvalid || !explicit) return { capability, state: 'session_invalid', usable: false, reason: 'The supplied permission session is invalid, expired, revoked, or belongs to another project.' };
        if (!explicit.capabilities.includes(capability)) return { capability, state: 'missing', usable: false, reason: 'The supplied permission session does not grant this capability.' };
        return { capability, state: 'granted', usable: true, reason: 'Granted by the supplied active project permission session.' };
      }
      const candidates = activeSessions.filter((session) => session.capabilities.includes(capability));
      if (candidates.length === 0) return { capability, state: 'missing', usable: false, reason: 'No active permission session grants this capability.' };
      const dominant = dominantSession(candidates);
      if (!dominant) return { capability, state: 'ambiguous', usable: false, reason: 'Multiple principals or incomparable active authorization envelopes grant this capability; an explicit permission session is required.' };
      return { capability, state: 'granted', usable: true, reason: 'A deterministic same-principal dominant authorization envelope grants this capability.' };
    };

    const capabilities = allCapabilities.map(accessFor);
    const codingDenied = codingRequired.find((capability) => deniedCapabilities.has(capability));
    let codingState: ProjectAccessSnapshot['codingEnvelope']['state'];
    let codingUsable = false;
    if (codingDenied) {
      codingState = 'policy_denied';
    } else if (request.permissionSessionId) {
      if (explicitInvalid || !explicit) codingState = 'session_invalid';
      else if (codingRequired.every((capability) => explicit.capabilities.includes(capability))) {
        codingState = 'granted';
        codingUsable = true;
      } else codingState = 'missing';
    } else {
      const codingCandidates = activeSessions.filter((session) => codingRequired.every((capability) => session.capabilities.includes(capability)));
      if (codingCandidates.length === 0) codingState = 'missing';
      else if (!dominantSession(codingCandidates)) codingState = 'ambiguous';
      else {
        codingState = 'granted';
        codingUsable = true;
      }
    }

    const resolution: ProjectAccessSnapshot['resolution'] = request.permissionSessionId
      ? (explicitInvalid ? 'invalid' : 'explicit')
      : codingState === 'ambiguous'
        ? 'ambiguous'
        : codingState === 'missing'
          ? 'missing'
          : 'automatic';

    return {
      projectId: request.projectId,
      projectActive: true,
      resolution,
      capabilities,
      codingEnvelope: { required: codingRequired, usable: codingUsable, state: codingState },
    };
  }

  async resolvePermissionSession(request: ResolvePermissionSessionRequest): Promise<PermissionSession> {
    const project = await this.projects.findById(request.projectId);
    if (!project || project.status !== 'active') {
      throw new AppError({ code: 'AUTHORIZATION_DENIED', message: 'Project is unavailable for privileged operations.', httpStatus: 403, expose: true });
    }

    const now = request.now ?? new Date();
    const requiredCapabilities = [...new Set(request.capabilities)];
    if (requiredCapabilities.length === 0) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'At least one capability is required for authorization.', httpStatus: 400, expose: true });
    }

    let session: PermissionSession | undefined;
    if (request.permissionSessionId) {
      const explicit = await this.sessions.findById(request.permissionSessionId);
      if (!explicit || explicit.projectId !== request.projectId) {
        throw new AppError({ code: 'PERMISSION_REQUIRED', message: 'A valid project permission session is required.', httpStatus: 403, expose: true });
      }
      if (!isPermissionSessionActive(explicit, now)) {
        throw new AppError({ code: 'PERMISSION_EXPIRED', message: 'Permission session is expired or revoked.', httpStatus: 403, expose: true });
      }
      session = explicit;
    } else {
      const candidates = (await this.sessions.listByProject(request.projectId))
        .filter((candidate) => isPermissionSessionActive(candidate, now))
        .filter((candidate) => requiredCapabilities.every((capability) => candidate.capabilities.includes(capability)))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

      if (candidates.length === 0) {
        throw new AppError({
          code: 'PERMISSION_REQUIRED',
          message: 'No active project permission session grants the required capability set.',
          httpStatus: 403,
          expose: true,
        });
      }

      session = dominantSession(candidates);
      if (!session) {
        throw new AppError({
          code: 'PERMISSION_REQUIRED',
          message: 'Multiple principals or incomparable active permission sessions are available; permission_session_id is required.',
          httpStatus: 403,
          expose: true,
        });
      }
    }

    if (!session) {
      throw new AppError({ code: 'PERMISSION_REQUIRED', message: 'A valid project permission session is required.', httpStatus: 403, expose: true });
    }
    const missingCapability = requiredCapabilities.find((capability) => !session.capabilities.includes(capability));
    if (missingCapability) {
      throw new AppError({ code: 'AUTHORIZATION_DENIED', message: `Permission session does not grant ${missingCapability}.`, httpStatus: 403, expose: true });
    }

    const policies = await this.policies.listApplicable(request.projectId);
    const denied = policies.find((policy) => requiredCapabilities.includes(policy.capability) && policy.effect === 'deny');
    if (denied) {
      throw new AppError({ code: 'POLICY_DENIED', message: `Operation denied by policy: ${denied.name}.`, httpStatus: 403, expose: true });
    }
    return session;
  }
}
