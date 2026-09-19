export const TERMINAL_LIMITS = {
  sessionIdLength: 128,
  writeBytes: 64 * 1024,
  columns: 1_000,
  rows: 1_000,
} as const;

export type TerminalSessionStatus = 'running' | 'exited' | 'error';
export type TerminalCommandState = 'idle' | 'running' | 'unknown';

export interface TerminalProjectOrigin {
  id: string;
  name: string;
}

export interface TerminalSessionSnapshot {
  id: string;
  label: string;
  sequence: number;
  status: TerminalSessionStatus;
  commandState: TerminalCommandState;
  initialCwd: string;
  lastKnownCwd: string | null;
  createdAt: string;
  originProject: TerminalProjectOrigin | null;
  output: string;
  error: string | null;
  exitCode: number | null;
}

export interface TerminalHostSnapshot {
  sessions: TerminalSessionSnapshot[];
  selectedSessionId: string;
}

export interface TerminalCloseRequest {
  sessionId: string;
  force: boolean;
}

export interface TerminalCloseResult {
  state: TerminalHostSnapshot;
  requiresConfirmation: boolean;
}

export interface TerminalWindowCloseRequest {
  terminalRiskCount: number;
}

export function terminalSessionRequiresCloseConfirmation(
  session: Pick<TerminalSessionSnapshot, 'status' | 'commandState'>,
): boolean {
  return session.status === 'running' && session.commandState !== 'idle';
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
