import { create } from 'zustand';
import type { PreviewConnectionState, PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

export interface AssetNode {
  id: string;
  label: string;
  type: 'scene' | 'character' | 'script' | 'image' | 'audio' | 'folder';
  children?: AssetNode[];
}

export const mockAssetTree: AssetNode[] = [
  {
    id: 'scenes',
    label: 'Scenes',
    type: 'folder',
    children: [
      { id: 'scn-intro', label: 'Intro', type: 'scene' },
      { id: 'scn-forest', label: 'Forest Path', type: 'scene' },
      { id: 'scn-village', label: 'Village Square', type: 'scene' },
      { id: 'scn-temple', label: 'Ancient Temple', type: 'scene' },
    ],
  },
  {
    id: 'characters',
    label: 'Characters',
    type: 'folder',
    children: [
      { id: 'char-protagonist', label: 'Protagonist', type: 'character' },
      { id: 'char-hermit', label: 'The Hermit', type: 'character' },
      { id: 'char-merchant', label: 'Merchant', type: 'character' },
    ],
  },
  {
    id: 'scripts',
    label: 'Scripts',
    type: 'folder',
    children: [
      { id: 'scr-main', label: 'main.nt', type: 'script' },
      { id: 'scr-intro', label: 'intro.nt', type: 'script' },
      { id: 'scr-choices', label: 'choices.nt', type: 'script' },
    ],
  },
  {
    id: 'images',
    label: 'Images',
    type: 'folder',
    children: [
      { id: 'img-bg-forest', label: 'bg_forest.png', type: 'image' },
      { id: 'img-bg-village', label: 'bg_village.png', type: 'image' },
      { id: 'img-char-hermit', label: 'hermit.png', type: 'image' },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    type: 'folder',
    children: [
      { id: 'aud-bgm-main', label: 'bgm_main.ogg', type: 'audio' },
      { id: 'aud-sfx-door', label: 'sfx_door.ogg', type: 'audio' },
    ],
  },
];

interface WorkspaceState {
  projectPath: string | null;
  selectedAssetId: string | null;
  previewPosition: PreviewPosition;
  previewRunning: boolean;
  previewConnectionState: PreviewConnectionState;
  selectedRuntimeObjectId: string | null;
  lastPreviewEvent: PreviewToEditorMessage | null;
  statusMessage: string;
  sidebarExpanded: boolean;
  inspectorVisible: boolean;
  setProjectPath: (path: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setPreviewPosition: (position: PreviewPosition) => void;
  setPreviewRunning: (running: boolean) => void;
  setPreviewConnectionState: (state: PreviewConnectionState) => void;
  setSelectedRuntimeObjectId: (id: string | null) => void;
  setLastPreviewEvent: (event: PreviewToEditorMessage | null) => void;
  setStatusMessage: (message: string) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setInspectorVisible: (visible: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  projectPath: null,
  selectedAssetId: null,
  previewPosition: { x: 0.5, y: 0.5 },
  previewRunning: true,
  previewConnectionState: 'disconnected',
  selectedRuntimeObjectId: null,
  lastPreviewEvent: null,
  statusMessage: 'Preview disconnected',
  sidebarExpanded: true,
  inspectorVisible: true,
  setProjectPath: (projectPath) => set({ projectPath }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setPreviewPosition: (previewPosition) => set({ previewPosition }),
  setPreviewRunning: (previewRunning) => set({ previewRunning }),
  setPreviewConnectionState: (previewConnectionState) => set({ previewConnectionState }),
  setSelectedRuntimeObjectId: (selectedRuntimeObjectId) => set({ selectedRuntimeObjectId }),
  setLastPreviewEvent: (lastPreviewEvent) => set({ lastPreviewEvent }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setSidebarExpanded: (sidebarExpanded) => set({ sidebarExpanded }),
  setInspectorVisible: (inspectorVisible) => set({ inspectorVisible }),
}));
