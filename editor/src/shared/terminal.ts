export const TERMINAL_LIMITS = {
  sessionIdLength: 128,
  writeBytes: 64 * 1024,
  columns: 1_000,
  rows: 1_000,
} as const;

export type TerminalSessionStatus = 'running' | 'exited' | 'error';

export interface TerminalSessionSnapshot {
  id: string;
  status: TerminalSessionStatus;
  initialCwd: string;
  output: string;
  error: string | null;
  exitCode: number | null;
}

export type TerminalEvent =
  | { kind: 'output'; sessionId: string; data: string }
  | { kind: 'exit'; sessionId: string; exitCode: number | null }
  | { kind: 'error'; sessionId: string; message: string };

export interface TerminalResizeRequest {
  sessionId: string;
  columns: number;
  rows: number;
}
