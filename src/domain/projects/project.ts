import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const projectStatusSchema = z.enum(['active', 'inactive']);
export const brainStatusSchema = z.enum(['not_indexed', 'indexing', 'ready', 'failed']);

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type BrainStatus = z.infer<typeof brainStatusSchema>;
const projectMetadataSchema = z.record(z.string(), z.json());
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;

export interface Project {
  id: string;
  name: string;
  alias: string;
  rootPath: string;
  status: ProjectStatus;
  brainStatus: BrainStatus;
  defaultBranch: string | null;
  remoteRepository: string | null;
  metadata: ProjectMetadata;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  alias: string;
  rootPath: string;
  defaultBranch?: string | null;
  remoteRepository?: string | null;
  metadata?: ProjectMetadata;
}

const nameSchema = z.string().trim().min(1).max(160);
const aliasSchema = z.string().trim().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/i);
const rootPathSchema = z.string().trim().min(1).max(4096);
const optionalTextSchema = z.string().trim().min(1).max(2048).nullable();

export function createProject(
  input: CreateProjectInput,
  options: { id?: string; now?: Date } = {},
): Project {
  const now = (options.now ?? new Date()).toISOString();
  return {
    id: options.id ?? randomUUID(),
    name: nameSchema.parse(input.name),
    alias: aliasSchema.parse(input.alias),
    rootPath: rootPathSchema.parse(input.rootPath),
    status: 'active',
    brainStatus: 'not_indexed',
    defaultBranch: optionalTextSchema.parse(input.defaultBranch ?? null),
    remoteRepository: optionalTextSchema.parse(input.remoteRepository ?? null),
    metadata: structuredClone(projectMetadataSchema.parse(input.metadata ?? {})),
    createdAt: now,
    updatedAt: now,
  };
}

export function touchProject(project: Project, now: Date = new Date()): Project {
  return { ...project, updatedAt: now.toISOString(), metadata: structuredClone(project.metadata) };
}
