import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AuthorizationService } from './authorization-service.js';
import { AppError } from './errors.js';
import { ProjectPathResolverFactory } from './project-path-resolver-factory.js';
import { runSafeProcess, type SafeProcessResult } from './safe-process-runner.js';
import type { ProjectPathResolver } from '../infra/filesystem/project-path-resolver.js';

export const commandRecipeIdSchema = z.enum([
  'package.install',
  'package.add',
  'package.add_dev',
  'package.remove',
  'package.script',
  'python.install_requirements',
  'go.mod_download',
  'go.generate',
  'cargo.fetch',
  'dotnet.restore',
]);
export type CommandRecipeId = z.infer<typeof commandRecipeIdSchema>;

const packageJsonSchema = z.object({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
}).passthrough();
const SAFE_PACKAGE_SPEC = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@[a-z0-9._~:+*=-]+)?$/iu;
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu;
const SAFE_SCRIPT_NAME = /^[a-z0-9:_-]{1,120}$/iu;

export interface CommandRecipeDescriptor {
  id: CommandRecipeId;
  description: string;
  mutatesProject: boolean;
  available: boolean;
  manager?: string;
  allowedScripts?: string[];
}

export interface CommandRecipeResult extends SafeProcessResult {
  recipe: CommandRecipeId;
}

interface PackageMetadata {
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  scripts: Record<string, string>;
}

function packageManagerFrom(value: string | undefined): PackageMetadata['manager'] {
  const declared = value?.split('@')[0]?.toLowerCase();
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  return 'npm';
}

function validatedPackages(packages: readonly string[] | undefined): string[] {
  if (!packages || packages.length < 1 || packages.length > 32) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'This recipe requires 1 to 32 registry package specs.', httpStatus: 400, expose: true });
  }
  const unique = [...new Set(packages.map((value) => value.trim()))];
  if (unique.some((value) => !SAFE_PACKAGE_SPEC.test(value))) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'Package specs must use safe registry package/version syntax.', httpStatus: 400, expose: true });
  }
  return unique;
}

function validatedPackageNames(packages: readonly string[] | undefined): string[] {
  if (!packages || packages.length < 1 || packages.length > 32) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'This recipe requires 1 to 32 package names.', httpStatus: 400, expose: true });
  }
  const unique = [...new Set(packages.map((value) => value.trim()))];
  if (unique.some((value) => !SAFE_PACKAGE_NAME.test(value))) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'Package removal accepts package names only, without versions or shell syntax.', httpStatus: 400, expose: true });
  }
  return unique;
}

function packageCommand(manager: PackageMetadata['manager'], args: readonly string[]): { executable: string; args: string[] } {
  if (process.platform !== 'win32') return { executable: manager, args: [...args] };
  if (args.some((value) => !/^[a-z0-9@._~:+*/=-]+$/iu.test(value))) {
    throw new AppError({ code: 'VALIDATION_ERROR', message: 'Windows package-manager arguments contain unsupported shell metacharacters.', httpStatus: 400, expose: true });
  }
  const shell = process.env.ComSpec ?? process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe';
  return { executable: shell, args: ['/d', '/s', '/c', `${manager}.cmd ${args.join(' ')}`] };
}

export class CommandRecipeService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly paths: ProjectPathResolverFactory,
  ) {}

  async listRecipes(request: { projectId: string; permissionSessionId?: string }): Promise<CommandRecipeDescriptor[]> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const resolver = await this.paths.forProject(request.projectId);
    const packageMetadata = await this.packageMetadata(resolver);
    const scripts = packageMetadata
      ? Object.keys(packageMetadata.scripts).filter((name) => SAFE_SCRIPT_NAME.test(name)).sort()
      : [];
    const exists = async (relativePath: string): Promise<boolean> => this.exists(resolver, relativePath);
    const hasDotnet = await this.hasRootExtension(resolver, ['.sln', '.csproj']);
    return [
      { id: 'package.install', description: 'Install dependencies from the existing lockfile/manifest.', mutatesProject: true, available: packageMetadata !== null, ...(packageMetadata ? { manager: packageMetadata.manager } : {}) },
      { id: 'package.add', description: 'Add validated registry packages as runtime dependencies.', mutatesProject: true, available: packageMetadata !== null, ...(packageMetadata ? { manager: packageMetadata.manager } : {}) },
      { id: 'package.add_dev', description: 'Add validated registry packages as development dependencies.', mutatesProject: true, available: packageMetadata !== null, ...(packageMetadata ? { manager: packageMetadata.manager } : {}) },
      { id: 'package.remove', description: 'Remove validated package names.', mutatesProject: true, available: packageMetadata !== null, ...(packageMetadata ? { manager: packageMetadata.manager } : {}) },
      { id: 'package.script', description: 'Run any existing package.json script whose name passes the structured safe-name validator. Script bodies remain project-owned code and require filesystem read/write plus command.run authorization.', mutatesProject: true, available: scripts.length > 0, ...(packageMetadata ? { manager: packageMetadata.manager } : {}), allowedScripts: scripts },
      { id: 'python.install_requirements', description: 'Install requirements.txt through python -m pip.', mutatesProject: true, available: await exists('requirements.txt') },
      { id: 'go.mod_download', description: 'Download Go module dependencies.', mutatesProject: true, available: await exists('go.mod') },
      { id: 'go.generate', description: 'Run go generate ./... inside the project.', mutatesProject: true, available: await exists('go.mod') },
      { id: 'cargo.fetch', description: 'Fetch Rust dependencies declared by Cargo.', mutatesProject: true, available: await exists('Cargo.toml') },
      { id: 'dotnet.restore', description: 'Restore .NET project dependencies.', mutatesProject: true, available: hasDotnet },
    ];
  }

  async runRecipe(request: {
    projectId: string;
    permissionSessionId?: string;
    recipe: CommandRecipeId;
    packages?: readonly string[];
    script?: string;
    timeoutSeconds?: number;
  }): Promise<CommandRecipeResult> {
    const session = await this.authorization.resolvePermissionSession({
      projectId: request.projectId,
      ...(request.permissionSessionId === undefined ? {} : { permissionSessionId: request.permissionSessionId }),
      capabilities: ['filesystem.read', 'filesystem.write', 'command.run'],
    });
    const resolver = await this.paths.forProject(request.projectId);
    const available = await this.listRecipes({ projectId: request.projectId, permissionSessionId: session.id });
    const descriptor = available.find((item) => item.id === request.recipe);
    if (!descriptor?.available) {
      throw new AppError({ code: 'NOT_FOUND', message: `Command recipe '${request.recipe}' is not available for this project.`, httpStatus: 404, expose: true });
    }

    const spec = await this.recipeSpec(resolver, request);
    const result = await runSafeProcess({
      executable: spec.executable,
      args: spec.args,
      cwd: resolver.canonicalRoot,
      timeoutSeconds: Math.min(Math.max(request.timeoutSeconds ?? 600, 1), 600),
    });
    return { recipe: request.recipe, ...result };
  }

  private async recipeSpec(
    resolver: ProjectPathResolver,
    request: { recipe: CommandRecipeId; packages?: readonly string[]; script?: string },
  ): Promise<{ executable: string; args: string[] }> {
    const packageMetadata = await this.packageMetadata(resolver);
    switch (request.recipe) {
      case 'package.install': {
        if (!packageMetadata) break;
        let args: string[];
        if (packageMetadata.manager === 'yarn') args = ['install', '--immutable'];
        else if (packageMetadata.manager === 'npm') args = await this.exists(resolver, 'package-lock.json') ? ['ci'] : ['install'];
        else if (packageMetadata.manager === 'pnpm') args = await this.exists(resolver, 'pnpm-lock.yaml') ? ['install', '--frozen-lockfile'] : ['install'];
        else args = ['install'];
        return packageCommand(packageMetadata.manager, args);
      }
      case 'package.add': {
        if (!packageMetadata) break;
        const packages = validatedPackages(request.packages);
        return packageCommand(packageMetadata.manager, packageMetadata.manager === 'npm' ? ['install', ...packages] : ['add', ...packages]);
      }
      case 'package.add_dev': {
        if (!packageMetadata) break;
        const packages = validatedPackages(request.packages);
        return packageCommand(packageMetadata.manager, packageMetadata.manager === 'npm' ? ['install', '--save-dev', ...packages] : ['add', '--dev', ...packages]);
      }
      case 'package.remove': {
        if (!packageMetadata) break;
        const packages = validatedPackageNames(request.packages);
        return packageCommand(packageMetadata.manager, packageMetadata.manager === 'npm' ? ['uninstall', ...packages] : ['remove', ...packages]);
      }
      case 'package.script': {
        if (!packageMetadata) break;
        const script = request.script?.trim() ?? '';
        if (!SAFE_SCRIPT_NAME.test(script) || !(script in packageMetadata.scripts)) {
          throw new AppError({ code: 'VALIDATION_ERROR', message: 'Script must be an existing safe-name package.json script reported by list_command_recipes.', httpStatus: 400, expose: true });
        }
        return packageCommand(packageMetadata.manager, ['run', script]);
      }
      case 'python.install_requirements': return { executable: process.platform === 'win32' ? 'python.exe' : 'python3', args: ['-m', 'pip', 'install', '-r', 'requirements.txt'] };
      case 'go.mod_download': return { executable: process.platform === 'win32' ? 'go.exe' : 'go', args: ['mod', 'download'] };
      case 'go.generate': return { executable: process.platform === 'win32' ? 'go.exe' : 'go', args: ['generate', './...'] };
      case 'cargo.fetch': return { executable: process.platform === 'win32' ? 'cargo.exe' : 'cargo', args: ['fetch'] };
      case 'dotnet.restore': return { executable: process.platform === 'win32' ? 'dotnet.exe' : 'dotnet', args: ['restore'] };
    }
    throw new AppError({ code: 'NOT_FOUND', message: `Command recipe '${request.recipe}' is unavailable.`, httpStatus: 404, expose: true });
  }

  private async packageMetadata(resolver: ProjectPathResolver): Promise<PackageMetadata | null> {
    try {
      const resolved = await resolver.resolveExisting('package.json');
      const info = await stat(resolved.absolutePath);
      if (!info.isFile() || info.size > 256 * 1024) return null;
      const parsed = packageJsonSchema.safeParse(JSON.parse(await readFile(resolved.absolutePath, 'utf8')) as unknown);
      if (!parsed.success) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json metadata is invalid.', httpStatus: 400, expose: true, cause: parsed.error });
      return { manager: packageManagerFrom(parsed.data.packageManager), scripts: parsed.data.scripts ?? {} };
    } catch (error) {
      if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return null;
      if (error instanceof SyntaxError) throw new AppError({ code: 'VALIDATION_ERROR', message: 'package.json contains invalid JSON.', httpStatus: 400, expose: true, cause: error });
      throw error;
    }
  }

  private async exists(resolver: ProjectPathResolver, relativePath: string): Promise<boolean> {
    try { await resolver.resolveExisting(relativePath); return true; }
    catch (error) { if (error instanceof AppError && error.code === 'PATH_NOT_FOUND') return false; throw error; }
  }

  private async hasRootExtension(resolver: ProjectPathResolver, extensions: readonly string[]): Promise<boolean> {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(resolver.canonicalRoot, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()));
  }
}
