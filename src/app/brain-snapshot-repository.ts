export interface BrainSnapshot {
  projectId: string;
  builtAt: string;
  indexJson: string;
  updatedAt: string;
}

export interface BrainSnapshotRepository {
  save(snapshot: BrainSnapshot): Promise<void>;
  findByProjectId(projectId: string): Promise<BrainSnapshot | null>;
  remove(projectId: string): Promise<boolean>;
}
