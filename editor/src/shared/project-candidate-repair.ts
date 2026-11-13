export interface CandidateRepairSource {
  root: string;
  sourcePath: 'project.yaml';
  text: string;
  revision: string;
  recognition: 'strong' | 'weak';
}

export interface CandidateRepairStatus {
  id: string;
  generation: number;
  ready: boolean;
  /** Exact candidate source-tree digest verified by the native CLI. */
  revision: string | null;
  diagnostics: import('./editor-tooling').ToolDiagnostic[];
}

/** The renderer cannot nominate a new Project path at this boundary. */
export interface OpenReadyRepairCandidate {
  repairCandidateId: string;
  readyRevision: string;
}
