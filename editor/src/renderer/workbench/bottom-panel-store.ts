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
  hasPreviewTab: boolean;
  hasPreviewDiagnostics: boolean;
  hasPlaybackReport: boolean;
  hasReferencesResult: boolean;
  hasPackageExport: boolean;
  developerMode: boolean;
  activeTabResourceKind: string | null;
}

export interface BottomPanelDefinition {
  id: BottomPanelId;
  labelKey: string;
  group?: 'preview';
  isAvailable: (context: BottomPanelWorkbenchContext) => boolean;
  isRelevant?: (context: BottomPanelWorkbenchContext) => boolean;
}

const globallyAvailable = () => true;
const projectAvailable = (context: BottomPanelWorkbenchContext) => context.hasProject;
const previewAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && context.hasPreviewTab;
const previewDiagnosticsAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && (context.hasPreviewTab || context.hasPreviewDiagnostics);
const playbackAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && context.hasPlaybackReport;
const referencesAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && context.hasReferencesResult;
const packageExportAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && context.hasPackageExport;
const developerProjectAvailable = (context: BottomPanelWorkbenchContext) =>
  context.hasProject && context.developerMode;
const previewRelevant = (context: BottomPanelWorkbenchContext) =>
  context.activeTabResourceKind === 'preview';

export const bottomPanelDefinitions: BottomPanelDefinition[] = [
  { id: 'problems', labelKey: 'bottomPanel.labels.problems', isAvailable: projectAvailable },
  { id: 'output', labelKey: 'bottomPanel.labels.output', isAvailable: globallyAvailable },
  { id: 'terminal', labelKey: 'bottomPanel.labels.terminal', isAvailable: globallyAvailable },
  {
    id: 'preview-events',
    labelKey: 'bottomPanel.labels.previewEvents',
    group: 'preview',
    isAvailable: previewAvailable,
    isRelevant: previewRelevant,
  },
  {
    id: 'preview-diagnostics',
    labelKey: 'bottomPanel.labels.previewDiagnostics',
    group: 'preview',
    isAvailable: previewDiagnosticsAvailable,
    isRelevant: previewRelevant,
  },
  {
    id: 'asset-performance',
    labelKey: 'bottomPanel.labels.assetPerformance',
    group: 'preview',
    isAvailable: previewAvailable,
    isRelevant: previewRelevant,
  },
  {
    id: 'test-playback',
    labelKey: 'bottomPanel.labels.testPlayback',
    isAvailable: playbackAvailable,
  },
  {
    id: 'references',
    labelKey: 'bottomPanel.labels.references',
    isAvailable: referencesAvailable,
  },
  {
    id: 'shader-compile',
    labelKey: 'bottomPanel.labels.shaderCompile',
    isAvailable: developerProjectAvailable,
  },
  {
    id: 'package-export',
    labelKey: 'bottomPanel.labels.packageExport',
    isAvailable: packageExportAvailable,
  },
  {
    id: 'command-history',
    labelKey: 'bottomPanel.labels.commandHistory',
    isAvailable: developerProjectAvailable,
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
