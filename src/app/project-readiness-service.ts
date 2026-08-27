import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { CommandRecipeService, type CommandRecipeId, type CommandRecipeResult } from './command-recipe-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { TaskRunnerService, type TaskKind, type TaskRunResult } from './task-runner-service.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

const packageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).passthrough();

export type ReadinessIssueKind = 'missing_dependencies' | 'configuration_required';

export interface ProjectReadinessIssue {
  kind: ReadinessIssueKind;
  blocking: boolean;
  task?: TaskKind;
  message: string;
  recovery: string;
}

export interface ProjectReadinessSnapshot {
  projectId: string;
  packageManager: string | null;
  dependencyState: 'ready' | 'missing' | 'not_required' | 'not_applicable';
  lockfileState: 'present' | 'missing' | 'not_applicable';
  readyForCoding: boolean;
  readyForVerification: boolean;
  issues: ProjectReadinessIssue[];
  availableTaskIds: TaskKind[];
  recommendedPreparation: Array<
    | { kind: 'run_recipe'; recipe: CommandRecipeId; reason: string; automatic: boolean }
    | { kind: 'configure_task'; task: TaskKind; reason: string }
  >;
}

export interface PrepareWorkspaceResult {
  before: ProjectReadinessSnapshot;
  actions: Array<{ kind: 'run_recipe'; recipe: CommandRecipeId; result: CommandRecipeResult }>;
  after: ProjectReadinessSnapshot;
  baseline: TaskRunResult[];
  baselineReady: boolean;
}

export class ProjectReadinessService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
    private readonly tasks: TaskRunnerService,
    private readonly commandRecipes: CommandRecipeService,
  ) {}

  async inspect(request: { projectId: string; permissionSessionId?: string }): Promise<ProjectReadinessSnapshot> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const [profiles, recipes, packageJson] = await Promise.all([
      this.tasks.listTaskProfiles(request),
      this.commandRecipes.listRecipes(request),
      this.readPackageJson(resolver),
    ]);

    const issues: ProjectReadinessIssue[] = [];
    const recommendedPreparation: ProjectReadinessSnapshot['recommendedPreparation'] = [];
    const packageInstall = recipes.find((recipe) => recipe.id === 'package.install');
    const packageManager = packageInstall?.manager ?? null;

    let dependencyState: ProjectReadinessSnapshot['dependencyState'] = 'not_applicable';
    let lockfileState: ProjectReadinessSnapshot['lockfileState'] = 'not_applicable';

    if (packageJson) {
      const dependencyCount = Object.keys(packageJson.dependencies ?? {}).length + Object.keys(packageJson.devDependencies ?? {}).length;
      const dependencyArtifactsPresent = await this.exists(resolver, 'node_modules') || await this.exists(resolver, '.pnp.cjs');
      dependencyState = dependencyCount === 0 ? 'not_required' : dependencyArtifactsPresent ? 'ready' : 'missing';
      lockfileState = await this.hasLockfile(resolver, packageManager) ? 'present' : 'missing';
      if (dependencyState === 'missing') {
        issues.push({
          kind: 'missing_dependencies',
          blocking: true,
          message: 'Project dependencies are declared but dependency artifacts are missing.',
          recovery: 'Run the structured package.install recipe before verification or code mutation.',
        });
        recommendedPreparation.push({
          kind: 'run_recipe',
          recipe: 'package.install',
          reason: 'Install declared project dependencies before running package scripts.',
          automatic: true,
        });
      }

      const lintProfile = profiles.find((profile) => profile.id === 'lint' && profile.source === 'package.json');
      const lintScriptName = lintProfile?.script;
      const lintScript = lintScriptName ? packageJson.scripts?.[lintScriptName] ?? '' : '';
      if (/\bnext\s+lint\b/iu.test(lintScript) && !(await this.hasEslintConfiguration(resolver))) {
        issues.push({
          kind: 'configuration_required',
          blocking: false,
          task: 'lint',
          message: 'The Next.js lint script is interactive because no ESLint configuration exists.',
          recovery: 'Configure ESLint for non-interactive CLI use and update the lint script before treating lint failure as a source-code regression.',
        });
        recommendedPreparation.push({
          kind: 'configure_task',
          task: 'lint',
          reason: 'Next.js lint requires one-time ESLint configuration before autonomous non-interactive verification.',
        });
      }
    }

    const nonNodePreparations: Array<{ recipe: CommandRecipeId; reason: string; automatic: boolean }> = [
      { recipe: 'go.mod_download', reason: 'Warm and validate Go module dependencies before verification.', automatic: true },
      { recipe: 'cargo.fetch', reason: 'Fetch declared Rust dependencies before verification.', automatic: true },
      { recipe: 'dotnet.restore', reason: 'Restore .NET dependencies before verification.', automatic: true },
      { recipe: 'python.install_requirements', reason: 'Install Python requirements into the project virtual environment before verification.', automatic: await this.exists(resolver, '.venv') },
    ];
    for (const preparation of nonNodePreparations) {
      const descriptor = recipes.find((recipe) => recipe.id === preparation.recipe);
      if (!descriptor?.available) continue;
      recommendedPreparation.push({ kind: 'run_recipe', ...preparation });
    }

    return {
      projectId: request.projectId,
      packageManager,
      dependencyState,
      lockfileState,
      readyForCoding: !issues.some((issue) => issue.blocking),
      readyForVerification: issues.length === 0,
      issues,
      availableTaskIds: profiles.map((profile) => profile.id),
      recommendedPreparation,
    };
  }

  async prepare(request: {
    projectId: string;
    permissionSessionId?: string;
    baselineTasks?: readonly TaskKind[];
    runBaseline?: boolean;
  }): Promise<PrepareWorkspaceResult> {
    const session = await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
    });
    const base = { projectId: request.projectId, permissionSessionId: session.id };
    const before = await this.inspect(base);
    const actions: PrepareWorkspaceResult['actions'] = [];

    for (const preparation of before.recommendedPreparation) {
      if (preparation.kind !== 'run_recipe' || !preparation.automatic) continue;
      const result = await this.commandRecipes.runRecipe({ ...base, recipe: preparation.recipe });
      actions.push({ kind: 'run_recipe', recipe: preparation.recipe, result });
      if (!result.success) {
        const afterFailedInstall = await this.inspect(base);
        return { before, actions, after: afterFailedInstall, baseline: [], baselineReady: false };
      }
    }

    const after = await this.inspect(base);
    const baseline: TaskRunResult[] = [];
    if (request.runBaseline !== false) {
      const available = new Set(after.availableTaskIds);
      const requested = request.baselineTasks?.length
        ? [...new Set(request.baselineTasks)]
        : (['lint', 'typecheck', 'test', 'check'] as const).filter((task) => available.has(task));
      for (const task of requested) {
        if (!available.has(task)) continue;
        baseline.push(await this.tasks.runTask({ ...base, task }));
      }
    }

    return {
      before,
      actions,
      after,
      baseline,
      baselineReady: after.readyForVerification && baseline.every((result) => result.success),
    };
  }

  private async readPackageJson(resolver: ProjectPathResolver): Promise<z.infer<typeof packageJsonSchema> | null> {
    try {
      const resolved = await resolver.resolveExisting('package.json');
      const info = await stat(resolved.absolutePath);
      if (!info.isFile() || info.size > 256 * 1024) return null;
      const parsed = packageJsonSchema.safeParse(JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as unknown);
      if (!parsed.success) {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json readiness metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (error instanceof SyntaxError) {
        throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json contains invalid JSON.', httpStatus: 400, expose: true, cause: error });
      }
      throw error;
    }
  }

  private async hasLockfile(resolver: ProjectPathResolver, manager: string | null): Promise<boolean> {
    if (manager === 'pnpm') return this.exists(resolver, 'pnpm-lock.yaml');
    if (manager === 'yarn') return this.exists(resolver, 'yarn.lock');
    if (manager === 'bun') return (await this.exists(resolver, 'bun.lock')) || (await this.exists(resolver, 'bun.lockb'));
    return this.exists(resolver, 'package-lock.json');
  }

  private async hasEslintConfiguration(resolver: ProjectPathResolver): Promise<boolean> {
    for (const candidate of ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs']) {
      if (await this.exists(resolver, candidate)) return true;
    }
    return false;
  }

  private async exists(resolver: ProjectPathResolver, relativePath: string): Promise<boolean> {
    try {
      await resolver.resolveExisting(relativePath);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false;
      throw error;
    }
  }
}
