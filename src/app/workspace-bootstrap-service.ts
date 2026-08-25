import { mcpToolCatalog } from './mcp-tool-catalog.js';
import { ProjectDiscoveryService } from './project-discovery-service.js';
import { SkillDiscoveryService } from './skill-discovery-service.js';
import { TaskRunnerService } from './task-runner-service.js';

export class WorkspaceBootstrapService {
  constructor(
    private readonly projects: ProjectDiscoveryService,
    private readonly tasks: TaskRunnerService,
    private readonly skills: SkillDiscoveryService,
  ) {}

  async bootstrap(request: { projectId: string; permissionSessionId: string }): Promise<Record<string, unknown>> {
    const [project, taskProfiles, skills] = await Promise.all([
      this.projects.projectInfo(request.projectId),
      this.tasks.listTaskProfiles(request),
      this.skills.listSkills(request),
    ]);
    return {
      project,
      tools: mcpToolCatalog,
      taskProfiles,
      skills,
      authorization: {
        permissionSessionRequiredForPrivilegedTools: true,
        readCapability: 'filesystem.read',
        writeCapability: 'filesystem.write',
        commandCapability: 'command.run',
      },
    };
  }
}
