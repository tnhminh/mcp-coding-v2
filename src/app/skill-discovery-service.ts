import path from 'node:path';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { SecureFilesystemService } from './secure-filesystem-service.js';

export interface SkillDescriptor {
  id: string;
  path: string;
  name: string;
  kind: 'agents' | 'skill' | 'prompt' | 'rule';
}

const MAX_SKILL_BYTES = 256 * 1024;

function normalize(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function classify(relativePath: string): SkillDescriptor | null {
  const normalized = normalize(relativePath);
  const lower = normalized.toLowerCase();
  if (lower === 'agents.md') return { id: normalized, path: relativePath, name: 'Project instructions', kind: 'agents' };
  if (lower === 'skill.md') return { id: normalized, path: relativePath, name: 'Project skill', kind: 'skill' };
  if (/^(\.agents|\.claude|\.mcp)\/skills\/.+\/skill\.md$/u.test(lower)) {
    return { id: normalized, path: relativePath, name: path.basename(path.dirname(relativePath)), kind: 'skill' };
  }
  if (/^\.github\/prompts\/.+\.prompt\.md$/u.test(lower)) {
    return { id: normalized, path: relativePath, name: path.basename(relativePath, '.prompt.md'), kind: 'prompt' };
  }
  if (/^\.cursor\/rules\/.+\.mdc$/u.test(lower)) {
    return { id: normalized, path: relativePath, name: path.basename(relativePath, '.mdc'), kind: 'rule' };
  }
  return null;
}

export class SkillDiscoveryService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly filesystem: SecureFilesystemService,
  ) {}

  async listSkills(request: { projectId: string; permissionSessionId: string }): Promise<SkillDescriptor[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const entries = await this.filesystem.listFiles({ ...request, path: '.', depth: 4, maxEntries: 500 });
    return entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => classify(entry.path))
      .filter((entry): entry is SkillDescriptor => entry !== null)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readSkill(request: { projectId: string; permissionSessionId: string; path: string }): Promise<SkillDescriptor & { content: string; sha256: string; bytes: number }> {
    const skills = await this.listSkills(request);
    const normalizedRequested = normalize(request.path);
    const descriptor = skills.find((skill) => normalize(skill.path) === normalizedRequested);
    if (!descriptor) {
      throw new AppError({ code: 'VALIDATION_ERROR', message: 'Requested path is not a recognized project skill/instruction file.', httpStatus: 400, expose: true });
    }
    const file = await this.filesystem.readTextFile({ ...request, path: descriptor.path });
    if (file.bytes > MAX_SKILL_BYTES) {
      throw new AppError({ code: 'FILE_TOO_LARGE', message: 'Skill/instruction file exceeds the 256 KiB limit.', httpStatus: 413, expose: true });
    }
    return { ...descriptor, content: file.content, sha256: file.sha256, bytes: file.bytes };
  }
}
