import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const aiJobStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_fix',
  'awaiting_review',
  'completed',
  'stopped',
  'failed',
  'cancelled',
]);
export type AiJobStatus = z.infer<typeof aiJobStatusSchema>;

export interface AiJob {
  id: string;
  projectId: string;
  objective: string;
  status: AiJobStatus;
  iteration: number;
  maxIterations: number;
  evidence: unknown[];
  reviewSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

const transitions: Readonly<Record<AiJobStatus, readonly AiJobStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['awaiting_fix', 'awaiting_review', 'stopped', 'failed', 'cancelled'],
  awaiting_fix: ['running', 'cancelled'],
  awaiting_review: ['running', 'completed', 'cancelled'],
  completed: [],
  stopped: [],
  failed: [],
  cancelled: [],
};

export function createAiJob(
  input: { projectId: string; objective: string; maxIterations?: number },
  options: { id?: string; now?: Date } = {},
): AiJob {
  const objective = z.string().trim().min(1).max(2000).parse(input.objective);
  const maxIterations = z.number().int().min(1).max(20).parse(input.maxIterations ?? 5);
  const now = (options.now ?? new Date()).toISOString();
  return {
    id: options.id ?? randomUUID(),
    projectId: z.string().uuid().parse(input.projectId),
    objective,
    status: 'queued',
    iteration: 0,
    maxIterations,
    evidence: [],
    reviewSummary: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function transitionAiJob(job: AiJob, status: AiJobStatus, now: Date = new Date()): AiJob {
  if (!transitions[job.status].includes(status)) {
    throw new Error(`Invalid AI job transition: ${job.status} -> ${status}`);
  }
  return { ...job, status, updatedAt: now.toISOString() };
}

export function isAiJobTerminal(status: AiJobStatus): boolean {
  return ['completed', 'stopped', 'failed', 'cancelled'].includes(status);
}
