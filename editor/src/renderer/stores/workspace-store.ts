import { create } from 'zustand';
import type { ToolDiagnostic, PlaybackTestSummary } from '../../shared/editor-tooling';
import type { PreviewConnectionState, PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

export interface AssetNode {
  id: string;
  label: string;
  type: 'room' | 'object' | 'verb' | 'action' | 'map' | 'dialogue' | 'cutscene' | 'script' | 'asset' | 'test' | 'folder';
  collection?: string;
  entityId?: string;
  children?: AssetNode[];
}

export interface TimelineEntry {
  id: string;
  source: 'preview' | 'playback' | 'export' | 'validation' | 'command';
  message: string;
  detail?: unknown;
}

const ENTITY_GROUPS: Array<{ key: string; label: string; type: AssetNode['type'] }> = [
  { key: 'room', label: 'Rooms', type: 'room' },
  { key: 'object', label: 'Objects', type: 'object' },
  { key: 'verb', label: 'Verbs', type: 'verb' },
  { key: 'action', label: 'Actions', type: 'action' },
  { key: 'map', label: 'Maps', type: 'map' },
  { key: 'dialogue', label: 'Dialogues', type: 'dialogue' },
  { key: 'cutscene', label: 'Cutscenes', type: 'cutscene' },
  { key: 'script', label: 'Scripts', type: 'script' },
  { key: 'asset', label: 'Assets', type: 'asset' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildProjectTree(project: unknown, tests: PlaybackTestSummary[] = []): AssetNode[] {
  if (!isRecord(project)) return [];
  const nodes: AssetNode[] = [];
  for (const group of ENTITY_GROUPS) {
    const collection = project[group.key];
    const children: AssetNode[] = [];
    if (isRecord(collection)) {
      for (const entityId of Object.keys(collection).sort()) {
        children.push({
          id: `${group.key}:${entityId}`,
          label: entityId,
          type: group.type,
          collection: group.key,
          entityId,
        });
      }
    }
    nodes.push({
      id: group.key,
      label: group.label,
      type: 'folder',
      collection: group.key,
      children,
    });
  }
  nodes.push({
    id: 'tests',
    label: 'Tests',
    type: 'folder',
    collection: 'tests',
    children: tests.map((test) => ({
      id: `tests:${test.id}`,
      label: `${test.id} (${test.steps})`,
      type: 'test',
      collection: 'tests',
      entityId: test.id,
    })),
  });
  return nodes;
}

interface WorkspaceState {
  projectPath: string | null;
  projectFilePath: string | null;
  project: unknown | null;
  diagnostics: ToolDiagnostic[];
  playbackTests: PlaybackTestSummary[];
  selectedAssetId: string | null;
  previewPosition: PreviewPosition;
  previewRunning: boolean;
  previewConnectionState: PreviewConnectionState;
  selectedRuntimeObjectId: string | null;
  lastPreviewEvent: PreviewToEditorMessage | null;
  timeline: TimelineEntry[];
  lastPlaybackReport: unknown | null;
  lastExportResult: unknown | null;
  statusMessage: string;
  sidebarExpanded: boolean;
  inspectorVisible: boolean;
  setProjectPath: (path: string | null) => void;
  setProjectFilePath: (path: string | null) => void;
  setProject: (project: unknown | null) => void;
  setDiagnostics: (diagnostics: ToolDiagnostic[]) => void;
  setPlaybackTests: (tests: PlaybackTestSummary[]) => void;
  setSelectedAssetId: (id: string | null) => void;
  setPreviewPosition: (position: PreviewPosition) => void;
  setPreviewRunning: (running: boolean) => void;
  setPreviewConnectionState: (state: PreviewConnectionState) => void;
  setSelectedRuntimeObjectId: (id: string | null) => void;
  setLastPreviewEvent: (event: PreviewToEditorMessage | null) => void;
  addTimelineEntry: (entry: Omit<TimelineEntry, 'id'>) => void;
  setLastPlaybackReport: (report: unknown | null) => void;
  setLastExportResult: (result: unknown | null) => void;
  setStatusMessage: (message: string) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setInspectorVisible: (visible: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  projectPath: null,
  projectFilePath: null,
  project: null,
  diagnostics: [],
  playbackTests: [],
  selectedAssetId: null,
  previewPosition: { x: 0.5, y: 0.5 },
  previewRunning: true,
  previewConnectionState: 'disconnected',
  selectedRuntimeObjectId: null,
  lastPreviewEvent: null,
  timeline: [],
  lastPlaybackReport: null,
  lastExportResult: null,
  statusMessage: 'Preview disconnected',
  sidebarExpanded: true,
  inspectorVisible: true,
  setProjectPath: (projectPath) => set({ projectPath }),
  setProjectFilePath: (projectFilePath) => set({ projectFilePath }),
  setProject: (project) => set({ project }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setPlaybackTests: (playbackTests) => set({ playbackTests }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setPreviewPosition: (previewPosition) => set({ previewPosition }),
  setPreviewRunning: (previewRunning) => set({ previewRunning }),
  setPreviewConnectionState: (previewConnectionState) => set({ previewConnectionState }),
  setSelectedRuntimeObjectId: (selectedRuntimeObjectId) => set({ selectedRuntimeObjectId }),
  setLastPreviewEvent: (lastPreviewEvent) => set({ lastPreviewEvent }),
  addTimelineEntry: (entry) =>
    set((state) => ({
      timeline: [
        { ...entry, id: `${Date.now()}-${state.timeline.length}` },
        ...state.timeline,
      ].slice(0, 100),
    })),
  setLastPlaybackReport: (lastPlaybackReport) => set({ lastPlaybackReport }),
  setLastExportResult: (lastExportResult) => set({ lastExportResult }),
  setStatusMessage: (statusMessage) => set({ statusMessage }),
  setSidebarExpanded: (sidebarExpanded) => set({ sidebarExpanded }),
  setInspectorVisible: (inspectorVisible) => set({ inspectorVisible }),
}));
