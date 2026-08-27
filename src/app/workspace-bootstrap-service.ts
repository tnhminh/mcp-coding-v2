import { AuthorizationService } from './authorization-service.js';
import { CommandRecipeService } from './command-recipe-service.js';
import { mcpToolCatalog } from './mcp-tool-catalog.js';
import { PreviewService } from './preview-service.js';
import { ProjectDiscoveryService } from './project-discovery-service.js';
import { ProjectReadinessService } from './project-readiness-service.js';
import { SkillDiscoveryService } from './skill-discovery-service.js';
import { TaskRunnerService } from './task-runner-service.js';

export class WorkspaceBootstrapService {
  constructor(
    private readonly projects: ProjectDiscoveryService,
    private readonly authorization: AuthorizationService,
    private readonly tasks: TaskRunnerService,
    private readonly commandRecipes: CommandRecipeService,
    private readonly skills: SkillDiscoveryService,
    private readonly previews: PreviewService,
    private readonly readiness: ProjectReadinessService,
  ) {}

  async bootstrap(request: { projectId: string; permissionSessionId?: string }): Promise<Record<string, unknown>> {
    const [project, access, taskProfiles, commandRecipes, skills, previewProfiles, readiness] = await Promise.all([
      this.projects.projectInfo(request.projectId),
      this.authorization.inspectAccess(request),
      this.tasks.listTaskProfiles(request),
      this.commandRecipes.listRecipes(request),
      this.skills.listSkills(request),
      this.previews.profiles(request),
      this.readiness.inspect(request),
    ]);
    const availableTaskIds = taskProfiles.map((profile) => profile.id);
    const availablePreviewIds = previewProfiles.map((profile) => profile.id);
    const verificationPriority = ['lint', 'typecheck', 'test', 'check', 'build'] as const;
    const recommendedTaskIds = verificationPriority.filter((task) => availableTaskIds.includes(task));
    const fastTaskIds = verificationPriority.filter((task) => task !== 'build' && availableTaskIds.includes(task));
    const effectiveFastTaskIds = fastTaskIds.length > 0 ? fastTaskIds : recommendedTaskIds.slice(0, 1);
    const verificationMode = availableTaskIds.length > 0
      ? (availablePreviewIds.length > 0 ? 'tasks_then_preview' : 'tasks_only')
      : (availablePreviewIds.length > 0 ? 'preview_browser' : 'manual_review');
    const packageScriptRecipe = commandRecipes.find((recipe) => recipe.id === 'package.script');
    return {
      project,
      access,
      readiness,
      tools: mcpToolCatalog,
      taskProfiles,
      commandRecipes,
      projectScripts: {
        manager: packageScriptRecipe?.manager ?? null,
        available: packageScriptRecipe?.allowedScripts ?? [],
      },
      skills,
      previewProfiles,
      capabilityManifest: {
        version: 1,
        codingEnvelopeReady: access.codingEnvelope.usable,
        codingEnvelopeUsable: access.codingEnvelope.usable,
        availableCapabilities: access.capabilities.filter((capability) => capability.usable).map((capability) => capability.capability),
        unavailableCapabilities: access.capabilities.filter((capability) => !capability.usable).map((capability) => capability.capability),
        blockedCapabilities: access.capabilities.filter((capability) => !capability.usable).map((capability) => ({ capability: capability.capability, state: capability.state, reason: capability.reason })),
        exposedToolCount: mcpToolCatalog.length,
        discoveredSkillCount: skills.length,
        discoveredProjectScriptCount: packageScriptRecipe?.allowedScripts?.length ?? 0,
        rawShellExposed: false,
        rules: [
          'All coding capabilities are exposed through structured project-scoped tools; raw caller-controlled shell remains intentionally unavailable.',
          'When command.run plus filesystem read/write are granted, any existing safe-name package.json script may be executed through the package.script recipe.',
          'Use project_access_status before planning if access.codingEnvelope.usable is false.',
          'Use project_guidance before implementation so all recognized agent instructions/skills are loaded within a bounded context budget.',
        ],
      },
      verificationStrategy: {
        version: 2,
        mode: verificationMode,
        discovery: 'automatic + explicit override',
        availableTaskIds,
        recommendedTaskIds,
        fastTaskIds: effectiveFastTaskIds,
        releaseTaskIds: recommendedTaskIds,
        availablePreviewIds,
        canUseTaskVerification: availableTaskIds.length > 0,
        canUsePreviewBrowserVerification: availablePreviewIds.length > 0,
        rules: [
          'Task profiles are auto-discovered from package scripts and safe ecosystem conventions; .mcp/tasks.json remains the explicit override.',
          'Only run task profiles listed in taskProfiles/availableTaskIds. Never invent test, lint, build, check, typecheck or bench profiles.',
          availableTaskIds.length > 0
            ? `For normal coding verification prefer this discovered plan: ${recommendedTaskIds.join(' → ')}. Use only task IDs that are actually listed.`
            : 'No executable verification profile was discovered. Apply SHA-guarded edits directly and use preview/browser review when available.',
          taskProfiles.some((profile) => profile.source === 'builtin-static')
            ? 'For static HTML projects, built-in check validates index.html and referenced local assets. This is a real integrity check, but it must not be reported as a build or typecheck.'
            : 'Auto-discovered ecosystem profiles are executable verification evidence, not simulated PASS results.',
          availablePreviewIds.length > 0
            ? `For UI/runtime validation, start one available preview (${availablePreviewIds.join(', ')}) and run browser_review after the edit.`
            : 'No preview profile exists. Perform direct read/diff/patch review and clearly report runtime/browser verification as unavailable.',
        ],
      },
      authorization: {
        permissionSessionRequiredForPrivilegedTools: true,
        readCapability: 'filesystem.read',
        writeCapability: 'filesystem.write',
        commandCapability: 'command.run',
      },
      vibecodeWorkflow: {
        mode: 'agent-driven evidence loop',
        recommendedMaxIterations: 5,
        steps: [
          'Load project_guidance and inspect project_access_status before planning implementation.',
          'Inspect project_readiness and call prepare_workspace before the first coding cycle when dependencies/toolchain/configuration are not ready. Treat baseline failures as pre-existing evidence, not patch regressions.',
          'Use context_bundle and impact_analysis before proposing edits when the affected area is unclear.',
          'Read target files and preserve their current SHA-256 values.',
          availableTaskIds.length > 0
            ? `Call coding_cycle with the objective, bounded changes and the discovered verification plan (${effectiveFastTaskIds.join(', ')}${recommendedTaskIds.includes('build') ? '; include build before DONE/release' : ''}).`
            : 'Because no executable task profile exists, use write_file/apply_patch/batch_patch directly and rely on the documented preview/manual fallback.',
          availableTaskIds.length > 0
            ? "If nextAction is 'fix_and_retry', inspect verification evidence plus beforeReview context/impact, correct the patch and call coding_cycle with iteration + 1."
            : 'After direct edits, re-read changed files and inspect diff/SHA evidence.',
          availablePreviewIds.length > 0
            ? 'For UI/runtime work, call preview_start with an available preview profile, then browser_review; use page/console/network/screenshot evidence to decide FIX or DONE.'
            : 'If no automated verifier exists, explicitly report verification unavailable rather than claiming a test passed.',
          availableTaskIds.length > 0
            ? "If nextAction is 'review', semantically review changed code using afterReview context/impact. If clean, declare DONE; otherwise submit a corrective coding_cycle iteration."
            : 'Do not interpret VERIFICATION_UNAVAILABLE as a code failure; choose the documented fallback verification path.',
          "If nextAction is 'stop', stop automatic retries and surface the evidence for explicit review.",
        ],
      },
    };
  }
}
