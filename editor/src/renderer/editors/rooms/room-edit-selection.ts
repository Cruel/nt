import type { TFunction } from 'i18next';
import type { AuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { RoomData } from '../../../shared/project-schema/authoring-rooms';
import { orderedRoomPresentationPlaneEntries } from '../../../shared/project-schema/room-presentation-order';
import type {
  RoomEditProjectedRect,
  RoomEditProjection,
  RoomEditRect,
  RoomEditSize,
} from './room-edit-projection';

export type RoomEditSelectionKind =
  | 'placement'
  | 'placement-layout'
  | 'interactable'
  | 'prop'
  | 'cast'
  | 'environment'
  | 'overlay'
  | 'hotspot';

export interface RoomEditSelection {
  kind: RoomEditSelectionKind;
  id: string;
}

export interface RoomEditSelectionCandidate {
  selection: RoomEditSelection;
  projected: RoomEditProjectedRect;
  label: string;
  category: 'placement' | 'occupant' | 'independent' | 'hotspot';
  placementId: string | null;
}

export interface RoomEditSelectionCapabilities {
  move: boolean;
  resize: boolean;
}

export function roomEditSelectionKey(selection: RoomEditSelection) {
  return `${selection.kind}:${selection.id}`;
}

export function roomEditSelectionCapabilities(
  selection: RoomEditSelection,
): RoomEditSelectionCapabilities {
  switch (selection.kind) {
    case 'placement':
    case 'interactable':
    case 'prop':
    case 'environment':
      return { move: true, resize: true };
    case 'cast':
      return { move: true, resize: false };
    case 'placement-layout':
    case 'overlay':
    case 'hotspot':
      return { move: false, resize: false };
  }
}

export function roomEditSelectionsEqual(
  left: RoomEditSelection | null | undefined,
  right: RoomEditSelection | null | undefined,
) {
  return Boolean(left && right && left.kind === right.kind && left.id === right.id);
}

function unionRects(rects: readonly RoomEditRect[]): RoomEditRect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function describeRoomEditSelection(
  project: AuthoringProject,
  room: RoomData,
  selection: RoomEditSelection,
  t: TFunction<'workspace'>,
) {
  switch (selection.kind) {
    case 'placement': {
      const occupantCount =
        room.interactables.filter((item) => item.placementId === selection.id).length +
        room.props.filter((item) => item.placementId === selection.id).length +
        room.cast.filter((item) => item.placementId === selection.id).length;
      return occupantCount > 0
        ? t('roomEditor.compositionPane.selection.placementOccupied', {
            id: selection.id,
            count: occupantCount,
          })
        : t('roomEditor.compositionPane.selection.placement', { id: selection.id });
    }
    case 'placement-layout': {
      const placement = room.placements.find((item) => item.id === selection.id);
      const layoutId = placement?.presentation.layout?.$ref.id;
      return t('roomEditor.compositionPane.selection.layout', {
        label: layoutId ? (project.layouts[layoutId]?.label ?? layoutId) : selection.id,
      });
    }
    case 'interactable': {
      const occurrence = room.interactables.find((item) => item.id === selection.id);
      const instanceId = occurrence?.interactable.$ref.id;
      const instance = instanceId ? project.interactableInstances[instanceId] : null;
      const definitionId = instance?.definition.$ref.id;
      const label =
        instance?.editorLabel ??
        (definitionId ? project.interactables[definitionId]?.label : null) ??
        instanceId ??
        selection.id;
      return t('roomEditor.compositionPane.selection.interactable', {
        label,
        id: selection.id,
      });
    }
    case 'cast': {
      const occurrence = room.cast.find((item) => item.id === selection.id);
      const characterId = occurrence?.character.$ref.id;
      return t('roomEditor.compositionPane.selection.cast', {
        label: characterId ? (project.characters[characterId]?.label ?? characterId) : selection.id,
        id: selection.id,
      });
    }
    case 'prop':
      return t('roomEditor.compositionPane.selection.prop', { id: selection.id });
    case 'environment':
      return t('roomEditor.compositionPane.selection.environment', { id: selection.id });
    case 'overlay': {
      const overlay = room.overlays.find((item) => item.id === selection.id);
      const layoutId = overlay?.layout.$ref.id;
      return t('roomEditor.compositionPane.selection.overlay', {
        label: layoutId ? (project.layouts[layoutId]?.label ?? layoutId) : selection.id,
        id: selection.id,
      });
    }
    case 'hotspot': {
      const hotspot = room.hotspots.find((item) => item.id === selection.id);
      return t('roomEditor.compositionPane.selection.hotspot', {
        label: hotspot?.label ?? selection.id,
        id: selection.id,
      });
    }
  }
}

export function roomEditSelectionExists(room: RoomData, selection: RoomEditSelection) {
  switch (selection.kind) {
    case 'placement':
      return room.placements.some((item) => item.id === selection.id);
    case 'placement-layout':
      return room.placements.some(
        (item) => item.id === selection.id && item.presentation.layout !== null,
      );
    case 'interactable':
      return room.interactables.some((item) => item.id === selection.id);
    case 'prop':
      return room.props.some((item) => item.id === selection.id);
    case 'cast':
      return room.cast.some((item) => item.id === selection.id);
    case 'environment':
      return room.environments.some((item) => item.id === selection.id);
    case 'overlay':
      return room.overlays.some((item) => item.id === selection.id);
    case 'hotspot':
      return room.hotspots.some((item) => item.id === selection.id);
  }
}

export function roomEditSelectionCandidates(
  project: AuthoringProject,
  room: RoomData,
  projection: RoomEditProjection,
  t: TFunction<'workspace'>,
): RoomEditSelectionCandidate[] {
  const candidates: RoomEditSelectionCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: RoomEditSelectionCandidate) => {
    const key = roomEditSelectionKey(candidate.selection);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const backgroundUv = projection.background.uv;
  if (backgroundUv.width > 0 && backgroundUv.height > 0) {
    for (const hotspot of [...room.hotspots].sort(
      (left, right) => right.inputOrder - left.inputOrder || left.id.localeCompare(right.id),
    )) {
      const bounds = hotspot.shape.bounds;
      push({
        selection: { kind: 'hotspot', id: hotspot.id },
        projected: {
          rect: {
            x:
              projection.background.rect.x +
              ((bounds.x - backgroundUv.x) / backgroundUv.width) * projection.background.rect.width,
            y:
              projection.background.rect.y +
              ((bounds.y - backgroundUv.y) / backgroundUv.height) *
                projection.background.rect.height,
            width: (bounds.width / backgroundUv.width) * projection.background.rect.width,
            height: (bounds.height / backgroundUv.height) * projection.background.rect.height,
          },
          rotationDegrees: projection.background.rotationDegrees,
        },
        label: describeRoomEditSelection(project, room, { kind: 'hotspot', id: hotspot.id }, t),
        category: 'hotspot',
        placementId: null,
      });
    }
  }

  const layoutPlaceholdersByPlacement = new Map(
    projection.layoutPlaceholders.map((placeholder) => [placeholder.placementId, placeholder]),
  );
  const worldOverlayEnvironments = new Map(
    projection.worldDraws.flatMap((draw) =>
      draw.kind === 'environment' && draw.plane === 'world-overlay'
        ? [[draw.occurrenceId, draw] as const]
        : [],
    ),
  );
  for (const entry of [...orderedRoomPresentationPlaneEntries(room, 'world-overlay')].reverse()) {
    if (entry.target.kind === 'placement-layout') {
      const placeholder = layoutPlaceholdersByPlacement.get(entry.target.id);
      if (!placeholder) continue;
      push({
        selection: entry.target,
        projected: placeholder,
        label: describeRoomEditSelection(project, room, entry.target, t),
        category: 'occupant',
        placementId: entry.target.id,
      });
      continue;
    }
    if (entry.target.kind === 'environment') {
      const environment = worldOverlayEnvironments.get(entry.target.id);
      if (!environment) continue;
      push({
        selection: entry.target,
        projected: environment,
        label: describeRoomEditSelection(project, room, entry.target, t),
        category: 'independent',
        placementId: null,
      });
      continue;
    }
    // Room overlay Layouts are not realized in Room Edit. Keep them discoverable
    // through Room Contents/inspectors instead of inventing fullscreen hit geometry
    // that can intercept picking for visible world content.
  }

  // worldDraws are back-to-front; candidate order is front-to-back.
  for (const draw of [...projection.worldDraws].reverse()) {
    if (draw.plane === 'world-overlay') continue;
    switch (draw.kind) {
      case 'interactable':
        push({
          selection: { kind: 'interactable', id: draw.occurrenceId },
          projected: draw,
          label: describeRoomEditSelection(
            project,
            room,
            { kind: 'interactable', id: draw.occurrenceId },
            t,
          ),
          category: 'occupant',
          placementId: draw.placementId,
        });
        break;
      case 'prop':
        push({
          selection: { kind: 'prop', id: draw.occurrenceId },
          projected: draw,
          label: describeRoomEditSelection(
            project,
            room,
            { kind: 'prop', id: draw.occurrenceId },
            t,
          ),
          category: 'occupant',
          placementId: draw.placementId,
        });
        break;
      case 'environment':
        push({
          selection: { kind: 'environment', id: draw.occurrenceId },
          projected: draw,
          label: describeRoomEditSelection(
            project,
            room,
            { kind: 'environment', id: draw.occurrenceId },
            t,
          ),
          category: 'independent',
          placementId: null,
        });
        break;
      case 'cast-layer': {
        const cast = projection.cast.find((item) =>
          item.layers.some(
            (layer) => `${item.occurrenceId}:${layer.layerId}` === draw.occurrenceId,
          ),
        );
        if (!cast) break;
        const drawableLayers = cast.layers.filter(
          (layer) => layer.visualAssetId || layer.materialApplication,
        );
        const rect = unionRects(drawableLayers.map((layer) => layer.rect));
        if (!rect) break;
        push({
          selection: { kind: 'cast', id: cast.occurrenceId },
          projected: { rect, rotationDegrees: drawableLayers[0]?.rotationDegrees ?? 0 },
          label: describeRoomEditSelection(
            project,
            room,
            { kind: 'cast', id: cast.occurrenceId },
            t,
          ),
          category: 'occupant',
          placementId: cast.placementId,
        });
        break;
      }
    }
  }

  for (const placement of [...projection.placements].reverse()) {
    push({
      selection: { kind: 'placement', id: placement.id },
      projected: placement,
      label: describeRoomEditSelection(project, room, { kind: 'placement', id: placement.id }, t),
      category: 'placement',
      placementId: placement.id,
    });
  }

  return candidates;
}

function pointInProjectedRect(
  point: { x: number; y: number },
  projected: RoomEditProjectedRect,
  viewport: RoomEditSize,
) {
  const radians = (-projected.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const localX = point.x - centerX;
  const localY = point.y - centerY;
  const x = centerX + localX * cosine - localY * sine;
  const y = centerY + localX * sine + localY * cosine;
  return (
    x >= projected.rect.x &&
    x <= projected.rect.x + projected.rect.width &&
    y >= projected.rect.y &&
    y <= projected.rect.y + projected.rect.height
  );
}

function projectedScreenBounds(
  projected: RoomEditProjectedRect,
  viewport: RoomEditSize,
): RoomEditRect {
  const radians = (projected.rotationDegrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centerX = viewport.width * 0.5;
  const centerY = viewport.height * 0.5;
  const corners = [
    [projected.rect.x, projected.rect.y],
    [projected.rect.x + projected.rect.width, projected.rect.y],
    [projected.rect.x, projected.rect.y + projected.rect.height],
    [projected.rect.x + projected.rect.width, projected.rect.y + projected.rect.height],
  ].map(([x, y]) => {
    const localX = x! - centerX;
    const localY = y! - centerY;
    return {
      x: centerX + localX * cosine - localY * sine,
      y: centerY + localX * sine + localY * cosine,
    };
  });
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  const right = Math.max(...corners.map((point) => point.x));
  const bottom = Math.max(...corners.map((point) => point.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectsIntersect(left: RoomEditRect, right: RoomEditRect) {
  return (
    left.x <= right.x + right.width &&
    left.x + left.width >= right.x &&
    left.y <= right.y + right.height &&
    left.y + left.height >= right.y
  );
}

export function marqueeRoomEditSelections(
  candidates: readonly RoomEditSelectionCandidate[],
  marquee: RoomEditRect,
  viewport: RoomEditSize,
): RoomEditSelection[] {
  const result: RoomEditSelection[] = [];
  for (const candidate of candidates) {
    if (candidate.category !== 'placement' && candidate.selection.kind !== 'environment') continue;
    let bounds = projectedScreenBounds(candidate.projected, viewport);
    if (candidate.category === 'placement') {
      const occupantBounds = candidates
        .filter(
          (other) => other.category !== 'placement' && other.placementId === candidate.selection.id,
        )
        .map((other) => projectedScreenBounds(other.projected, viewport));
      const union = unionRects([bounds, ...occupantBounds]);
      if (union) bounds = union;
    }
    if (rectsIntersect(bounds, marquee)) result.push(candidate.selection);
  }
  return result;
}

export function hitTestRoomEditCandidates(
  candidates: readonly RoomEditSelectionCandidate[],
  point: { x: number; y: number },
  viewport: RoomEditSize,
) {
  const direct = candidates.filter((candidate) =>
    pointInProjectedRect(point, candidate.projected, viewport),
  );
  const containingPlacementIds = new Set(
    direct.flatMap((candidate) =>
      candidate.category !== 'placement' && candidate.placementId ? [candidate.placementId] : [],
    ),
  );
  if (containingPlacementIds.size === 0) return direct;
  const directKeys = new Set(direct.map((candidate) => roomEditSelectionKey(candidate.selection)));
  return [
    ...direct,
    ...candidates.filter(
      (candidate) =>
        candidate.category === 'placement' &&
        containingPlacementIds.has(candidate.selection.id) &&
        !directKeys.has(roomEditSelectionKey(candidate.selection)),
    ),
  ];
}

export function defaultRoomEditSelectionCandidate(
  candidates: readonly RoomEditSelectionCandidate[],
) {
  const top = candidates.find((candidate) => candidate.category !== 'hotspot');
  if (!top) return null;
  if (top.placementId) {
    return (
      candidates.find(
        (candidate) =>
          candidate.selection.kind === 'placement' && candidate.selection.id === top.placementId,
      ) ?? top
    );
  }
  return top;
}

export function ordinaryRoomEditSelectionCandidate(
  candidates: readonly RoomEditSelectionCandidate[],
) {
  return defaultRoomEditSelectionCandidate(candidates);
}

export function topmostRoomEditOccupantCandidate(
  candidates: readonly RoomEditSelectionCandidate[],
) {
  return (
    candidates.find(
      (candidate) => candidate.category !== 'placement' && candidate.category !== 'hotspot',
    ) ?? null
  );
}

export function candidateForRoomEditSelection(
  candidates: readonly RoomEditSelectionCandidate[],
  selection: RoomEditSelection,
) {
  return (
    candidates.find((candidate) => roomEditSelectionsEqual(candidate.selection, selection)) ?? null
  );
}
