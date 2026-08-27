import path from 'node:path';
import * as ts from 'typescript';
import { AuthorizationService } from './authorization-service.js';
import type { BrainSnapshotRepository } from './brain-snapshot-repository.js';
import { AppError } from './errors.js';
import { SecureFilesystemService, type ListedEntry } from './secure-filesystem-service.js';
import { touchProject } from '../domain/projects/project.js';
import type { ProjectRepository } from '../domain/projects/project-repository.js';

const MAX_DISCOVERED_ENTRIES = 5000;
const MAX_INDEXED_FILES = 3000;
const MAX_PARSE_BYTES = 1024 * 1024;
const MAX_REFERENCES = 25_000;
const MAX_SYMBOLS = 10_000;
const EXTRA_SKIP_SEGMENTS = new Set(['.next', '.nuxt', '.turbo', '.cache', 'target', 'vendor', 'out', 'build']);
const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const INDEXABLE_EXTENSIONS = new Set([
  ...TS_JS_EXTENSIONS,
  '.json', '.md', '.mdx', '.py', '.go', '.rs', '.java', '.kt', '.kts', '.cs', '.php', '.rb', '.swift',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less', '.yaml', '.yml', '.toml', '.xml', '.sql', '.graphql', '.gql',
]);
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

export interface BrainFile {
  path: string;
  language: string;
  category: 'source' | 'test' | 'config' | 'doc' | 'other';
  bytes: number;
  sha256: string;
}

export interface BrainSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  exported: boolean;
}

export interface BrainImport {
  fromPath: string;
  specifier: string;
  resolvedPath: string | null;
  line: number;
}

export interface BrainReference {
  name: string;
  path: string;
  line: number;
}

export interface BrainIndex {
  projectId: string;
  builtAt: string;
  files: BrainFile[];
  symbols: BrainSymbol[];
  imports: BrainImport[];
  references: BrainReference[];
  tests: string[];
  configs: string[];
  stats: {
    discoveredEntries: number;
    indexedFiles: number;
    parsedTsJsFiles: number;
    reusedTsJsFiles: number;
    truncated: boolean;
  };
}

export interface BrainSummary {
  projectId: string;
  state: 'not_indexed' | 'indexing' | 'ready' | 'failed';
  builtAt: string | null;
  counts: {
    files: number;
    symbols: number;
    imports: number;
    references: number;
    tests: number;
    configs: number;
  };
  languages: Record<string, number>;
  stats: BrainIndex['stats'] | null;
}

interface ParsedFileGraph {
  symbols: BrainSymbol[];
  imports: BrainImport[];
  references: BrainReference[];
}

function normalized(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function hasSkippedSegment(relativePath: string): boolean {
  return normalized(relativePath).split('/').some((segment) => EXTRA_SKIP_SEGMENTS.has(segment.toLowerCase()));
}

function languageFor(relativePath: string): string {
  const extension = path.extname(relativePath).toLowerCase();
  const mapping: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript-react', '.mts': 'typescript', '.cts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript-react', '.mjs': 'javascript', '.cjs': 'javascript',
    '.json': 'json', '.md': 'markdown', '.mdx': 'mdx', '.py': 'python', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.cs': 'csharp', '.php': 'php', '.rb': 'ruby',
    '.swift': 'swift', '.vue': 'vue', '.svelte': 'svelte', '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.less': 'less', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml', '.sql': 'sql',
    '.graphql': 'graphql', '.gql': 'graphql',
  };
  return mapping[extension] ?? (extension ? extension.slice(1) : 'unknown');
}

function isTestPath(relativePath: string): boolean {
  const value = normalized(relativePath).toLowerCase();
  return /(^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/u.test(value) || /\.(?:test|spec)\.[^/]+$/u.test(value);
}

function isConfigPath(relativePath: string): boolean {
  const value = normalized(relativePath).toLowerCase();
  const base = path.posix.basename(value);
  return value.startsWith('.github/') || value.startsWith('.mcp/') ||
    /^(?:package|tsconfig|jsconfig|eslint|prettier|vite|vitest|jest|webpack|rollup|babel|biome|turbo|nx|docker|compose)(?:\.|$)/u.test(base) ||
    ['cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'build.gradle.kts'].includes(base);
}

function categoryFor(relativePath: string): BrainFile['category'] {
  if (isTestPath(relativePath)) return 'test';
  if (isConfigPath(relativePath)) return 'config';
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === '.md' || extension === '.mdx') return 'doc';
  if (INDEXABLE_EXTENSIONS.has(extension)) return 'source';
  return 'other';
}

function scriptKindFor(relativePath: string): ts.ScriptKind {
  switch (path.extname(relativePath).toLowerCase()) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js': case '.mjs': case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isEnumDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) && parent.name === node
  );
}

function parseTsJs(relativePath: string, content: string): ParsedFileGraph {
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKindFor(relativePath));
  const symbols: BrainSymbol[] = [];
  const imports: BrainImport[] = [];
  const references: BrainReference[] = [];

  const addNamedSymbol = (name: ts.Identifier | undefined, kind: string, node: ts.Node, exported = isExported(node)): void => {
    if (!name || symbols.length >= MAX_SYMBOLS) return;
    symbols.push({ name: name.text, kind, path: relativePath, line: lineOf(source, name), exported });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) addNamedSymbol(node.name, 'function', node);
    else if (ts.isClassDeclaration(node)) addNamedSymbol(node.name, 'class', node);
    else if (ts.isInterfaceDeclaration(node)) addNamedSymbol(node.name, 'interface', node);
    else if (ts.isTypeAliasDeclaration(node)) addNamedSymbol(node.name, 'type', node);
    else if (ts.isEnumDeclaration(node)) addNamedSymbol(node.name, 'enum', node);
    else if (ts.isVariableStatement(node)) {
      const exported = isExported(node);
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) addNamedSymbol(declaration.name, 'variable', declaration, exported);
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({ fromPath: relativePath, specifier: node.moduleSpecifier.text, resolvedPath: null, line: lineOf(source, node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({ fromPath: relativePath, specifier: node.moduleSpecifier.text, resolvedPath: null, line: lineOf(source, node) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) imports.push({ fromPath: relativePath, specifier: first.text, resolvedPath: null, line: lineOf(source, node) });
    }

    if (references.length < MAX_REFERENCES && ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      references.push({ name: node.text, path: relativePath, line: lineOf(source, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { symbols, imports, references };
}

function resolveImport(fromPath: string, specifier: string, fileSet: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [base];
  for (const extension of IMPORT_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of IMPORT_EXTENSIONS) candidates.push(path.posix.join(base, `index${extension}`));
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

function parsePersistedIndex(indexJson: string, projectId: string): BrainIndex | null {
  try {
    const parsed: unknown = JSON.parse(indexJson);
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (value.projectId !== projectId || typeof value.builtAt !== 'string') return null;
    if (!Array.isArray(value.files) || !Array.isArray(value.symbols) || !Array.isArray(value.imports) || !Array.isArray(value.references) || !Array.isArray(value.tests) || !Array.isArray(value.configs)) return null;
    if (!value.stats || typeof value.stats !== 'object') return null;
    return parsed as BrainIndex;
  } catch {
    return null;
  }
}

export class ProjectBrainService {
  private readonly cache = new Map<string, BrainIndex>();

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly filesystem: SecureFilesystemService,
    private readonly projects: ProjectRepository,
    private readonly snapshots: BrainSnapshotRepository,
  ) {}

  async build(request: { projectId: string; permissionSessionId?: string }): Promise<BrainSummary> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const project = await this.projects.findById(request.projectId);
    if (!project) throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    await this.projects.save(touchProject({ ...project, brainStatus: 'indexing' }));
    const previous = await this.loadIndex(request.projectId);
    try {
      const index = await this.scan(request, previous);
      this.cache.set(request.projectId, index);
      const now = new Date().toISOString();
      await this.snapshots.save({ projectId: request.projectId, builtAt: index.builtAt, indexJson: JSON.stringify(index), updatedAt: now });
      const latest = await this.projects.findById(request.projectId);
      if (latest) await this.projects.save(touchProject({ ...latest, brainStatus: 'ready' }));
      return this.summaryFrom(index, 'ready');
    } catch (error) {
      const latest = await this.projects.findById(request.projectId);
      if (latest) await this.projects.save(touchProject({ ...latest, brainStatus: 'failed' }));
      throw error;
    }
  }

  async ensureIndex(request: { projectId: string; permissionSessionId?: string }): Promise<BrainIndex> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const existing = await this.loadIndex(request.projectId);
    if (existing) return existing;
    await this.build(request);
    const built = await this.loadIndex(request.projectId);
    if (!built) throw new AppError({ code: 'INTERNAL_ERROR', message: 'Project Brain build did not produce an index.' });
    return built;
  }

  async status(request: { projectId: string; permissionSessionId?: string }): Promise<BrainSummary> {
    await this.authorization.authorize({ ...request, capability: 'filesystem.read' });
    const project = await this.projects.findById(request.projectId);
    if (!project) throw new AppError({ code: 'NOT_FOUND', message: 'Project was not found.', httpStatus: 404, expose: true });
    const index = await this.loadIndex(request.projectId);
    if (index) return this.summaryFrom(index, project.brainStatus === 'failed' ? 'failed' : 'ready');
    if (project.brainStatus !== 'not_indexed') await this.projects.save(touchProject({ ...project, brainStatus: 'not_indexed' }));
    return this.emptySummary(request.projectId, 'not_indexed');
  }

  async findSymbols(request: { projectId: string; permissionSessionId?: string; query: string; maxResults?: number }): Promise<BrainSymbol[]> {
    const query = request.query.trim().toLowerCase();
    if (!query) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Symbol query is required.', httpStatus: 400, expose: true });
    const index = await this.ensureIndex(request);
    const limit = Math.min(Math.max(request.maxResults ?? 50, 1), 200);
    return index.symbols
      .filter((symbol) => symbol.name.toLowerCase().includes(query))
      .sort((a, b) => Number(b.name.toLowerCase() === query) - Number(a.name.toLowerCase() === query) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  async references(request: { projectId: string; permissionSessionId?: string; symbol: string; maxResults?: number }): Promise<BrainReference[]> {
    const symbol = request.symbol.trim();
    if (!symbol) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Reference symbol is required.', httpStatus: 400, expose: true });
    const index = await this.ensureIndex(request);
    const limit = Math.min(Math.max(request.maxResults ?? 100, 1), 500);
    return index.references.filter((reference) => reference.name === symbol).slice(0, limit);
  }

  async index(request: { projectId: string; permissionSessionId?: string }): Promise<BrainIndex> {
    return this.ensureIndex(request);
  }

  private async loadIndex(projectId: string): Promise<BrainIndex | undefined> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;
    const snapshot = await this.snapshots.findByProjectId(projectId);
    if (!snapshot) return undefined;
    const parsed = parsePersistedIndex(snapshot.indexJson, projectId);
    if (!parsed) {
      await this.snapshots.remove(projectId);
      return undefined;
    }
    this.cache.set(projectId, parsed);
    return parsed;
  }

  private async scan(request: { projectId: string; permissionSessionId?: string }, previous?: BrainIndex): Promise<BrainIndex> {
    const queue = ['.'];
    const visitedDirectories = new Set<string>();
    const candidateFiles: string[] = [];
    let discoveredEntries = 0;
    let truncated = false;

    while (queue.length > 0 && discoveredEntries < MAX_DISCOVERED_ENTRIES && candidateFiles.length < MAX_INDEXED_FILES) {
      const directory = queue.shift();
      if (!directory || visitedDirectories.has(directory)) continue;
      visitedDirectories.add(directory);
      const entries = await this.filesystem.listFiles({ ...request, path: directory, depth: 0, maxEntries: 500 });
      discoveredEntries += entries.length;
      for (const entry of entries) {
        if (hasSkippedSegment(entry.path)) continue;
        if (entry.type === 'directory') queue.push(entry.path);
        else if (entry.type === 'file' && this.isIndexableEntry(entry)) candidateFiles.push(normalized(entry.path));
        if (candidateFiles.length >= MAX_INDEXED_FILES || discoveredEntries >= MAX_DISCOVERED_ENTRIES) {
          truncated = true;
          break;
        }
      }
    }
    if (queue.length > 0) truncated = true;

    const previousFiles = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
    const previousSymbols = this.groupByPath(previous?.symbols ?? []);
    const previousImports = this.groupByPath(previous?.imports ?? [], 'fromPath');
    const previousReferences = this.groupByPath(previous?.references ?? []);
    const files: BrainFile[] = [];
    const symbols: BrainSymbol[] = [];
    const imports: BrainImport[] = [];
    const references: BrainReference[] = [];
    let parsedTsJsFiles = 0;
    let reusedTsJsFiles = 0;

    for (const relativePath of candidateFiles) {
      let file;
      try {
        file = await this.filesystem.readTextFile({ ...request, path: relativePath });
      } catch (error) {
        if (error instanceof AppError && ['FILE_TOO_LARGE', 'BINARY_FILE', 'SENSITIVE_PATH', 'PATH_OUTSIDE_PROJECT'].includes(error.code)) continue;
        throw error;
      }
      const brainFile: BrainFile = {
        path: normalized(file.path),
        language: languageFor(relativePath),
        category: categoryFor(relativePath),
        bytes: file.bytes,
        sha256: file.sha256,
      };
      files.push(brainFile);
      if (!TS_JS_EXTENSIONS.has(path.extname(relativePath).toLowerCase()) || file.bytes > MAX_PARSE_BYTES) continue;
      const previousFile = previousFiles.get(brainFile.path);
      if (previousFile?.sha256 === brainFile.sha256) {
        symbols.push(...(previousSymbols.get(brainFile.path) ?? []));
        imports.push(...(previousImports.get(brainFile.path) ?? []));
        references.push(...(previousReferences.get(brainFile.path) ?? []));
        reusedTsJsFiles += 1;
      } else {
        const parsed = parseTsJs(brainFile.path, file.content);
        symbols.push(...parsed.symbols);
        imports.push(...parsed.imports);
        references.push(...parsed.references);
        parsedTsJsFiles += 1;
      }
    }

    const fileSet = new Set(files.map((file) => file.path));
    for (const item of imports) item.resolvedPath = resolveImport(item.fromPath, item.specifier, fileSet);
    return {
      projectId: request.projectId,
      builtAt: new Date().toISOString(),
      files,
      symbols: symbols.slice(0, MAX_SYMBOLS),
      imports,
      references: references.slice(0, MAX_REFERENCES),
      tests: files.filter((file) => file.category === 'test').map((file) => file.path),
      configs: files.filter((file) => file.category === 'config').map((file) => file.path),
      stats: { discoveredEntries, indexedFiles: files.length, parsedTsJsFiles, reusedTsJsFiles, truncated },
    };
  }

  private isIndexableEntry(entry: ListedEntry): boolean {
    if (entry.bytes === null || entry.bytes > MAX_PARSE_BYTES) return false;
    const extension = path.extname(entry.path).toLowerCase();
    const base = path.basename(entry.path).toLowerCase();
    return INDEXABLE_EXTENSIONS.has(extension) || ['dockerfile', 'makefile', 'agents.md', 'skill.md', 'requirements.txt'].includes(base);
  }

  private groupByPath<T extends { path: string }>(values: readonly T[]): Map<string, T[]>;
  private groupByPath<T extends { fromPath: string }>(values: readonly T[], key: 'fromPath'): Map<string, T[]>;
  private groupByPath<T extends { path: string } | { fromPath: string }>(values: readonly T[], key?: 'fromPath'): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const value of values) {
      const relativePath = key === 'fromPath' ? (value as { fromPath: string }).fromPath : (value as { path: string }).path;
      const bucket = grouped.get(relativePath) ?? [];
      bucket.push(value);
      grouped.set(relativePath, bucket);
    }
    return grouped;
  }

  private summaryFrom(index: BrainIndex, state: BrainSummary['state']): BrainSummary {
    const languages: Record<string, number> = {};
    for (const file of index.files) languages[file.language] = (languages[file.language] ?? 0) + 1;
    return {
      projectId: index.projectId,
      state,
      builtAt: index.builtAt,
      counts: { files: index.files.length, symbols: index.symbols.length, imports: index.imports.length, references: index.references.length, tests: index.tests.length, configs: index.configs.length },
      languages,
      stats: index.stats,
    };
  }

  private emptySummary(projectId: string, state: BrainSummary['state']): BrainSummary {
    return {
      projectId,
      state,
      builtAt: null,
      counts: { files: 0, symbols: 0, imports: 0, references: 0, tests: 0, configs: 0 },
      languages: {},
      stats: null,
    };
  }
}
