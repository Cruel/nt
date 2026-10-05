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
import type {
  DevtoolsConsoleRecord,
  DevtoolsTraceRecord,
  PreviewConnectionState,
} from '../../shared/preview-protocol';

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
    | 'animation'
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
  category?: string;
  sequence?: string;
  globalSequence?: string;
  hostGeneration?: string | null;
  runtimeGeneration?: string | null;
  frame?: string;
  source?: DevtoolsConsoleRecord['source'];
  generationMarker?: boolean;
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
  runtimeConsoleLostRecordCount: string | null;
  runtimeConsoleClearHandler: (() => Promise<void>) | null;
  runtimeTrace: DevtoolsTraceRecord[];
  runtimeTraceLostRecordCount: string | null;
  runtimeTraceClearHandler: (() => Promise<void>) | null;
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
  addDevtoolsConsoleRecords: (records: DevtoolsConsoleRecord[], lostRecordCount?: string) => void;
  clearRuntimeEvents: () => void;
  setRuntimeConsoleClearHandler: (handler: (() => Promise<void>) | null) => void;
  addDevtoolsTraceRecords: (records: DevtoolsTraceRecord[], lostRecordCount?: string) => void;
  clearRuntimeTrace: () => void;
  setRuntimeTraceClearHandler: (handler: (() => Promise<void>) | null) => void;
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
  runtimeConsoleLostRecordCount: null,
  runtimeConsoleClearHandler: null,
  runtimeTrace: [],
  runtimeTraceLostRecordCount: null,
  runtimeTraceClearHandler: null,
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
        ].slice(0, 1000),
      };
    }),
  addDevtoolsConsoleRecords: (records, lostRecordCount) =>
    set((state) => {
      const existing = new Set(state.runtimeEvents.map((entry) => entry.sequence).filter(Boolean));
      const appended = records
        .filter((record) => !existing.has(record.sequence))
        .map((record) => ({
          id: `console:${record.sequence}`,
          timestamp: Date.now(),
          label: record.message,
          severity: record.severity,
          category: record.category,
          sequence: record.sequence,
          globalSequence: record.globalSequence,
          hostGeneration: record.hostGeneration,
          runtimeGeneration: record.runtimeGeneration,
          frame: record.frame,
          source: record.source,
          generationMarker: record.generationMarker,
        }))
        .reverse();
      return {
        runtimeEvents: [...appended, ...state.runtimeEvents].slice(0, 1000),
        runtimeConsoleLostRecordCount:
          lostRecordCount && lostRecordCount !== '0'
            ? lostRecordCount
            : state.runtimeConsoleLostRecordCount,
      };
    }),
  clearRuntimeEvents: () => set({ runtimeEvents: [], runtimeConsoleLostRecordCount: null }),
  setRuntimeConsoleClearHandler: (runtimeConsoleClearHandler) =>
    set({ runtimeConsoleClearHandler }),
  addDevtoolsTraceRecords: (records, lostRecordCount) =>
    set((state) => {
      const incomingFirstSequences = new Set(records.map((record) => record.firstSequence));
      const retained = state.runtimeTrace.filter(
        (record) => !incomingFirstSequences.has(record.firstSequence),
      );
      return {
        runtimeTrace: [...records.slice().reverse(), ...retained].slice(0, 2000),
        runtimeTraceLostRecordCount:
          lostRecordCount && lostRecordCount !== '0'
            ? lostRecordCount
            : state.runtimeTraceLostRecordCount,
      };
    }),
  clearRuntimeTrace: () => set({ runtimeTrace: [], runtimeTraceLostRecordCount: null }),
  setRuntimeTraceClearHandler: (runtimeTraceClearHandler) => set({ runtimeTraceClearHandler }),
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
