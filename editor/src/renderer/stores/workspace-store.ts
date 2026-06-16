import { create } from 'zustand';

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
  sidebarExpanded: boolean;
  inspectorVisible: boolean;
  setProjectPath: (path: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setInspectorVisible: (visible: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  projectPath: null,
  selectedAssetId: null,
  sidebarExpanded: true,
  inspectorVisible: true,
  setProjectPath: (projectPath) => set({ projectPath }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setSidebarExpanded: (sidebarExpanded) => set({ sidebarExpanded }),
  setInspectorVisible: (inspectorVisible) => set({ inspectorVisible }),
}));
