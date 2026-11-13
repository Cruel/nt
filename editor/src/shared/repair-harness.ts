export const REPAIR_HARNESSES = ['claude', 'codex', 'opencode'] as const;
export type RepairHarness = (typeof REPAIR_HARNESSES)[number];

export interface RepairModelCatalog {
  harness: RepairHarness;
  /** Only a successful catalog is authority that a saved model disappeared. */
  status: 'available' | 'unavailable';
  models: string[];
}

export interface RepairPreferences {
  preferredHarness: RepairHarness | null;
  modelByHarness: Record<RepairHarness, string>;
}

export const DEFAULT_REPAIR_PREFERENCES: RepairPreferences = {
  preferredHarness: null,
  modelByHarness: { claude: '', codex: '', opencode: '' },
};

/** A model identifier is one literal argv value, not shell source. */
export function validRepairModelId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[a-z0-9][a-z0-9._:/+#@[\]-]*$/iu.test(value);
}

export function normalizeRepairPreferences(value: unknown): RepairPreferences {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<RepairPreferences>)
      : {};
  const models: Partial<Record<RepairHarness, unknown>> =
    candidate.modelByHarness && typeof candidate.modelByHarness === 'object'
      ? candidate.modelByHarness
      : DEFAULT_REPAIR_PREFERENCES.modelByHarness;
  const safeModel = (harness: RepairHarness) =>
    typeof models[harness] === 'string' && validRepairModelId(models[harness])
      ? models[harness]
      : '';
  return {
    preferredHarness: REPAIR_HARNESSES.includes(candidate.preferredHarness as RepairHarness)
      ? candidate.preferredHarness!
      : null,
    modelByHarness: {
      claude: safeModel('claude'),
      codex: safeModel('codex'),
      opencode: safeModel('opencode'),
    },
  };
}

// The renderer supplies only a capability identity, an installed harness choice
// and prompt text. It must never select a process, shell, argv, or cwd.
export interface RepairHarnessLaunchRequest {
  kind: 'active' | 'candidate';
  id: string;
  /** The original candidate manifest revision inspected when composing Run. */
  candidateRevision?: string;
  harness: RepairHarness;
  /** Empty or absent means the harness's configured Default, without --model. */
  model?: string;
  prompt: string;
  authorizeWeak: boolean;
  authorizeOlder: boolean;
  authorizeNewer: boolean;
}
