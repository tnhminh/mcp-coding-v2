import path from 'node:path';
import { AppError } from './errors.js';
import { ProjectBrainService, type BrainIndex } from './project-brain-service.js';
import { SecureFilesystemService, type SearchMatch } from './secure-filesystem-service.js';

export interface ContextItem {
  path: string;
  score: number;
  reasons: string[];
  sha256: string;
  snippet: string;
}

export interface ContextBundle {
  query: string;
  brainBuiltAt: string;
  items: ContextItem[];
  totalChars: number;
  truncated: boolean;
}

export interface ImpactItem {
  path: string;
  score: number;
  reasons: string[];
  category: string;
}

export interface ImpactResult {
  seed: string;
  declarations: Array<{ name: string; kind: string; path: string; line: number }>;
  affected: ImpactItem[];
  relatedTests: ImpactItem[];
  relatedConfigs: string[];
}

interface ScoreEntry {
  score: number;
  reasons: Set<string>;
  lineHints: number[];
}

function normalized(relativePath: string): string {
  return relativePath.replace(/\\/gu, '/');
}

function addScore(scores: Map<string, ScoreEntry>, relativePath: string, score: number, reason: string, line?: number): void {
  const key = normalized(relativePath);
  const entry = scores.get(key) ?? { score: 0, reasons: new Set<string>(), lineHints: [] };
  entry.score += score;
  entry.reasons.add(reason);
  if (line !== undefined && entry.lineHints.length < 8) entry.lineHints.push(line);
  scores.set(key, entry);
}

const CONTEXT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'bug', 'by', 'change', 'code', 'do', 'fix', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'please', 'the', 'this', 'to', 'update', 'with', 'when', 'where', 'why',
]);

function tokensFor(query: string): string[] {
  const raw = [...new Set(query.toLowerCase().split(/[^a-z0-9_$@/.-]+/u).filter((token) => token.length >= 2))];
  const meaningful = raw.filter((token) => !CONTEXT_STOP_WORDS.has(token));
  return (meaningful.length > 0 ? meaningful : raw).slice(0, 12);
}

function snippetAround(content: string, lineHints: readonly number[], maxChars: number): string {
  if (content.length <= maxChars) return content;
  const lines = content.split(/\r?\n/u);
  const line = Math.max((lineHints[0] ?? 1) - 1, 0);
  const from = Math.max(line - 12, 0);
  const to = Math.min(line + 18, lines.length);
  const excerpt = lines.slice(from, to).join('\n');
  if (excerpt.length <= maxChars) return excerpt;
  return excerpt.slice(0, maxChars);
}

function categoryOf(index: BrainIndex, relativePath: string): string {
  return index.files.find((file) => file.path === relativePath)?.category ?? 'unknown';
}

export class ContextImpactService {
  constructor(
    private readonly brain: ProjectBrainService,
    private readonly filesystem: SecureFilesystemService,
  ) {}

  async contextBundle(request: {
    projectId: string;
    permissionSessionId?: string;
    query: string;
    maxFiles?: number;
    maxChars?: number;
  }): Promise<ContextBundle> {
    const query = request.query.trim();
    if (!query) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Context query is required.', httpStatus: 400, expose: true });
    const index = await this.brain.index(request);
    const tokens = tokensFor(query);
    const scores = new Map<string, ScoreEntry>();
    const queryLower = query.toLowerCase();

    for (const symbol of index.symbols) {
      const name = symbol.name.toLowerCase();
      if (name === queryLower) addScore(scores, symbol.path, 60, `exact symbol ${symbol.name}`, symbol.line);
      else if (name.includes(queryLower) || tokens.some((token) => name.includes(token))) addScore(scores, symbol.path, 25, `symbol ${symbol.name}`, symbol.line);
    }
    for (const reference of index.references) {
      const name = reference.name.toLowerCase();
      if (name === queryLower) addScore(scores, reference.path, 20, `reference ${reference.name}`, reference.line);
      else if (tokens.includes(name)) addScore(scores, reference.path, 6, `reference ${reference.name}`, reference.line);
    }
    for (const item of index.imports) {
      const specifier = item.specifier.toLowerCase();
      if (specifier.includes(queryLower) || tokens.some((token) => specifier.includes(token))) addScore(scores, item.fromPath, 12, `import ${item.specifier}`, item.line);
    }
    for (const file of index.files) {
      const value = file.path.toLowerCase();
      if (value.includes(queryLower)) addScore(scores, file.path, 18, 'path match');
      else if (tokens.some((token) => value.includes(token))) addScore(scores, file.path, 5, 'path token');
    }

    const literalQueries = [query, ...tokens.filter((token) => token !== queryLower)].slice(0, 3);
    for (const literal of literalQueries) {
      let matches: SearchMatch[];
      try {
        matches = await this.filesystem.searchText({ ...request, query: literal, path: '.', maxResults: 100 });
      } catch (error) {
        if (error instanceof AppError && ['VALIDATION_ERROR', 'PATH_NOT_FOUND'].includes(error.code)) continue;
        throw error;
      }
      for (const match of matches) addScore(scores, match.path, literal === query ? 16 : 5, `text hit '${literal}'`, match.line);
    }

    const maxFiles = Math.min(Math.max(request.maxFiles ?? 12, 1), 40);
    const maxChars = Math.min(Math.max(request.maxChars ?? 24_000, 2_000), 120_000);
    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    const items: ContextItem[] = [];
    let totalChars = 0;
    let truncated = ranked.length > maxFiles;

    for (const [relativePath, score] of ranked.slice(0, maxFiles)) {
      if (totalChars >= maxChars) { truncated = true; break; }
      try {
        const file = await this.filesystem.readTextFile({ ...request, path: relativePath });
        const remaining = maxChars - totalChars;
        const snippet = snippetAround(file.content, score.lineHints, Math.min(remaining, 8_000));
        if (!snippet) continue;
        items.push({ path: normalized(file.path), score: score.score, reasons: [...score.reasons], sha256: file.sha256, snippet });
        totalChars += snippet.length;
      } catch (error) {
        if (error instanceof AppError && ['FILE_TOO_LARGE', 'BINARY_FILE', 'SENSITIVE_PATH', 'PATH_NOT_FOUND'].includes(error.code)) continue;
        throw error;
      }
    }
    return { query, brainBuiltAt: index.builtAt, items, totalChars, truncated };
  }

  async impactAnalysis(request: {
    projectId: string;
    permissionSessionId?: string;
    seed: string;
    maxResults?: number;
  }): Promise<ImpactResult> {
    const seed = request.seed.trim();
    if (!seed) throw new AppError({ code: 'VALIDATION_ERROR', message: 'Impact seed is required.', httpStatus: 400, expose: true });
    const index = await this.brain.index(request);
    const seedPath = normalized(seed);
    const fileSeed = index.files.find((file) => file.path.toLowerCase() === seedPath.toLowerCase());
    const declarations = index.symbols.filter((symbol) => symbol.name.toLowerCase() === seed.toLowerCase() || (fileSeed && symbol.path === fileSeed.path));
    if (!fileSeed && declarations.length === 0) {
      throw new AppError({ code: 'NOT_FOUND', message: 'Impact seed did not match an indexed file or exact symbol.', httpStatus: 404, expose: true });
    }

    const scores = new Map<string, ScoreEntry>();
    const rootPaths = new Set<string>();
    if (fileSeed) {
      rootPaths.add(fileSeed.path);
      addScore(scores, fileSeed.path, 100, 'seed file');
    }
    for (const declaration of declarations) {
      rootPaths.add(declaration.path);
      addScore(scores, declaration.path, 100, `declares ${declaration.name}`, declaration.line);
    }

    const symbolNames = new Set(declarations.map((declaration) => declaration.name));
    if (!fileSeed && symbolNames.size === 0) symbolNames.add(seed);
    for (const reference of index.references) {
      if (symbolNames.has(reference.name)) addScore(scores, reference.path, 35, `references ${reference.name}`, reference.line);
    }
    for (const item of index.imports) {
      if (item.resolvedPath && rootPaths.has(item.resolvedPath)) addScore(scores, item.fromPath, 45, `imports ${item.resolvedPath}`, item.line);
    }

    const firstWave = new Set([...scores.keys()]);
    for (const item of index.imports) {
      if (item.resolvedPath && firstWave.has(item.resolvedPath)) addScore(scores, item.fromPath, 15, `imports affected ${item.resolvedPath}`, item.line);
    }

    const maxResults = Math.min(Math.max(request.maxResults ?? 50, 1), 200);
    const ranked = [...scores.entries()]
      .map(([relativePath, entry]) => ({ path: relativePath, score: entry.score, reasons: [...entry.reasons], category: categoryOf(index, relativePath) }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const relatedTests = ranked.filter((item) => item.category === 'test').slice(0, maxResults);
    const affected = ranked.filter((item) => item.category !== 'test').slice(0, maxResults);

    const affectedSet = new Set(ranked.map((item) => item.path));
    const additionalTests = index.tests.filter((testPath) => {
      if (affectedSet.has(testPath)) return false;
      return index.imports.some((item) => item.fromPath === testPath && item.resolvedPath !== null && affectedSet.has(item.resolvedPath));
    });
    for (const testPath of additionalTests.slice(0, Math.max(maxResults - relatedTests.length, 0))) {
      relatedTests.push({ path: testPath, score: 20, reasons: ['imports affected file'], category: 'test' });
    }

    const roots = [...rootPaths];
    const rootDirectories = new Set(roots.map((root) => path.posix.dirname(root)));
    const relatedConfigs = index.configs.filter((configPath) => rootDirectories.has(path.posix.dirname(configPath)) || path.posix.dirname(configPath) === '.').slice(0, 20);
    return {
      seed,
      declarations: declarations.slice(0, 100).map(({ name, kind, path: declarationPath, line }) => ({ name, kind, path: declarationPath, line })),
      affected,
      relatedTests,
      relatedConfigs,
    };
  }
}
