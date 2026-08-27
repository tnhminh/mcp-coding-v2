import type { AiJob } from '../domain/jobs/ai-job.js';

export interface AiJobRepository {
  save(job: AiJob): Promise<void>;
  saveIfStatus(job: AiJob, expectedStatus: AiJob['status']): Promise<boolean>;
  findById(id: string): Promise<AiJob | null>;
  listByProject(projectId: string): Promise<AiJob[]>;
}
