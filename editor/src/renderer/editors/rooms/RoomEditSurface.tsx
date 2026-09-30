import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthoringWebGlGroupRenderer } from '@/authoring-renderer/authoring-webgl-provider';
import { AuthoringWebGlShaderProgramError } from '@/authoring-renderer/authoring-webgl-backend';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type {
  AuthoringWebGlMaterialDraw,
  AuthoringWebGlMaterialResource,
  AuthoringWebGlTextureResource,
} from '@/authoring-renderer/authoring-webgl-renderer';
import {
  useMaterialPreviewProjectGeneration,
  useMaterialPreviewProjectResources,
} from '@/material-preview/material-preview-provider';
import type { MaterialPreviewProjectResources } from '@/material-preview/material-preview-resources';
import type { MaterialPreviewResource } from '@/material-preview/material-preview-resources';
import type { MaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';
import {
  resizeRoomSelectionData,
  translateRoomSelectionData,
} from '../../project/room-placement-operations';
import {
  projectRoomEditRect,
  resolveRoomEditProjection,
  resolveRoomEditProjectionPair,
  type RoomEditProjectedRect,
  type RoomEditProjection,
  type RoomEditResolvedVisibility,
  type RoomEditUvRect,
} from './room-edit-projection';
import {
  clampRoomEditNavigation,
  panRoomEditNavigation,
  ROOM_EDIT_FIT_NAVIGATION,
  zoomRoomEditNavigationAtPoint,
  type RoomEditNavigation,
} from './room-edit-navigation';
import {
  candidateForRoomEditSelection,
  defaultRoomEditSelectionCandidate,
  hitTestRoomEditCandidates,
  marqueeRoomEditSelections,
  ordinaryRoomEditSelectionCandidate,
  roomEditSelectionCandidates,
  roomEditSelectionCapabilities,
  roomEditSelectionKey,
  topmostRoomEditOccupantCandidate,
  type RoomEditSelection,
  type RoomEditSelectionCandidate,
} from './room-edit-selection';

type RoomEditResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

const roomEditResizeCursorClass: Record<RoomEditResizeHandle, string> = {
  nw: 'cursor-nw-resize',
  ne: 'cursor-ne-resize',
  sw: 'cursor-sw-resize',
  se: 'cursor-se-resize',
};

type RoomEditDirectGesture =
  | {
      kind: 'candidate';
      pointerId: number;
      start: { x: number; y: number };
      current: { x: number; y: number };
      selection: RoomEditSelection[];
      candidate: RoomEditSelectionCandidate;
      additive: boolean;
      dragging: boolean;
    }
  | {
      kind: 'marquee';
      pointerId: number;
      start: { x: number; y: number };
      current: { x: number; y: number };
      additive: boolean;
      dragging: boolean;
    }
  | {
      kind: 'resize';
      pointerId: number;
      start: { x: number; y: number };
      current: { x: number; y: number };
      selection: RoomEditSelection;
      handle: RoomEditResizeHandle;
      bounds: { x: number; y: number; width: number; height: number };
    };

interface PreparedVisual {
  texture: AuthoringWebGlTextureResource | null;
  material: AuthoringWebGlMaterialResource;
  textureOverrides: Readonly<Record<string, AuthoringWebGlTextureResource>>;
}

interface PreparedRoomEditScene {
  background: PreparedVisual | null;
  worldDraws: ReadonlyMap<string, PreparedVisual>;
}

const fallbackEngine2dMaterial: AuthoringWebGlMaterialResource = {
  materialId: '__room-edit-default-engine-2d',
  resolved: { role: 'engine-2d', textures: {}, parameters: {} },
  vertexShaderSource: null,
  fragmentShaderSource: null,
  textures: {},
};

const whiteTexture: AuthoringWebGlTextureResource = {
  key: '__room-edit-white',
  image: null,
  sampling: 'linear',
  fallbackColor: [1, 1, 1, 1],
};

function materialResource(resource: MaterialPreviewResource): AuthoringWebGlMaterialResource {
  return {
    materialId: resource.materialId,
    resolved: resource.resolved,
    vertexShaderSource: resource.vertexShaderSource,
    fragmentShaderSource: resource.fragmentShaderSource,
    textures: resource.textures,
  };
}

function colorChannels(value: string | null): readonly [number, number, number, number] {
  if (!value) return [0, 0, 0, 0];
  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/iu.exec(value.trim());
  if (!match) return [0, 0, 0, 0];
  const hex = match[1]!;
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
    alpha,
  ];
}

function modelViewProjection(
  projected: RoomEditProjectedRect,
  viewport: { width: number; height: number },
) {
  const radians = (projected.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const rectCenterX = projected.rect.x + projected.rect.width * 0.5;
  const rectCenterY = projected.rect.y + projected.rect.height * 0.5;
  const viewportCenterX = viewport.width * 0.5;
  const viewportCenterY = viewport.height * 0.5;
  const localCenterX = rectCenterX - viewportCenterX;
  const localCenterY = rectCenterY - viewportCenterY;
  const rotatedCenterX = viewportCenterX + localCenterX * cosine - localCenterY * sine;
  const rotatedCenterY = viewportCenterY + localCenterX * sine + localCenterY * cosine;
  const translateX = (rotatedCenterX / viewport.width) * 2 - 1;
  const translateY = 1 - (rotatedCenterY / viewport.height) * 2;
  return new Float32Array([
    (cosine * projected.rect.width) / viewport.width,
    (-sine * projected.rect.width) / viewport.height,
    0,
    0,
    (sine * projected.rect.height) / viewport.width,
    (cosine * projected.rect.height) / viewport.height,
    0,
    0,
    0,
    0,
    1,
    0,
    translateX,
    translateY,
    0,
    1,
  ]);
}

function parameterOverrides(
  application: MaterialApplication | null,
  canonicalProjected: RoomEditProjectedRect,
  canonicalProjection: RoomEditProjection,
  timeSeconds: number,
  propertyValues?: Readonly<Record<string, unknown>>,
) {
  if (!application) return undefined;
  const result: Record<string, unknown> = {};
  for (const [name, override] of Object.entries(application.parameters)) {
    if (override.source.kind === 'literal') result[name] = override.source.value;
    else if (override.source.kind === 'property') {
      if (propertyValues && override.source.property in propertyValues)
        result[name] = propertyValues[override.source.property];
    } else if (override.source.kind === 'standard-facet') {
      switch (override.source.facet) {
        case 'paint-width':
          result[name] = canonicalProjected.rect.width;
          break;
        case 'paint-height':
          result[name] = canonicalProjected.rect.height;
          break;
        case 'viewport-width':
          result[name] = canonicalProjection.viewport.width;
          break;
        case 'viewport-height':
          result[name] = canonicalProjection.viewport.height;
          break;
        case 'camera-zoom':
          result[name] = canonicalProjection.camera.zoom;
          break;
        case 'occurrence-time':
          result[name] = timeSeconds;
          break;
      }
    }
  }
  return result;
}

function drawVisual(
  displayProjection: RoomEditProjection,
  displayProjected: RoomEditProjectedRect,
  canonicalProjection: RoomEditProjection,
  canonicalProjected: RoomEditProjectedRect,
  prepared: PreparedVisual,
  application: MaterialApplication | null,
  timeSeconds: number,
  propertyValues?: Readonly<Record<string, unknown>>,
  uv?: RoomEditUvRect,
  color?: readonly [number, number, number, number],
): AuthoringWebGlMaterialDraw {
  return {
    resource: prepared.material,
    geometry: { kind: 'quad', ...(uv ? { uv } : {}), ...(color ? { color } : {}) },
    modelViewProjection: modelViewProjection(displayProjected, displayProjection.viewport),
    parameterOverrides: parameterOverrides(
      application,
      canonicalProjected,
      canonicalProjection,
      timeSeconds,
      propertyValues,
    ),
    textureOverrides: prepared.textureOverrides,
    rendererTextures: { s_texColor: prepared.texture ?? whiteTexture },
  };
}

function colorTexture(
  color: readonly [number, number, number, number],
): AuthoringWebGlTextureResource {
  return {
    key: `__room-edit-color:${color.join(',')}`,
    image: null,
    sampling: 'linear',
    fallbackColor: color,
  };
}

async function prepareVisual(
  resources: MaterialPreviewProjectResources,
  assetId: string | null,
  application: MaterialApplication | null,
): Promise<PreparedVisual | null> {
  const [texture, material, textureOverrideEntries] = await Promise.all([
    assetId ? resources.getTexture(assetId) : Promise.resolve(null),
    application ? resources.getMaterial(application.material.$ref.id) : Promise.resolve(null),
    Promise.all(
      Object.entries(application?.textures ?? {}).map(
        async ([name, override]) =>
          [name, await resources.getTexture(override.source.$ref.id)] as const,
      ),
    ),
  ]);
  if (application && !material) return null;
  if (!texture && !material) return null;
  return {
    texture,
    material: material ? materialResource(material) : fallbackEngine2dMaterial,
    textureOverrides: Object.fromEntries(textureOverrideEntries),
  };
}

function overlayStyle(projected: RoomEditProjectedRect, projection: RoomEditProjection) {
  const centerX =
    ((projection.viewport.width * 0.5 - projected.rect.x) / projected.rect.width) * 100;
  const centerY =
    ((projection.viewport.height * 0.5 - projected.rect.y) / projected.rect.height) * 100;
  return {
    left: `${(projected.rect.x / projection.viewport.width) * 100}%`,
    top: `${(projected.rect.y / projection.viewport.height) * 100}%`,
    width: `${(projected.rect.width / projection.viewport.width) * 100}%`,
    height: `${(projected.rect.height / projection.viewport.height) * 100}%`,
    transform: `rotate(${projected.rotationDegrees}deg)`,
    transformOrigin: `${centerX}% ${centerY}%`,
  };
}

function normalizedBoundsForSelection(room: RoomData, selection: RoomEditSelection) {
  if (selection.kind === 'placement')
    return room.placements.find((item) => item.id === selection.id)?.bounds ?? null;
  if (selection.kind === 'environment')
    return room.environments.find((item) => item.id === selection.id)?.bounds ?? null;
  const placementId =
    selection.kind === 'interactable'
      ? room.interactables.find((item) => item.id === selection.id)?.placementId
      : selection.kind === 'prop'
        ? room.props.find((item) => item.id === selection.id)?.placementId
        : selection.kind === 'cast'
          ? room.cast.find((item) => item.id === selection.id)?.placementId
          : null;
  return placementId
    ? (room.placements.find((item) => item.id === placementId)?.bounds ?? null)
    : null;
}

function pointerDeltaToNormalized(
  delta: { x: number; y: number },
  projection: RoomEditProjection,
  navigation: RoomEditNavigation,
) {
  const radians = (projection.camera.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const authored = {
    x: delta.x * cosine - delta.y * sine,
    y: delta.x * sine + delta.y * cosine,
  };
  const scale = Math.max(0.000001, projection.camera.zoom * navigation.zoom);
  return {
    x: authored.x / scale / projection.viewport.width,
    y: authored.y / scale / projection.viewport.height,
  };
}

function resizeNormalizedBounds(
  bounds: { x: number; y: number; width: number; height: number },
  delta: { x: number; y: number },
  handle: RoomEditResizeHandle,
) {
  const minimum = 0.01;
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  if (handle.includes('w')) left = Math.min(right - minimum, Math.max(0, left + delta.x));
  if (handle.includes('e')) right = Math.max(left + minimum, Math.min(1, right + delta.x));
  if (handle.includes('n')) top = Math.min(bottom - minimum, Math.max(0, top + delta.y));
  if (handle.includes('s')) bottom = Math.max(top + minimum, Math.min(1, bottom + delta.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function marqueeRect(start: { x: number; y: number }, current: { x: number; y: number }) {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

function rotateProjectedPoint(
  point: { x: number; y: number },
  rotationDegrees: number,
  viewport: { width: number; height: number },
) {
  const radians = (rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const localX = point.x - centerX;
  const localY = point.y - centerY;
  return {
    x: centerX + localX * cosine - localY * sine,
    y: centerY + localX * sine + localY * cosine,
  };
}

function normalizedRoomPointFromViewport(
  point: { x: number; y: number },
  room: RoomData,
  projection: RoomEditProjection,
  navigation: RoomEditNavigation,
) {
  const projectPoint = (normalized: { x: number; y: number }) => {
    const projected = projectRoomEditRect(
      {
        x: normalized.x * projection.viewport.width,
        y: normalized.y * projection.viewport.height,
        width: 0,
        height: 0,
      },
      projection.viewport,
      room.presentationSpace,
      projection.camera,
      navigation,
    );
    return rotateProjectedPoint(
      { x: projected.rect.x, y: projected.rect.y },
      projected.rotationDegrees,
      projection.viewport,
    );
  };
  const origin = projectPoint({ x: 0, y: 0 });
  const xAxis = projectPoint({ x: 1, y: 0 });
  const yAxis = projectPoint({ x: 0, y: 1 });
  const xx = xAxis.x - origin.x;
  const xy = xAxis.y - origin.y;
  const yx = yAxis.x - origin.x;
  const yy = yAxis.y - origin.y;
  const determinant = xx * yy - yx * xy;
  if (Math.abs(determinant) < 0.000001) return null;
  const localX = point.x - origin.x;
  const localY = point.y - origin.y;
  return {
    x: Math.max(0, Math.min(1, (localX * yy - yx * localY) / determinant)),
    y: Math.max(0, Math.min(1, (xx * localY - localX * xy) / determinant)),
  };
}

function toggleRoomEditSelection(selection: readonly RoomEditSelection[], item: RoomEditSelection) {
  const key = roomEditSelectionKey(item);
  return selection.some((candidate) => roomEditSelectionKey(candidate) === key)
    ? selection.filter((candidate) => roomEditSelectionKey(candidate) !== key)
    : [...selection, item];
}

export function RoomEditSurface({
  project,
  roomId,
  room,
  referenceResolution,
  backgroundImageSize,
  roomPropertyValues,
  resolvedVisibility = null,
  navigation = ROOM_EDIT_FIT_NAVIGATION,
  onNavigationChange = () => {},
  gestureCancellationToken = 0,
  interactionEnabled = true,
  selection = [],
  onSelectionChange = () => {},
  onTranslateSelection = () => {},
  onResizeSelection = () => {},
  addActions = [],
  pendingAddActionId = null,
  onPendingAddActionCancel = () => {},
  onAddAtPoint = () => {},
  onSurfaceElementChange,
}: {
  project: AuthoringProject;
  roomId: string;
  room: RoomData;
  referenceResolution: { width: number; height: number };
  backgroundImageSize: { width: number; height: number } | null;
  roomPropertyValues: Readonly<Record<string, unknown>>;
  resolvedVisibility?: RoomEditResolvedVisibility | null;
  navigation?: RoomEditNavigation;
  onNavigationChange?: (navigation: RoomEditNavigation) => void;
  gestureCancellationToken?: number;
  interactionEnabled?: boolean;
  selection?: readonly RoomEditSelection[];
  onSelectionChange?: (selection: readonly RoomEditSelection[]) => void;
  onTranslateSelection?: (
    selection: readonly RoomEditSelection[],
    delta: { x: number; y: number },
  ) => void;
  onResizeSelection?: (
    selection: RoomEditSelection,
    bounds: { x: number; y: number; width: number; height: number },
  ) => void;
  addActions?: readonly { id: string; label: string; disabled?: boolean }[];
  pendingAddActionId?: string | null;
  onPendingAddActionCancel?: () => void;
  onAddAtPoint?: (actionId: string, point: { x: number; y: number }) => void;
  onSurfaceElementChange?: (element: HTMLDivElement | null) => void;
}) {
  const { t } = useTranslation('workspace');
  const renderer = useAuthoringWebGlGroupRenderer();
  const resources = useMaterialPreviewProjectResources();
  const resourcesGeneration = useMaterialPreviewProjectGeneration();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null);
  const navigationRef = useRef(navigation);
  const projectionRef = useRef<{
    canonical: RoomEditProjection;
    display: RoomEditProjection;
  } | null>(null);
  const panGestureRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    suppressSelectionClick: boolean;
  } | null>(null);
  const spaceHeldRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const suppressSelectionClickRef = useRef(false);
  const directGestureRef = useRef<RoomEditDirectGesture | null>(null);
  const [panning, setPanning] = useState(false);
  const [directGestureVersion, setDirectGestureVersion] = useState(0);
  const [hoveredPlacementId, setHoveredPlacementId] = useState<string | null>(null);
  const [contextCandidates, setContextCandidates] = useState<RoomEditSelectionCandidate[]>([]);
  const [contextPreviewCandidate, setContextPreviewCandidate] =
    useState<RoomEditSelectionCandidate | null>(null);
  const [contextAddPoint, setContextAddPoint] = useState<{ x: number; y: number } | null>(null);
  const [addGhostViewportPoint, setAddGhostViewportPoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [preparedScene, setPreparedScene] = useState<PreparedRoomEditScene | null>(null);
  const handleSurfaceElement = useCallback(
    (element: HTMLDivElement | null) => {
      surfaceRef.current = element;
      setSurfaceElement(element);
      onSurfaceElementChange?.(element);
    },
    [onSurfaceElementChange],
  );
  navigationRef.current = navigation;
  const canonicalSurface = useMemo(
    () =>
      projectRoomEditRect(
        { x: 0, y: 0, ...referenceResolution },
        referenceResolution,
        room.presentationSpace,
        room.presentationSpace.defaultView,
      ),
    [referenceResolution, room.presentationSpace],
  );
  const committedProjections = useMemo(
    () =>
      resolveRoomEditProjectionPair({
        project,
        roomId,
        room,
        viewport: referenceResolution,
        backgroundImageSize,
        resolvedVisibility,
        navigation,
      }),
    [
      backgroundImageSize,
      navigation,
      project,
      referenceResolution,
      resolvedVisibility,
      room,
      roomId,
    ],
  );
  const draftRoom = useMemo(() => {
    void directGestureVersion;
    const gesture = directGestureRef.current;
    if (gesture?.kind === 'candidate' && gesture.dragging) {
      const delta = pointerDeltaToNormalized(
        {
          x: gesture.current.x - gesture.start.x,
          y: gesture.current.y - gesture.start.y,
        },
        committedProjections.display,
        navigationRef.current,
      );
      return translateRoomSelectionData(room, gesture.selection, delta) ?? room;
    }
    if (gesture?.kind === 'resize') {
      const delta = pointerDeltaToNormalized(
        {
          x: gesture.current.x - gesture.start.x,
          y: gesture.current.y - gesture.start.y,
        },
        committedProjections.display,
        navigationRef.current,
      );
      const bounds = resizeNormalizedBounds(gesture.bounds, delta, gesture.handle);
      return resizeRoomSelectionData(room, gesture.selection, bounds) ?? room;
    }
    return room;
  }, [committedProjections.display, directGestureVersion, room]);
  const projections = useMemo(
    () =>
      resolveRoomEditProjectionPair({
        project,
        roomId,
        room: draftRoom,
        viewport: referenceResolution,
        backgroundImageSize,
        resolvedVisibility,
        navigation,
      }),
    [
      backgroundImageSize,
      draftRoom,
      navigation,
      project,
      referenceResolution,
      resolvedVisibility,
      roomId,
    ],
  );
  const selectionCandidates = useMemo(
    () => roomEditSelectionCandidates(project, draftRoom, projections.display, t),
    [draftRoom, project, projections.display, t],
  );
  projectionRef.current = projections;
  const projection = projections.display;
  const preparationProjection = useMemo(
    () =>
      resolveRoomEditProjection({
        project,
        roomId,
        room,
        viewport: referenceResolution,
        backgroundImageSize,
        resolvedVisibility,
      }),
    [backgroundImageSize, project, referenceResolution, resolvedVisibility, room, roomId],
  );

  useEffect(() => {
    const isTextInput = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element &&
        (element.isContentEditable ||
          element.tagName === 'INPUT' ||
          element.tagName === 'TEXTAREA' ||
          element.tagName === 'SELECT'),
      );
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!interactionEnabled || event.code !== 'Space' || isTextInput(event.target)) return;
      spaceHeldRef.current = true;
      if (pointerInsideRef.current) event.preventDefault();
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeldRef.current = false;
    };
    const blur = () => {
      spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
    };
  }, [interactionEnabled]);

  useEffect(() => {
    const gesture = panGestureRef.current;
    panGestureRef.current = null;
    const directGesture = directGestureRef.current;
    directGestureRef.current = null;
    suppressSelectionClickRef.current = false;
    if (gesture) setPanning(false);
    if (directGesture) setDirectGestureVersion((value) => value + 1);
    if (gesture && surfaceRef.current?.hasPointerCapture?.(gesture.pointerId))
      surfaceRef.current.releasePointerCapture(gesture.pointerId);
    if (directGesture && surfaceRef.current?.hasPointerCapture?.(directGesture.pointerId))
      surfaceRef.current.releasePointerCapture(directGesture.pointerId);
  }, [gestureCancellationToken, interactionEnabled]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (!interactionEnabled || event.key !== 'Escape') return;
      const panGesture = panGestureRef.current;
      if (panGesture) {
        event.preventDefault();
        panGestureRef.current = null;
        suppressSelectionClickRef.current = true;
        if (surfaceRef.current?.hasPointerCapture?.(panGesture.pointerId))
          surfaceRef.current.releasePointerCapture(panGesture.pointerId);
        setPanning(false);
        return;
      }
      if (pendingAddActionId) {
        event.preventDefault();
        setAddGhostViewportPoint(null);
        onPendingAddActionCancel();
        return;
      }
      if (!directGestureRef.current) return;
      event.preventDefault();
      const gesture = directGestureRef.current;
      directGestureRef.current = null;
      suppressSelectionClickRef.current = true;
      if (surfaceRef.current?.hasPointerCapture?.(gesture.pointerId))
        surfaceRef.current.releasePointerCapture(gesture.pointerId);
      setDirectGestureVersion((value) => value + 1);
    };
    window.addEventListener('keydown', keyDown);
    return () => window.removeEventListener('keydown', keyDown);
  }, [interactionEnabled, onPendingAddActionCancel, pendingAddActionId]);

  const viewportPoint = useCallback(
    (clientX: number, clientY: number) => {
      const bounds = surfaceRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return null;
      return {
        x: ((clientX - bounds.left) / bounds.width) * referenceResolution.width,
        y: ((clientY - bounds.top) / bounds.height) * referenceResolution.height,
        scaleX: referenceResolution.width / bounds.width,
        scaleY: referenceResolution.height / bounds.height,
      };
    },
    [referenceResolution],
  );

  const updateNavigation = useCallback(
    (next: RoomEditNavigation) =>
      onNavigationChange(clampRoomEditNavigation(next, referenceResolution, canonicalSurface)),
    [canonicalSurface, onNavigationChange, referenceResolution],
  );

  const candidatesAtClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const point = viewportPoint(clientX, clientY);
      if (!point) return [];
      return hitTestRoomEditCandidates(selectionCandidates, point, referenceResolution);
    },
    [referenceResolution, selectionCandidates, viewportPoint],
  );

  useEffect(() => {
    if (!surfaceElement) return;
    const wheel = (event: WheelEvent) => {
      if (!interactionEnabled) return;
      event.preventDefault();
      const point = viewportPoint(event.clientX, event.clientY);
      if (!point) return;
      const zoomFactor = Math.exp(-event.deltaY * 0.0015);
      updateNavigation(
        zoomRoomEditNavigationAtPoint(
          navigationRef.current,
          referenceResolution,
          point,
          navigationRef.current.zoom * zoomFactor,
        ),
      );
    };
    surfaceElement.addEventListener('wheel', wheel, { passive: false });
    return () => surfaceElement.removeEventListener('wheel', wheel);
  }, [interactionEnabled, referenceResolution, surfaceElement, updateNavigation, viewportPoint]);

  useEffect(() => {
    let active = true;
    const generation = resourcesGeneration;
    void (async () => {
      const [background, worldDrawEntries] = await Promise.all([
        prepareVisual(
          resources,
          preparationProjection.background.assetId,
          preparationProjection.background.materialApplication,
        ),
        Promise.all(
          preparationProjection.worldDraws.map(async (item) => {
            const assetId =
              item.kind === 'interactable' || item.kind === 'cast-layer'
                ? item.spriteAssetId
                : item.assetId;
            return [
              `${item.kind}:${item.occurrenceId}`,
              await prepareVisual(resources, assetId, item.materialApplication),
            ] as const;
          }),
        ),
      ]);
      if (!active || generation !== resources.generation) return;
      const preparedWorldDrawEntries = worldDrawEntries.flatMap(([key, value]) =>
        value ? ([[key, value]] as const) : [],
      );
      setPreparedScene({
        background,
        worldDraws: new Map<string, PreparedVisual>(preparedWorldDrawEntries),
      });
    })();
    return () => {
      active = false;
    };
  }, [preparationProjection, resources, resourcesGeneration]);

  useEffect(() => {
    const registration = renderer.registerSceneWork({
      order: 0,
      visible: true,
      render: (frame) => {
        const projections = projectionRef.current;
        const canvas = canvasRef.current;
        if (!canvas || !projections) return;
        const { canonical, display } = projections;
        const canonicalWorldDraws = new Map(
          canonical.worldDraws.map((item) => [`${item.kind}:${item.occurrenceId}`, item] as const),
        );
        let staleShaderError: AuthoringWebGlShaderProgramError | null = null;
        const draw = (materialDraw: AuthoringWebGlMaterialDraw) => {
          try {
            frame.drawMaterial(materialDraw);
          } catch (error) {
            if (!(error instanceof AuthoringWebGlShaderProgramError) || !error.stale) throw error;
            staleShaderError ??= error;
          }
        };
        frame.beginTarget(display.viewport.width, display.viewport.height, [0, 0, 0, 0]);
        if (display.background.color) {
          draw(
            drawVisual(
              display,
              display.backgroundColor,
              canonical,
              canonical.backgroundColor,
              {
                texture: colorTexture(colorChannels(display.background.color)),
                material: fallbackEngine2dMaterial,
                textureOverrides: {},
              },
              null,
              frame.timeSeconds,
            ),
          );
        }
        if (preparedScene?.background) {
          draw(
            drawVisual(
              display,
              display.background,
              canonical,
              canonical.background,
              preparedScene.background,
              display.background.materialApplication,
              frame.timeSeconds,
              roomPropertyValues,
              display.background.uv,
            ),
          );
        }
        for (const item of display.worldDraws) {
          const prepared = preparedScene?.worldDraws.get(`${item.kind}:${item.occurrenceId}`);
          const canonicalItem = canonicalWorldDraws.get(`${item.kind}:${item.occurrenceId}`);
          if (!prepared || !canonicalItem) continue;
          const propertyValues =
            item.kind === 'interactable' || item.kind === 'cast-layer'
              ? item.propertyValues
              : roomPropertyValues;
          const color =
            item.kind === 'environment' && item.opacity < 1
              ? ([1, 1, 1, item.opacity] as const)
              : undefined;
          const uv =
            item.kind === 'environment'
              ? {
                  x: item.scrollPerSecond.x * frame.timeSeconds,
                  y: item.scrollPerSecond.y * frame.timeSeconds,
                  width: 1,
                  height: 1,
                }
              : undefined;
          draw(
            drawVisual(
              display,
              item,
              canonical,
              canonicalItem,
              prepared,
              item.materialApplication,
              frame.timeSeconds,
              propertyValues,
              uv,
              color,
            ),
          );
        }
        frame.copyTargetToCanvas(canvas, display.viewport.width, display.viewport.height);
        if (staleShaderError) throw staleShaderError;
      },
      onError: (error) => {
        console.error('Room Edit authoring render failed.', error);
      },
    });
    return () => registration.unregister();
  }, [preparedScene, renderer, roomPropertyValues]);

  const committedCandidates = selection.flatMap((item) => {
    const candidate = candidateForRoomEditSelection(selectionCandidates, item);
    return candidate ? [candidate] : [];
  });
  const directGesture = directGestureRef.current;
  const activeMarquee =
    directGesture?.kind === 'marquee' && directGesture.dragging
      ? marqueeRect(directGesture.start, directGesture.current)
      : null;
  const addGhostProjected = (() => {
    if (!pendingAddActionId || !addGhostViewportPoint) return null;
    const point = normalizedRoomPointFromViewport(
      addGhostViewportPoint,
      room,
      projection,
      navigationRef.current,
    );
    if (!point) return null;
    const size = pendingAddActionId === 'environment' ? 0.5 : 0.2;
    const bounds = {
      x: Math.max(0, Math.min(1 - size, point.x - size * 0.5)),
      y: Math.max(0, Math.min(1 - size, point.y - size * 0.5)),
      width: size,
      height: size,
    };
    return projectRoomEditRect(
      {
        x: bounds.x * projection.viewport.width,
        y: bounds.y * projection.viewport.height,
        width: bounds.width * projection.viewport.width,
        height: bounds.height * projection.viewport.height,
      },
      projection.viewport,
      room.presentationSpace,
      projection.camera,
      navigationRef.current,
    );
  })();

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) return;
        setContextCandidates([]);
        setContextPreviewCandidate(null);
        setContextAddPoint(null);
      }}
    >
      <ContextMenuTrigger className="contents">
        <div
          ref={handleSurfaceElement}
          className="relative w-full min-h-0 min-w-0 shrink-0 overflow-hidden bg-muted/20"
          style={{ aspectRatio: `${referenceResolution.width} / ${referenceResolution.height}` }}
          data-testid="room-edit-surface"
          data-panning={panning ? 'true' : 'false'}
          data-interaction-enabled={interactionEnabled ? 'true' : 'false'}
          onPointerEnter={() => {
            pointerInsideRef.current = true;
          }}
          onPointerLeave={() => {
            pointerInsideRef.current = false;
            setHoveredPlacementId(null);
            if (pendingAddActionId) setAddGhostViewportPoint(null);
          }}
          onPointerDown={(event) => {
            if (!interactionEnabled) return;
            const shouldPan = event.button === 1 || (event.button === 0 && spaceHeldRef.current);
            if (shouldPan) {
              event.preventDefault();
              const suppressSelectionClick = event.button === 0;
              suppressSelectionClickRef.current = suppressSelectionClick;
              panGestureRef.current = {
                pointerId: event.pointerId,
                clientX: event.clientX,
                clientY: event.clientY,
                suppressSelectionClick,
              };
              surfaceRef.current?.setPointerCapture?.(event.pointerId);
              setPanning(true);
              return;
            }
            if (event.button !== 0) return;
            const point = viewportPoint(event.clientX, event.clientY);
            if (!point) return;
            if (pendingAddActionId) {
              event.preventDefault();
              suppressSelectionClickRef.current = true;
              const normalized = normalizedRoomPointFromViewport(
                point,
                room,
                projection,
                navigationRef.current,
              );
              if (normalized) onAddAtPoint(pendingAddActionId, normalized);
              setAddGhostViewportPoint(null);
              onPendingAddActionCancel();
              return;
            }
            const hits = candidatesAtClientPoint(event.clientX, event.clientY);
            const candidate = ordinaryRoomEditSelectionCandidate(hits);
            const additive = event.ctrlKey || event.metaKey;
            if (candidate) {
              const selectedKeys = new Set(selection.map(roomEditSelectionKey));
              const dragCandidate =
                hits.find(
                  (item) =>
                    item.category !== 'hotspot' &&
                    selectedKeys.has(roomEditSelectionKey(item.selection)),
                ) ?? candidate;
              const candidateKey = roomEditSelectionKey(dragCandidate.selection);
              const alreadySelected = selection.some(
                (item) => roomEditSelectionKey(item) === candidateKey,
              );
              directGestureRef.current = {
                kind: 'candidate',
                pointerId: event.pointerId,
                start: { x: point.x, y: point.y },
                current: { x: point.x, y: point.y },
                selection: alreadySelected ? [...selection] : [dragCandidate.selection],
                candidate,
                additive,
                dragging: false,
              };
            } else {
              directGestureRef.current = {
                kind: 'marquee',
                pointerId: event.pointerId,
                start: { x: point.x, y: point.y },
                current: { x: point.x, y: point.y },
                additive,
                dragging: false,
              };
            }
            surfaceRef.current?.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = panGestureRef.current;
            if (gesture && gesture.pointerId === event.pointerId) {
              const point = viewportPoint(event.clientX, event.clientY);
              if (!point) return;
              const delta = {
                x: (event.clientX - gesture.clientX) * point.scaleX,
                y: (event.clientY - gesture.clientY) * point.scaleY,
              };
              gesture.clientX = event.clientX;
              gesture.clientY = event.clientY;
              updateNavigation(panRoomEditNavigation(navigationRef.current, delta));
              return;
            }
            if (pendingAddActionId) {
              const point = viewportPoint(event.clientX, event.clientY);
              if (point) setAddGhostViewportPoint({ x: point.x, y: point.y });
              return;
            }
            const direct = directGestureRef.current;
            if (!direct || direct.pointerId !== event.pointerId) {
              const hovered = ordinaryRoomEditSelectionCandidate(
                candidatesAtClientPoint(event.clientX, event.clientY),
              );
              setHoveredPlacementId(
                hovered?.selection.kind === 'placement' ? hovered.selection.id : null,
              );
              return;
            }
            const point = viewportPoint(event.clientX, event.clientY);
            if (!point) return;
            direct.current = { x: point.x, y: point.y };
            if (direct.kind !== 'resize') {
              const distance = Math.hypot(
                direct.current.x - direct.start.x,
                direct.current.y - direct.start.y,
              );
              const threshold = 4 * Math.max(point.scaleX, point.scaleY);
              if (distance >= threshold) {
                if (direct.kind === 'marquee') direct.dragging = true;
                else if (
                  direct.selection.every(
                    (selection) => roomEditSelectionCapabilities(selection).move,
                  )
                )
                  direct.dragging = true;
              }
            }
            setDirectGestureVersion((value) => value + 1);
          }}
          onPointerUp={(event) => {
            const gesture = panGestureRef.current;
            if (gesture && gesture.pointerId === event.pointerId) {
              panGestureRef.current = null;
              if (!gesture.suppressSelectionClick) suppressSelectionClickRef.current = false;
              setPanning(false);
              if (surfaceRef.current?.hasPointerCapture?.(event.pointerId))
                surfaceRef.current.releasePointerCapture(event.pointerId);
              return;
            }
            const direct = directGestureRef.current;
            if (!direct || direct.pointerId !== event.pointerId) return;
            const point = viewportPoint(event.clientX, event.clientY);
            if (point) direct.current = { x: point.x, y: point.y };
            directGestureRef.current = null;
            suppressSelectionClickRef.current = true;
            if (surfaceRef.current?.hasPointerCapture?.(event.pointerId))
              surfaceRef.current.releasePointerCapture(event.pointerId);
            if (direct.kind === 'candidate') {
              if (direct.dragging) {
                onTranslateSelection(
                  direct.selection,
                  pointerDeltaToNormalized(
                    {
                      x: direct.current.x - direct.start.x,
                      y: direct.current.y - direct.start.y,
                    },
                    committedProjections.display,
                    navigationRef.current,
                  ),
                );
              } else {
                onSelectionChange(
                  direct.additive
                    ? toggleRoomEditSelection(selection, direct.candidate.selection)
                    : [direct.candidate.selection],
                );
              }
            } else if (direct.kind === 'marquee') {
              if (!direct.dragging) {
                if (!direct.additive) onSelectionChange([]);
              } else {
                const marquee = marqueeRect(direct.start, direct.current);
                const matches = marqueeRoomEditSelections(
                  selectionCandidates,
                  marquee,
                  referenceResolution,
                );
                if (!direct.additive) onSelectionChange(matches);
                else {
                  let next = [...selection];
                  for (const item of matches) next = toggleRoomEditSelection(next, item);
                  onSelectionChange(next);
                }
              }
            } else {
              const delta = pointerDeltaToNormalized(
                {
                  x: direct.current.x - direct.start.x,
                  y: direct.current.y - direct.start.y,
                },
                committedProjections.display,
                navigationRef.current,
              );
              const bounds = resizeNormalizedBounds(direct.bounds, delta, direct.handle);
              const changed = (['x', 'y', 'width', 'height'] as const).some(
                (field) => Math.abs(bounds[field] - direct.bounds[field]) > 1e-9,
              );
              if (changed) onResizeSelection(direct.selection, bounds);
            }
            setDirectGestureVersion((value) => value + 1);
          }}
          onPointerCancel={(event) => {
            const gesture = panGestureRef.current;
            if (gesture && gesture.pointerId === event.pointerId) {
              panGestureRef.current = null;
              suppressSelectionClickRef.current = false;
              setPanning(false);
            }
            const direct = directGestureRef.current;
            if (direct?.pointerId === event.pointerId) {
              directGestureRef.current = null;
              suppressSelectionClickRef.current = true;
              setDirectGestureVersion((value) => value + 1);
            }
          }}
          onClick={(event) => {
            if (!interactionEnabled) return;
            if (suppressSelectionClickRef.current) {
              suppressSelectionClickRef.current = false;
              return;
            }
            const candidate = ordinaryRoomEditSelectionCandidate(
              candidatesAtClientPoint(event.clientX, event.clientY),
            );
            onSelectionChange(
              candidate
                ? event.ctrlKey || event.metaKey
                  ? toggleRoomEditSelection(selection, candidate.selection)
                  : [candidate.selection]
                : event.ctrlKey || event.metaKey
                  ? selection
                  : [],
            );
          }}
          onDoubleClick={(event) => {
            if (!interactionEnabled) return;
            const candidate = topmostRoomEditOccupantCandidate(
              candidatesAtClientPoint(event.clientX, event.clientY),
            );
            if (candidate) onSelectionChange([candidate.selection]);
          }}
          onContextMenu={(event) => {
            if (!interactionEnabled) {
              event.preventDefault();
              return;
            }
            const candidates = candidatesAtClientPoint(event.clientX, event.clientY);
            setContextCandidates(candidates);
            setContextPreviewCandidate(defaultRoomEditSelectionCandidate(candidates));
            const point = viewportPoint(event.clientX, event.clientY);
            setContextAddPoint(
              point
                ? normalizedRoomPointFromViewport(point, room, projection, navigationRef.current)
                : null,
            );
          }}
        >
          <canvas
            ref={canvasRef}
            width={referenceResolution.width}
            height={referenceResolution.height}
            className="absolute inset-0 size-full"
            aria-label={t('roomEditor.presentationModes.editWorldRendering')}
            data-testid="room-edit-canvas"
          />
          <div className="pointer-events-none absolute inset-0" data-testid="room-edit-overlays">
            {projection.layoutPlaceholders.map((placeholder) => (
              <div
                key={`layout:${placeholder.placementId}`}
                className={`absolute border border-dotted border-primary/60 bg-primary/5 ${placeholder.hasRenderedOccupants ? 'opacity-40' : 'opacity-75'}`}
                style={overlayStyle(placeholder, projection)}
                data-testid={`room-edit-layout-placeholder-${placeholder.placementId}`}
              >
                <span className="absolute bottom-0 left-0 max-w-full truncate bg-background/75 px-1 py-0.5 text-[10px] font-medium">
                  {placeholder.label} · {placeholder.layoutId}
                </span>
              </div>
            ))}
            {projection.placements.map((placement) => {
              const hovered =
                hoveredPlacementId === placement.id &&
                !selection.some(
                  (selected) => selected.kind === 'placement' && selected.id === placement.id,
                );
              return (
                <div
                  key={placement.id}
                  className={`absolute border border-dashed ${
                    hovered
                      ? 'border-primary/80 bg-primary/5 shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary),transparent_45%)]'
                      : 'border-foreground/30'
                  }`}
                  style={overlayStyle(placement, projection)}
                  data-testid={`room-edit-placement-${placement.id}`}
                  data-hovered={hovered ? 'true' : 'false'}
                />
              );
            })}
            {selectionCandidates
              .filter((candidate) => candidate.category === 'hotspot')
              .map((candidate) => (
                <div
                  key={`hotspot:${candidate.selection.id}`}
                  className="absolute border border-dashed border-sky-400/80 bg-sky-400/5"
                  style={overlayStyle(candidate.projected, projection)}
                  data-testid={`room-edit-hotspot-${candidate.selection.id}`}
                />
              ))}
            {committedCandidates.map((candidate) => {
              const key = roomEditSelectionKey(candidate.selection);
              const resizable =
                selection.length === 1 &&
                roomEditSelectionCapabilities(candidate.selection).resize &&
                normalizedBoundsForSelection(draftRoom, candidate.selection);
              return (
                <div
                  key={`selected:${key}`}
                  className="absolute border-2 border-primary shadow-[0_0_0_1px_color-mix(in_oklch,var(--background),transparent_30%)]"
                  style={overlayStyle(candidate.projected, projection)}
                  data-testid={`room-edit-selected-${key}`}
                >
                  <span className="absolute left-0 top-0 max-w-[min(24rem,80vw)] -translate-y-full truncate rounded-t bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                    {candidate.label}
                  </span>
                  {resizable
                    ? (['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
                        <span
                          key={handle}
                          className={`pointer-events-auto absolute size-2.5 rounded-sm border border-background bg-primary ${
                            handle.includes('n') ? '-top-1.5' : '-bottom-1.5'
                          } ${handle.includes('w') ? '-left-1.5' : '-right-1.5'} ${roomEditResizeCursorClass[handle]}`}
                          data-testid={`room-edit-resize-${handle}`}
                          onPointerDown={(event) => {
                            if (!interactionEnabled || event.button !== 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const point = viewportPoint(event.clientX, event.clientY);
                            const bounds = normalizedBoundsForSelection(
                              draftRoom,
                              candidate.selection,
                            );
                            if (!point || !bounds) return;
                            directGestureRef.current = {
                              kind: 'resize',
                              pointerId: event.pointerId,
                              start: { x: point.x, y: point.y },
                              current: { x: point.x, y: point.y },
                              selection: candidate.selection,
                              handle,
                              bounds,
                            };
                            surfaceRef.current?.setPointerCapture?.(event.pointerId);
                            setDirectGestureVersion((value) => value + 1);
                          }}
                        />
                      ))
                    : null}
                </div>
              );
            })}
            {activeMarquee ? (
              <div
                className="absolute border border-primary bg-primary/10"
                style={{
                  left: `${(activeMarquee.x / referenceResolution.width) * 100}%`,
                  top: `${(activeMarquee.y / referenceResolution.height) * 100}%`,
                  width: `${(activeMarquee.width / referenceResolution.width) * 100}%`,
                  height: `${(activeMarquee.height / referenceResolution.height) * 100}%`,
                }}
                data-testid="room-edit-marquee"
              />
            ) : null}
            {addGhostProjected ? (
              <div
                className="absolute border-2 border-dashed border-primary bg-primary/10"
                style={overlayStyle(addGhostProjected, projection)}
                data-testid="room-edit-add-ghost"
              >
                <span className="absolute left-0 top-0 -translate-y-full rounded-t bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">
                  {addActions.find((action) => action.id === pendingAddActionId)?.label ??
                    pendingAddActionId}
                </span>
              </div>
            ) : null}
            {contextPreviewCandidate ? (
              <div
                className="absolute bg-amber-400/5 outline-2 outline-offset-2 outline-dashed outline-amber-400"
                style={overlayStyle(contextPreviewCandidate.projected, projection)}
                data-testid={`room-edit-context-preview-${roomEditSelectionKey(contextPreviewCandidate.selection)}`}
              >
                <span className="absolute bottom-0 right-0 max-w-[min(24rem,80vw)] translate-y-full truncate rounded-b bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-black">
                  {contextPreviewCandidate.label}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-64">
        {contextCandidates.length > 0 ? (
          <>
            {contextCandidates.map((candidate) => (
              <ContextMenuItem
                key={roomEditSelectionKey(candidate.selection)}
                onMouseEnter={() => setContextPreviewCandidate(candidate)}
                onFocus={() => setContextPreviewCandidate(candidate)}
                onClick={() => onSelectionChange([candidate.selection])}
              >
                <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {candidate.category === 'placement'
                    ? t('roomEditor.compositionPane.candidatePlacement')
                    : t('roomEditor.compositionPane.candidateEntity')}
                </span>
              </ContextMenuItem>
            ))}
          </>
        ) : (
          <ContextMenuItem disabled>{t('roomEditor.compositionPane.noCandidates')}</ContextMenuItem>
        )}
        {contextAddPoint && addActions.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>{t('roomEditor.compositionPane.add')}</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {addActions.map((action) => (
                  <ContextMenuItem
                    key={action.id}
                    disabled={action.disabled}
                    onClick={() => onAddAtPoint(action.id, contextAddPoint)}
                  >
                    {action.label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        ) : null}
        {selection.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onSelectionChange([])}>
              {t('roomEditor.compositionPane.deselectAll')}
              <span className="ml-auto text-[10px] text-muted-foreground">Ctrl+D</span>
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
