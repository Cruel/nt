import { create } from 'zustand';

export type BottomPanelId =
  | 'problems'
  | 'output'
  | 'preview-events'
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
  { id: 'test-playback', label: 'Test Playback' },
  { id: 'references', label: 'References' },
  { id: 'shader-compile', label: 'Shader Compile' },
  { id: 'package-export', label: 'Package Export' },
  { id: 'command-history', label: 'Command History' },
];

interface BottomPanelStore {
  visible: boolean;
  activePanelId: BottomPanelId;
  setVisible: (visible: boolean) => void;
  setActivePanelId: (id: BottomPanelId) => void;
  toggleVisible: () => void;
}

export const useBottomPanelStore = create<BottomPanelStore>()((set) => ({
  visible: true,
  activePanelId: 'problems',
  setVisible: (visible) => set({ visible }),
  setActivePanelId: (activePanelId) => set({ activePanelId, visible: true }),
  toggleVisible: () => set((state) => ({ visible: !state.visible })),
}));
