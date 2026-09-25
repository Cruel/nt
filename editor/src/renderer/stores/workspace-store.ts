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
import type { PreviewConnectionState } from '../../shared/preview-protocol';

export interface AssetNode {
  id: string;
  label: string;
  type:
    | 'room'
    | 'interactable'
    | 'verb'
    | 'interaction'
    | 'map'
    | 'dialogue'
    | 'cutscene'
    | 'script'
    | 'asset'
    | 'variable'
    | 'material'
    | 'layout'
    | 'archetype'
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

export interface RuntimeEventEntry {
  id: string;
  timestamp: number;
  label: string;
  detail?: string;
  severity: 'info' | 'warning' | 'error';
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

export function buildProjectTree(
  project: unknown,
  _tests: PlaybackTestSummary[] = [],
): AssetNode[] {
  if (!isAuthoringProject(project)) return [];
  return buildAuthoringProjectTree(project);
}

interface WorkspaceState {
  projectPath: string | null;
  projectFilePath: string | null;
  project: unknown;
  diagnostics: ToolDiagnostic[];
  playbackTests: PlaybackTestSummary[];
  selectedAssetId: string | null;
  previewConnectionState: PreviewConnectionState;
  selectedRuntimeObjectId: string | null;
  runtimeEvents: RuntimeEventEntry[];
  timeline: TimelineEntry[];
  lastPlaybackReport: unknown;
  lastExportResult: unknown;
  statusMessage: string;
  sidebarExpanded: boolean;
  sidebarWidth: number;
  inspectorVisible: boolean;
  setProjectPath: (path: string | null) => void;
  setProjectFilePath: (path: string | null) => void;
  setProject: (project: unknown) => void;
  setDiagnostics: (diagnostics: ToolDiagnostic[]) => void;
  setPlaybackTests: (tests: PlaybackTestSummary[]) => void;
  setSelectedAssetId: (id: string | null) => void;
  setPreviewConnectionState: (state: PreviewConnectionState) => void;
  setSelectedRuntimeObjectId: (id: string | null) => void;
  addRuntimeEvent: (event: Omit<RuntimeEventEntry, 'id' | 'timestamp'>) => void;
  clearRuntimeEvents: () => void;
  addTimelineEntry: (entry: Omit<TimelineEntry, 'id'>) => void;
  setLastPlaybackReport: (report: unknown) => void;
  setLastExportResult: (result: unknown) => void;
  setStatusMessage: (message: string) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setInspectorVisible: (visible: boolean) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  projectPath: null,
  projectFilePath: null,
  project: null,
  diagnostics: [],
  playbackTests: [],
  selectedAssetId: null,
  previewConnectionState: 'disconnected',
  selectedRuntimeObjectId: null,
  runtimeEvents: [],
  timeline: [],
  lastPlaybackReport: null,
  lastExportResult: null,
  statusMessage: 'Preview disconnected',
  sidebarExpanded: true,
  sidebarWidth: 256,
  inspectorVisible: true,
  setProjectPath: (projectPath) => set({ projectPath }),
  setProjectFilePath: (projectFilePath) => set({ projectFilePath }),
  setProject: (project) => set({ project }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setPlaybackTests: (playbackTests) => set({ playbackTests }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setPreviewConnectionState: (previewConnectionState) => set({ previewConnectionState }),
  setSelectedRuntimeObjectId: (selectedRuntimeObjectId) => set({ selectedRuntimeObjectId }),
  addRuntimeEvent: (event) =>
    set((state) => {
      const timestamp = Date.now();
      return {
        runtimeEvents: [
          { ...event, id: `${timestamp}-${state.runtimeEvents.length}`, timestamp },
          ...state.runtimeEvents,
        ].slice(0, 100),
      };
    }),
  clearRuntimeEvents: () => set({ runtimeEvents: [] }),
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
  setSidebarWidth: (sidebarWidth) =>
    set({ sidebarWidth: Math.min(420, Math.max(180, sidebarWidth)) }),
  setInspectorVisible: (inspectorVisible) => set({ inspectorVisible }),
}));
