export type ToolingActivityLayer = 'ipc' | 'native';
export type ToolingActivityStatus = 'success' | 'error';

export interface ToolingActivityRecord {
  id: string;
  layer: ToolingActivityLayer;
  operation: string;
  status: ToolingActivityStatus;
  startedAt: number;
  durationMs: number;
  detail?: string;
}
