import { create } from 'zustand';

export type BottomPanelId =
  | 'problems'
  | 'output'
  | 'preview-events'
  | 'preview-diagnostics'
  | 'test-playback'
  | 'references'
  | 'shader-compile'
  | 'package-export'
  | 'asset-performance'
  | 'command-history'
  | 'terminal';

export interface BottomPanelWorkbenchContext {
  hasProject: boolean;
}

export interface BottomPanelDefinition {
  id: BottomPanelId;
  labelKey: string;
  isAvailable: (context: BottomPanelWorkbenchContext) => boolean;
}

const globallyAvailable = () => true;
const projectAvailable = (context: BottomPanelWorkbenchContext) => context.hasProject;

export const bottomPanelDefinitions: BottomPanelDefinition[] = [
  { id: 'problems', labelKey: 'bottomPanel.labels.problems', isAvailable: projectAvailable },
  { id: 'output', labelKey: 'bottomPanel.labels.output', isAvailable: globallyAvailable },
  { id: 'terminal', labelKey: 'bottomPanel.labels.terminal', isAvailable: globallyAvailable },
  {
    id: 'preview-events',
    labelKey: 'bottomPanel.labels.previewEvents',
    isAvailable: projectAvailable,
  },
  {
    id: 'preview-diagnostics',
    labelKey: 'bottomPanel.labels.previewDiagnostics',
    isAvailable: projectAvailable,
  },
  {
    id: 'test-playback',
    labelKey: 'bottomPanel.labels.testPlayback',
    isAvailable: projectAvailable,
  },
  { id: 'references', labelKey: 'bottomPanel.labels.references', isAvailable: projectAvailable },
  {
    id: 'shader-compile',
    labelKey: 'bottomPanel.labels.shaderCompile',
    isAvailable: projectAvailable,
  },
  {
    id: 'package-export',
    labelKey: 'bottomPanel.labels.packageExport',
    isAvailable: projectAvailable,
  },
  {
    id: 'asset-performance',
    labelKey: 'bottomPanel.labels.assetPerformance',
    isAvailable: projectAvailable,
  },
  {
    id: 'command-history',
    labelKey: 'bottomPanel.labels.commandHistory',
    isAvailable: projectAvailable,
  },
];

export function availableBottomPanelDefinitions(context: BottomPanelWorkbenchContext) {
  return bottomPanelDefinitions.filter((definition) => definition.isAvailable(context));
}

export function resolveAvailableBottomPanelId(
  activePanelId: BottomPanelId,
  context: BottomPanelWorkbenchContext,
): BottomPanelId | null {
  const available = availableBottomPanelDefinitions(context);
  return available.some((definition) => definition.id === activePanelId)
    ? activePanelId
    : (available[0]?.id ?? null);
}

interface BottomPanelStore {
  visible: boolean;
  activePanelId: BottomPanelId;
  sizePercent: number;
  hydrate: (
    state?: { visible?: boolean; activePanelId?: BottomPanelId; sizePercent?: number } | null,
  ) => void;
  serialize: () => { visible: boolean; activePanelId: BottomPanelId; sizePercent: number };
  setVisible: (visible: boolean) => void;
  setSizePercent: (sizePercent: number) => void;
  setActivePanelId: (id: BottomPanelId) => void;
  toggleVisible: () => void;
}

export const useBottomPanelStore = create<BottomPanelStore>()((set, get) => ({
  visible: true,
  activePanelId: 'problems',
  sizePercent: 30,
  hydrate: (state) =>
    set({
      visible: state?.visible ?? true,
      activePanelId: state?.activePanelId ?? 'problems',
      sizePercent: state?.sizePercent ?? 30,
    }),
  serialize: () => ({
    visible: get().visible,
    activePanelId: get().activePanelId,
    sizePercent: get().sizePercent,
  }),
  setVisible: (visible) => set({ visible }),
  setSizePercent: (sizePercent) => set({ sizePercent: Math.min(70, Math.max(10, sizePercent)) }),
  setActivePanelId: (activePanelId) => set({ activePanelId, visible: true }),
  toggleVisible: () => set((state) => ({ visible: !state.visible })),
}));
