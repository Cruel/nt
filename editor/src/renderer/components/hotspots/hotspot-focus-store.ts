import { create } from 'zustand';
import { z } from 'zod';
import { useCommandStore } from '@/commands/command-store';
import type { HotspotTool } from '@/components/image-stage/hotspot-view-state';
import type { ImageStageCamera } from '@/components/image-stage/image-stage-transforms';
import { editorI18n } from '@/i18n';
import { useProjectStore } from '@/project/project-store';
import { toJsonValue, type JsonValue } from '@/project/json-value';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { updateInteractableHotspots, updateRoomHotspots } from '@/project/hotspot-operations';
import { useDraftDirtyStore } from '@/workbench/draft-dirty-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { useWorkspaceStore } from '@/stores/workspace-store';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  imageAssetMetadataSchema,
  parseAssetData,
} from '../../../shared/project-schema/authoring-assets';
import type { ImageNormalizedRect } from '../../../shared/project-schema/authoring-hotspots';
import {
  interactableHotspotBehaviorSchema,
  interactableHotspotsSchema,
  parseInteractableData,
} from '../../../shared/project-schema/authoring-interactables';
import {
  parseRoomData,
  roomHotspotDataSchema,
} from '../../../shared/project-schema/authoring-rooms';
import type { EditableHotspot } from './hotspot-types';
import {
  addHotspotGeometry,
  createHotspotFocusHistory,
  deleteHotspotGeometry,
  hotspotGeometryChanged,
  mergeHotspotFocusGeometry,
  redoHotspotGeometry,
  setHotspotGeometryBounds,
  undoHotspotGeometry,
  type HotspotFocusHistory,
} from './hotspot-focus-session';

export type HotspotFocusOwnerKind = 'room' | 'interactable';
export type HotspotFocusMode = 'rectangles' | 'sprite-alpha';

const hotspotFocusSourceIdentitySchema = z
  .object({
    sourcePath: z.string().min(1),
    contentHash: z.string().nullable(),
    byteSize: z.number().nonnegative().nullable(),
    importedAt: z.string().nullable(),
    thumbnailRevision: z.string().nullable(),
    imageMetadata: imageAssetMetadataSchema,
  })
  .strict();
export type HotspotFocusSourceIdentity = z.infer<typeof hotspotFocusSourceIdentitySchema>;

export interface HotspotFocusSession {
  tabId: string;
  ownerKind: HotspotFocusOwnerKind;
  ownerId: string;
  assetId: string | null;
  sourceIdentity: HotspotFocusSourceIdentity | null;
  mode: HotspotFocusMode;
  initialItems: readonly EditableHotspot[];
  history: HotspotFocusHistory;
  selectedHotspotId: string | null;
  tool: HotspotTool;
  camera: ImageStageCamera;
  cameraInitialized: boolean;
}

interface RememberedFocusView {
  camera: ImageStageCamera;
  cameraInitialized: boolean;
}

interface StartHotspotFocusSession {
  tabId: string;
  ownerKind: HotspotFocusOwnerKind;
  ownerId: string;
  assetId: string | null;
  mode: HotspotFocusMode;
  items: readonly EditableHotspot[];
  selectedHotspotId?: string | null;
}

interface HotspotFocusStoreState {
  sessionsByTabId: Record<string, HotspotFocusSession>;
  rememberedViewsByTarget: Record<string, RememberedFocusView>;
  start: (input: StartHotspotFocusSession) => void;
  restore: (input: StartHotspotFocusSession) => boolean;
  setSelection: (tabId: string, selectedHotspotId: string | null) => void;
  setTool: (tabId: string, tool: HotspotTool) => void;
  setCamera: (tabId: string, camera: ImageStageCamera) => void;
  initializeCamera: (tabId: string, camera: ImageStageCamera) => void;
  add: (tabId: string, hotspot: EditableHotspot) => void;
  setBounds: (tabId: string, hotspotId: string, bounds: ImageNormalizedRect) => void;
  delete: (tabId: string, hotspotId: string) => void;
  undo: (tabId: string) => void;
  redo: (tabId: string) => void;
  commit: (tabId: string) => boolean;
  discard: (tabId: string) => boolean;
  reset: () => void;
}

export const HOTSPOT_FOCUS_DRAFT_SCHEMA = 'noveltea.editor.draft.hotspot-focus';
const HOTSPOT_FOCUS_DRAFT_VERSION = 1;

const draftKey = (tabId: string) => `hotspot-focus:${tabId}`;
const targetKey = (session: Pick<HotspotFocusSession, 'ownerKind' | 'ownerId' | 'assetId'>) =>
  `${session.ownerKind}:${session.ownerId}:${session.assetId ?? 'none'}`;

function sourceIdentityForAsset(
  document: ReturnType<typeof useProjectStore.getState>['document'],
  assetId: string | null,
): HotspotFocusSourceIdentity | null {
  if (!assetId || !isAuthoringProject(document)) return null;
  const data = parseAssetData(document.assets[assetId]?.data);
  if (data?.kind !== 'image' || !data.imageMetadata) return null;
  return {
    sourcePath: data.source.path,
    contentHash: data.contentHash ?? null,
    byteSize: data.byteSize ?? null,
    importedAt: data.importedAt ?? null,
    thumbnailRevision: data.preview?.thumbnailRevision ?? null,
    imageMetadata: {
      width: data.imageMetadata.width,
      height: data.imageMetadata.height,
      hasAlpha: data.imageMetadata.hasAlpha,
      orientation: data.imageMetadata.orientation,
    },
  };
}

function currentOwnerAssetId(
  document: ReturnType<typeof useProjectStore.getState>['document'],
  ownerKind: HotspotFocusOwnerKind,
  ownerId: string,
): string | null | undefined {
  if (!isAuthoringProject(document)) return undefined;
  if (ownerKind === 'room') {
    const room = parseRoomData(document.rooms[ownerId]?.data);
    return room ? (room.background.asset?.$ref.id ?? null) : undefined;
  }
  const interactable = parseInteractableData(document.interactables[ownerId]?.data);
  return interactable ? (interactable.presentation.sprite?.$ref.id ?? null) : undefined;
}

function sameSourceIdentity(
  left: HotspotFocusSourceIdentity | null,
  right: HotspotFocusSourceIdentity | null,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function syncDraftEntry(session: HotspotFocusSession | undefined) {
  if (!session) return;
  const dirty = hotspotGeometryChanged(session.initialItems, session.history.present);
  useDraftDirtyStore.getState().setDraftDirty(draftKey(session.tabId), {
    tabId: session.tabId,
    dirty,
    label: editorI18n.t('workspace:hotspots.focus.draftLabel'),
    schema: HOTSPOT_FOCUS_DRAFT_SCHEMA,
    payload: toJsonValue({
      schemaVersion: HOTSPOT_FOCUS_DRAFT_VERSION,
      ownerKind: session.ownerKind,
      ownerId: session.ownerId,
      assetId: session.assetId,
      sourceIdentity: session.sourceIdentity,
      mode: session.mode,
      initialItems: session.initialItems,
      currentItems: session.history.present,
      selectedHotspotId: session.selectedHotspotId,
      tool: session.tool,
      camera: session.camera,
      cameraInitialized: session.cameraInitialized,
    }),
    apply: () => useHotspotFocusStore.getState().commit(session.tabId),
    discard: () => useHotspotFocusStore.getState().discard(session.tabId),
  });
}

function parseDraftPayload(value: JsonValue | undefined) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, JsonValue>;
  if (payload.schemaVersion !== HOTSPOT_FOCUS_DRAFT_VERSION) return null;
  if (payload.ownerKind !== 'room' && payload.ownerKind !== 'interactable') return null;
  if (typeof payload.ownerId !== 'string') return null;
  if (payload.assetId !== null && typeof payload.assetId !== 'string') return null;
  const parsedSourceIdentity = hotspotFocusSourceIdentitySchema
    .nullable()
    .safeParse(payload.sourceIdentity);
  if (!parsedSourceIdentity.success) return null;
  const sourceIdentity = parsedSourceIdentity.data;
  if (payload.mode !== 'rectangles' && payload.mode !== 'sprite-alpha') return null;
  if (!Array.isArray(payload.initialItems) || !Array.isArray(payload.currentItems)) return null;
  if (payload.selectedHotspotId !== null && typeof payload.selectedHotspotId !== 'string')
    return null;
  if (payload.tool !== 'select' && payload.tool !== 'draw-rect' && payload.tool !== 'pan')
    return null;
  const camera = payload.camera;
  if (!camera || typeof camera !== 'object' || Array.isArray(camera)) return null;
  const pan = camera.pan;
  if (!pan || typeof pan !== 'object' || Array.isArray(pan)) return null;
  if (
    typeof camera.zoom !== 'number' ||
    typeof pan.x !== 'number' ||
    typeof pan.y !== 'number' ||
    typeof payload.cameraInitialized !== 'boolean'
  )
    return null;
  const parseItems = (items: JsonValue[]): readonly EditableHotspot[] | null => {
    if (payload.ownerKind === 'room') {
      if (payload.mode !== 'rectangles') return null;
      const parsed = roomHotspotDataSchema.array().safeParse(items);
      return parsed.success ? parsed.data : null;
    }
    if (payload.mode === 'rectangles') {
      const parsed = interactableHotspotsSchema.safeParse({ kind: 'custom', hotspots: items });
      return parsed.success && parsed.data.kind === 'custom' ? parsed.data.hotspots : null;
    }
    const parsed = interactableHotspotBehaviorSchema.array().safeParse(items);
    return parsed.success ? parsed.data : null;
  };
  const initialItems = parseItems(payload.initialItems);
  const currentItems = parseItems(payload.currentItems);
  if (!initialItems || !currentItems) return null;
  return {
    ownerKind: payload.ownerKind,
    ownerId: payload.ownerId,
    assetId: payload.assetId as string | null,
    sourceIdentity,
    mode: payload.mode,
    initialItems,
    currentItems,
    selectedHotspotId: payload.selectedHotspotId as string | null,
    tool: payload.tool,
    camera: {
      zoom: camera.zoom,
      pan: { x: pan.x, y: pan.y },
    },
    cameraInitialized: payload.cameraInitialized,
  } satisfies Omit<HotspotFocusSession, 'tabId' | 'history'> & {
    currentItems: readonly EditableHotspot[];
  };
}

function closeSession(tabId: string, session: HotspotFocusSession | undefined) {
  if (session) {
    useHotspotFocusStore.setState((state) => ({
      sessionsByTabId: Object.fromEntries(
        Object.entries(state.sessionsByTabId).filter(([key]) => key !== tabId),
      ),
      rememberedViewsByTarget: {
        ...state.rememberedViewsByTarget,
        [targetKey(session)]: {
          camera: session.camera,
          cameraInitialized: session.cameraInitialized,
        },
      },
    }));
  }
  useDraftDirtyStore.getState().clearDraftDirty(draftKey(tabId));
}

export const useHotspotFocusStore = create<HotspotFocusStoreState>()((set, get) => ({
  sessionsByTabId: {},
  rememberedViewsByTarget: {},
  start: (input) => {
    const existing = get().sessionsByTabId[input.tabId];
    if (
      existing &&
      existing.ownerKind === input.ownerKind &&
      existing.ownerId === input.ownerId &&
      existing.assetId === input.assetId &&
      existing.mode === input.mode
    )
      return;
    const key = `${input.ownerKind}:${input.ownerId}:${input.assetId ?? 'none'}`;
    const remembered = get().rememberedViewsByTarget[key];
    const session: HotspotFocusSession = {
      tabId: input.tabId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      assetId: input.assetId,
      sourceIdentity: sourceIdentityForAsset(useProjectStore.getState().document, input.assetId),
      mode: input.mode,
      initialItems: input.items,
      history: createHotspotFocusHistory(input.items),
      selectedHotspotId: input.selectedHotspotId ?? null,
      tool: 'select',
      camera: remembered?.camera ?? { zoom: 1, pan: { x: 0, y: 0 } },
      cameraInitialized: remembered?.cameraInitialized ?? false,
    };
    set((state) => ({
      sessionsByTabId: { ...state.sessionsByTabId, [input.tabId]: session },
    }));
    syncDraftEntry(session);
  },
  restore: (input) => {
    if (get().sessionsByTabId[input.tabId]) return true;
    const drafts = useDraftDirtyStore.getState();
    const entry = drafts.entriesByKey[draftKey(input.tabId)];
    if (!entry || entry.schema !== HOTSPOT_FOCUS_DRAFT_SCHEMA) return false;
    const payload = parseDraftPayload(entry.payload);
    if (
      !payload ||
      payload.ownerKind !== input.ownerKind ||
      payload.ownerId !== input.ownerId ||
      payload.assetId !== input.assetId ||
      payload.mode !== input.mode
    ) {
      drafts.clearDraftDirty(draftKey(input.tabId));
      return false;
    }
    const session: HotspotFocusSession = {
      tabId: input.tabId,
      ownerKind: payload.ownerKind,
      ownerId: payload.ownerId,
      assetId: payload.assetId,
      sourceIdentity: payload.sourceIdentity,
      mode: payload.mode,
      initialItems: payload.initialItems,
      history: hotspotGeometryChanged(payload.initialItems, payload.currentItems)
        ? { past: [payload.initialItems], present: payload.currentItems, future: [] }
        : createHotspotFocusHistory(payload.initialItems),
      selectedHotspotId: payload.selectedHotspotId,
      tool: payload.tool,
      camera: payload.camera,
      cameraInitialized: payload.cameraInitialized,
    };
    set((state) => ({
      sessionsByTabId: { ...state.sessionsByTabId, [input.tabId]: session },
    }));
    syncDraftEntry(session);
    return true;
  },
  setSelection: (tabId, selectedHotspotId) =>
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      return session
        ? {
            sessionsByTabId: {
              ...state.sessionsByTabId,
              [tabId]: { ...session, selectedHotspotId },
            },
          }
        : state;
    }),
  setTool: (tabId, tool) =>
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      return session
        ? { sessionsByTabId: { ...state.sessionsByTabId, [tabId]: { ...session, tool } } }
        : state;
    }),
  setCamera: (tabId, camera) =>
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session) return state;
      const next = { ...session, camera, cameraInitialized: true };
      return {
        sessionsByTabId: { ...state.sessionsByTabId, [tabId]: next },
        rememberedViewsByTarget: {
          ...state.rememberedViewsByTarget,
          [targetKey(session)]: { camera, cameraInitialized: true },
        },
      };
    }),
  initializeCamera: (tabId, camera) =>
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session || session.cameraInitialized) return state;
      const next = { ...session, camera, cameraInitialized: true };
      return {
        sessionsByTabId: { ...state.sessionsByTabId, [tabId]: next },
        rememberedViewsByTarget: {
          ...state.rememberedViewsByTarget,
          [targetKey(session)]: { camera, cameraInitialized: true },
        },
      };
    }),
  add: (tabId, hotspot) => {
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session || session.mode !== 'rectangles') return state;
      const next = {
        ...session,
        history: addHotspotGeometry(session.history, hotspot),
        selectedHotspotId: hotspot.id,
      };
      return { sessionsByTabId: { ...state.sessionsByTabId, [tabId]: next } };
    });
    syncDraftEntry(get().sessionsByTabId[tabId]);
  },
  setBounds: (tabId, hotspotId, bounds) => {
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session || session.mode !== 'rectangles') return state;
      const next = {
        ...session,
        history: setHotspotGeometryBounds(session.history, hotspotId, bounds),
      };
      return { sessionsByTabId: { ...state.sessionsByTabId, [tabId]: next } };
    });
    syncDraftEntry(get().sessionsByTabId[tabId]);
  },
  delete: (tabId, hotspotId) => {
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session || session.mode !== 'rectangles') return state;
      const history = deleteHotspotGeometry(session.history, hotspotId);
      const next = {
        ...session,
        history,
        selectedHotspotId:
          session.selectedHotspotId === hotspotId ? null : session.selectedHotspotId,
      };
      return { sessionsByTabId: { ...state.sessionsByTabId, [tabId]: next } };
    });
    syncDraftEntry(get().sessionsByTabId[tabId]);
  },
  undo: (tabId) => {
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session) return state;
      const history = undoHotspotGeometry(session.history);
      const selectedHotspotId = history.present.some(
        (item) => item.id === session.selectedHotspotId,
      )
        ? session.selectedHotspotId
        : null;
      return {
        sessionsByTabId: {
          ...state.sessionsByTabId,
          [tabId]: { ...session, history, selectedHotspotId },
        },
      };
    });
    syncDraftEntry(get().sessionsByTabId[tabId]);
  },
  redo: (tabId) => {
    set((state) => {
      const session = state.sessionsByTabId[tabId];
      if (!session) return state;
      return {
        sessionsByTabId: {
          ...state.sessionsByTabId,
          [tabId]: { ...session, history: redoHotspotGeometry(session.history) },
        },
      };
    });
    syncDraftEntry(get().sessionsByTabId[tabId]);
  },
  commit: (tabId) => {
    const session = get().sessionsByTabId[tabId];
    if (!session) return true;
    if (!hotspotGeometryChanged(session.initialItems, session.history.present)) {
      closeSession(tabId, session);
      return true;
    }
    const document = useProjectStore.getState().document;
    if (!isAuthoringProject(document)) return false;
    const latestOwnerAssetId = currentOwnerAssetId(document, session.ownerKind, session.ownerId);
    if (
      latestOwnerAssetId === undefined ||
      latestOwnerAssetId !== session.assetId ||
      !sameSourceIdentity(
        sourceIdentityForAsset(document, latestOwnerAssetId),
        session.sourceIdentity,
      )
    ) {
      useWorkspaceStore
        .getState()
        .setStatusMessage(editorI18n.t('workspace:hotspots.focus.staleSourceStatus'));
      return false;
    }
    const operation =
      session.ownerKind === 'room'
        ? updateRoomHotspots(document, session.ownerId, (data) => {
            const hotspots = mergeHotspotFocusGeometry(
              session.initialItems,
              session.history.present,
              data.hotspots,
            );
            return hotspots ? { ...data, hotspots: hotspots as typeof data.hotspots } : null;
          })
        : updateInteractableHotspots(document, session.ownerId, (data) =>
            data.presentation.hotspots.kind !== 'custom'
              ? null
              : (() => {
                  const hotspots = mergeHotspotFocusGeometry(
                    session.initialItems,
                    session.history.present,
                    data.presentation.hotspots.hotspots,
                  );
                  return hotspots
                    ? {
                        ...data,
                        presentation: {
                          ...data.presentation,
                          hotspots: {
                            kind: 'custom' as const,
                            hotspots: hotspots as typeof data.presentation.hotspots.hotspots,
                          },
                        },
                      }
                    : null;
                })(),
          );
    if (operation.diagnostics?.some((item) => item.severity === 'error')) return false;
    const result = useCommandStore.getState().executeCommand({
      type: 'project.applyPatch',
      label:
        session.ownerKind === 'room'
          ? editorI18n.t('workspace:hotspots.focus.roomCommandLabel')
          : editorI18n.t('workspace:hotspots.focus.interactableCommandLabel'),
      payload: operation.patches,
      originSaveUnitId: recordSaveUnitId(
        session.ownerKind === 'room' ? 'rooms' : 'interactables',
        session.ownerId,
      ),
      persistencePolicy: 'manual-save',
    });
    if (!result.ok) return false;
    closeSession(tabId, session);
    return true;
  },
  discard: (tabId) => {
    closeSession(tabId, get().sessionsByTabId[tabId]);
    return true;
  },
  reset: () => {
    const tabIds = Object.keys(get().sessionsByTabId);
    set({ sessionsByTabId: {}, rememberedViewsByTarget: {} });
    const drafts = useDraftDirtyStore.getState();
    for (const tabId of tabIds) drafts.clearDraftDirty(draftKey(tabId));
  },
}));

useProjectStore.subscribe((state, previousState) => {
  if (state.projectInstanceId !== previousState.projectInstanceId)
    useHotspotFocusStore.getState().reset();
});

useWorkbenchStore.subscribe((state, previousState) => {
  const focus = useHotspotFocusStore.getState();
  for (const tabId of Object.keys(focus.sessionsByTabId)) {
    if (!previousState.tabsById[tabId] || state.tabsById[tabId]) continue;
    const dirty = useDraftDirtyStore.getState().entriesByKey[draftKey(tabId)]?.dirty === true;
    if (!dirty) focus.discard(tabId);
  }
});
