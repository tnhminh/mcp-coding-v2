import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../app/errors.js';

export interface ResolvedProjectPath {
  absolutePath: string;
  relativePath: string;
}

export interface ProjectPathResolverOptions {
  otherProjectRoots?: readonly string[];
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function validateInput(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new AppError({
      code: 'PATH_INVALID',
      message: 'Path contains an invalid null byte.',
      httpStatus: 400,
      expose: true,
    });
  }
}

function hasFsCode(error: unknown, codes: readonly string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && codes.includes(code);
}

function unresolvedPathError(message: string, error: unknown): AppError {
  return new AppError({
    code: 'PATH_INVALID',
    message,
    httpStatus: 400,
    expose: false,
    cause: error,
  });
}

async function canonicalizeDirectory(rootPath: string, label: string): Promise<string> {
  validateInput(rootPath);
  try {
    const canonical = await realpath(path.resolve(rootPath));
    const rootStat = await stat(canonical);
    if (!rootStat.isDirectory()) {
      throw new AppError({
        code: 'PATH_INVALID',
        message: `${label} must be a directory.`,
        httpStatus: 400,
        expose: true,
      });
    }
    return canonical;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!hasFsCode(error, ['ENOENT', 'ENOTDIR'])) {
      throw unresolvedPathError(`${label} could not be resolved safely.`, error);
    }
    throw new AppError({
      code: 'PATH_NOT_FOUND',
      message: `${label} does not exist.`,
      httpStatus: 400,
      expose: true,
      cause: error,
    });
  }
}

function validateWindowsRelativePath(relativePath: string): void {
  if (process.platform !== 'win32' || relativePath === '.') return;

  for (const segment of relativePath.split(path.sep)) {
    if (segment.length === 0) continue;
    const hasControlCharacter = [...segment].some((character) => character.charCodeAt(0) < 32);
    if (hasControlCharacter || /[<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment)) {
      throw new AppError({
        code: 'PATH_INVALID',
        message: 'Path contains a Windows-unsafe segment.',
        httpStatus: 400,
        expose: true,
      });
    }

    const baseName = segment.split('.')[0]?.toUpperCase() ?? '';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(baseName)) {
      throw new AppError({
        code: 'PATH_INVALID',
        message: 'Path contains a reserved Windows device name.',
        httpStatus: 400,
        expose: true,
      });
    }
  }
}

export class ProjectPathResolver {
  private constructor(
    readonly canonicalRoot: string,
    private readonly excludedProjectRoots: readonly string[],
  ) {}

  static async create(
    rootPath: string,
    options: ProjectPathResolverOptions = {},
  ): Promise<ProjectPathResolver> {
    const canonicalRoot = await canonicalizeDirectory(rootPath, 'Project root');
    const excludedProjectRoots: string[] = [];

    for (const otherRootPath of options.otherProjectRoots ?? []) {
      const canonicalOtherRoot = await canonicalizeDirectory(otherRootPath, 'Registered project root');
      if (canonicalOtherRoot === canonicalRoot) {
        throw new AppError({
          code: 'PROJECT_ROOT_CONFLICT',
          message: 'Two registered projects resolve to the same canonical root.',
          httpStatus: 409,
          expose: true,
        });
      }
      if (isContained(canonicalRoot, canonicalOtherRoot)) {
        excludedProjectRoots.push(canonicalOtherRoot);
      }
    }

    return new ProjectPathResolver(canonicalRoot, [...new Set(excludedProjectRoots)]);
  }

  resolveLexical(inputPath: string): ResolvedProjectPath {
    validateInput(inputPath);
    const absolutePath = path.resolve(this.canonicalRoot, inputPath || '.');
    this.assertAllowed(absolutePath);
    const result = this.describe(absolutePath);
    validateWindowsRelativePath(result.relativePath);
    return result;
  }

  async resolveExisting(inputPath: string): Promise<ResolvedProjectPath> {
    const lexical = this.resolveLexical(inputPath);
    try {
      const canonical = await realpath(lexical.absolutePath);
      this.assertAllowed(canonical);
      const result = this.describe(canonical);
      validateWindowsRelativePath(result.relativePath);
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (hasFsCode(error, ['ENOENT', 'ENOTDIR'])) {
        throw new AppError({
          code: 'PATH_NOT_FOUND',
          message: 'Path does not exist within the project.',
          httpStatus: 404,
          expose: true,
          cause: error,
        });
      }
      throw unresolvedPathError('Path could not be resolved safely.', error);
    }
  }

  async resolveForWrite(inputPath: string): Promise<ResolvedProjectPath> {
    const lexical = this.resolveLexical(inputPath);
    let ancestor = lexical.absolutePath;

    while (true) {
      try {
        await lstat(ancestor);
        break;
      } catch (error) {
        if (!hasFsCode(error, ['ENOENT', 'ENOTDIR'])) {
          throw unresolvedPathError('Path ancestor could not be inspected safely.', error);
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new AppError({
            code: 'PATH_NOT_FOUND',
            message: 'No existing ancestor found for project path.',
            httpStatus: 400,
            expose: true,
            cause: error,
          });
        }
        ancestor = parent;
      }
    }

    let canonicalAncestor: string;
    try {
      canonicalAncestor = await realpath(ancestor);
    } catch (error) {
      throw unresolvedPathError('Unable to resolve project path ancestor safely.', error);
    }

    this.assertAllowed(canonicalAncestor);
    const unresolvedSuffix = path.relative(ancestor, lexical.absolutePath);
    const canonicalTarget = path.resolve(canonicalAncestor, unresolvedSuffix || '.');
    this.assertAllowed(canonicalTarget);
    const result = this.describe(canonicalTarget);
    validateWindowsRelativePath(result.relativePath);
    return result;
  }

  private assertAllowed(candidate: string): void {
    if (!isContained(this.canonicalRoot, candidate)) {
      throw new AppError({
        code: 'PATH_OUTSIDE_PROJECT',
        message: 'Path escapes the registered project root.',
        httpStatus: 403,
        expose: true,
      });
    }

    if (this.excludedProjectRoots.some((excludedRoot) => isContained(excludedRoot, candidate))) {
      throw new AppError({
        code: 'PATH_OUTSIDE_PROJECT',
        message: 'Path belongs to another registered project.',
        httpStatus: 403,
        expose: true,
      });
    }
  }

  private describe(absolutePath: string): ResolvedProjectPath {
    const relativePath = path.relative(this.canonicalRoot, absolutePath);
    return { absolutePath, relativePath: relativePath || '.' };
  }
}
