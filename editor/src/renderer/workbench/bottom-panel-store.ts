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
  | 'command-history';

export interface BottomPanelDefinition {
  id: BottomPanelId;
  labelKey: string;
}

export const bottomPanelDefinitions: BottomPanelDefinition[] = [
  { id: 'problems', labelKey: 'bottomPanel.labels.problems' },
  { id: 'output', labelKey: 'bottomPanel.labels.output' },
  { id: 'preview-events', labelKey: 'bottomPanel.labels.previewEvents' },
  { id: 'preview-diagnostics', labelKey: 'bottomPanel.labels.previewDiagnostics' },
  { id: 'test-playback', labelKey: 'bottomPanel.labels.testPlayback' },
  { id: 'references', labelKey: 'bottomPanel.labels.references' },
  { id: 'shader-compile', labelKey: 'bottomPanel.labels.shaderCompile' },
  { id: 'package-export', labelKey: 'bottomPanel.labels.packageExport' },
  { id: 'command-history', labelKey: 'bottomPanel.labels.commandHistory' },
];

interface BottomPanelStore {
  visible: boolean;
  activePanelId: BottomPanelId;
  sizePercent: number;
  hydrate: (state?: { visible?: boolean; activePanelId?: BottomPanelId; sizePercent?: number } | null) => void;
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
  hydrate: (state) => set({ visible: state?.visible ?? true, activePanelId: state?.activePanelId ?? 'problems', sizePercent: state?.sizePercent ?? 30 }),
  serialize: () => ({ visible: get().visible, activePanelId: get().activePanelId, sizePercent: get().sizePercent }),
  setVisible: (visible) => set({ visible }),
  setSizePercent: (sizePercent) => set({ sizePercent: Math.min(70, Math.max(10, sizePercent)) }),
  setActivePanelId: (activePanelId) => set({ activePanelId, visible: true }),
  toggleVisible: () => set((state) => ({ visible: !state.visible })),
}));
