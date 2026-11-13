export const REPAIR_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type RepairHarness = (typeof REPAIR_HARNESSES)[number];

// The renderer supplies only a capability identity, an installed harness choice
// and prompt text. It must never select a process, shell, argv, or cwd.
export interface RepairHarnessLaunchRequest {
  kind: 'active' | 'candidate';
  id: string;
  /** The original candidate manifest revision inspected when composing Run. */
  candidateRevision?: string;
  harness: RepairHarness;
  prompt: string;
  authorizeWeak: boolean;
  authorizeOlder: boolean;
  authorizeNewer: boolean;
}
