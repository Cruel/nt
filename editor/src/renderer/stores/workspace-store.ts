import { create } from 'zustand';
import {
  authoringCollectionKeys,
  authoringCollectionMetadata,
} from '../../shared/project-schema/authoring-collections';
import {
  isAuthoringProject,
  type AuthoringProject,
} from '../../shared/project-schema/authoring-project';
import type { ToolDiagnostic, PlaybackTestSummary } from '../../shared/editor-tooling';
import type { PreviewConnectionState, PreviewPosition, PreviewToEditorMessage } from '../../shared/preview-protocol';

export interface AssetNode {
  id: string;
  label: string;
  type:
    | 'room'
    | 'object'
    | 'verb'
    | 'action'
    | 'map'
    | 'dialogue'
    | 'cutscene'
    | 'script'
    | 'asset'
    | 'variable'
    | 'shader'
    | 'material'
    | 'layout'
    | 'character'
    | 'scene'
    | 'test'
    | 'folder';
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

export function buildAuthoringProjectTree(project: AuthoringProject): AssetNode[] {
  return authoringCollectionKeys.map((collection) => {
    const metadata = authoringCollectionMetadata[collection];
    const children = Object.entries(project[collection])
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([entityId, record]) => ({
        id: `${collection}:${entityId}`,
        label: record.label || entityId,
        type: metadata.nodeType,
        collection,
        entityId,
      }));

    return {
      id: collection,
      label: metadata.label,
      type: 'folder',
      collection,
      children,
    };
  });
}

export function buildProjectTree(project: unknown, _tests: PlaybackTestSummary[] = []): AssetNode[] {
  if (!isAuthoringProject(project)) return [];
  return buildAuthoringProjectTree(project);
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
