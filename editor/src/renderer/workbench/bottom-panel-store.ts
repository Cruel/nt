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
  label: string;
}

export const bottomPanelDefinitions: BottomPanelDefinition[] = [
  { id: 'problems', label: 'Problems' },
  { id: 'output', label: 'Output' },
  { id: 'preview-events', label: 'Preview Events' },
  { id: 'preview-diagnostics', label: 'Preview Diagnostics' },
  { id: 'test-playback', label: 'Test Playback' },
  { id: 'references', label: 'References' },
  { id: 'shader-compile', label: 'Shader Compile' },
  { id: 'package-export', label: 'Package Export' },
  { id: 'command-history', label: 'Command History' },
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
