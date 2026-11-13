export interface CandidateRepairSource {
  root: string;
  sourcePath: 'project.yaml';
  text: string;
  revision: string;
  recognition: 'strong' | 'weak';
}
