import { parseAssetData } from './authoring-assets';
import { parseLayoutData } from './authoring-layouts';
import { parseMaterialData } from './authoring-materials';
import {
  parseRoomData,
  validateRoomData,
  type RoomAssetRef,
  type RoomData,
  type RoomLayoutRef,
  type RoomMaterialRef,
} from './authoring-rooms';
import type { AuthoringProject } from './authoring-project';

export const ROOM_PREVIEW_SCHEMA = 'noveltea.room-preview.v1' as const;

export interface RoomProjectDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): RoomProjectDiagnostic {
  return { severity, path, message, category: 'room-project' };
}

function assetMetadata(
  project: AuthoringProject,
  ref: RoomAssetRef | null,
): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.assets[id];
  const data = parseAssetData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    kind: data?.kind ?? 'missing',
    path: data?.source.path ?? null,
    extension: data?.extension ?? null,
    contentHash: data?.contentHash ?? null,
  };
}

function materialMetadata(
  project: AuthoringProject,
  ref: RoomMaterialRef | null,
): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.materials[id];
  const data = parseMaterialData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    role: data?.role ?? null,
    shader: data?.shader?.$ref.id ?? null,
  };
}

function layoutMetadata(
  project: AuthoringProject,
  ref: RoomLayoutRef | null,
): Record<string, unknown> | null {
  if (!ref) return null;
  const id = ref.$ref.id;
  const record = project.layouts[id];
  const data = parseLayoutData(record?.data);
  return {
    id,
    label: record?.label ?? id,
    layoutKind: data?.layoutKind ?? null,
  };
}

function dependencyRevision(project: AuthoringProject, data: RoomData): string[] {
  const dependencies: string[] = [];
  if (data.background.asset) {
    const id = data.background.asset.$ref.id;
    const asset = project.assets[id];
    const assetData = parseAssetData(asset?.data);
    dependencies.push(
      `asset:${id}:${assetData?.contentHash ?? assetData?.source.path ?? 'missing'}`,
    );
  }
  if (data.background.material) {
    const id = data.background.material.$ref.id;
    dependencies.push(`material:${id}:${JSON.stringify(project.materials[id]?.data ?? null)}`);
  }
  for (const entry of data.cast)
    dependencies.push(
      `character:${entry.character.$ref.id}:${JSON.stringify(project.characters[entry.character.$ref.id] ?? null)}`,
    );
  for (const prop of data.props) {
    if (prop.asset)
      dependencies.push(
        `asset:${prop.asset.$ref.id}:${JSON.stringify(project.assets[prop.asset.$ref.id] ?? null)}`,
      );
    if (prop.material)
      dependencies.push(
        `material:${prop.material.$ref.id}:${JSON.stringify(project.materials[prop.material.$ref.id] ?? null)}`,
      );
  }
  if (data.compose)
    dependencies.push(
      `script:${data.compose.script.$ref.id}:${JSON.stringify(project.scripts[data.compose.script.$ref.id] ?? null)}`,
    );
  for (const overlay of data.overlays) {
    if (overlay.layout) {
      const id = overlay.layout.$ref.id;
      dependencies.push(`layout:${id}:${JSON.stringify(project.layouts[id]?.data ?? null)}`);
    }
  }
  for (const exit of data.exits) {
    const id = exit.target.$ref.id;
    dependencies.push(`room:${id}:${project.rooms[id]?.label ?? 'missing'}`);
  }
  return dependencies.sort();
}

export function roomPreviewRevision(project: AuthoringProject, roomId: string): string {
  const record = project.rooms[roomId];
  const data = parseRoomData(record?.data);
  if (!record || !data) return `${roomId}:missing-or-invalid`;
  return JSON.stringify({
    roomId,
    label: record.label,
    data,
    dependencies: dependencyRevision(project, data),
  });
}

export function buildRoomPreviewDocumentData(
  project: AuthoringProject,
  roomId: string,
): Record<string, unknown> {
  const record = project.rooms[roomId];
  const data = parseRoomData(record?.data);
  if (!record || !data) {
    return {
      schema: ROOM_PREVIEW_SCHEMA,
      roomId,
      label: roomId,
      diagnostics: [diagnostic(`/rooms/${roomId}/data`, 'Invalid room data.')],
    };
  }

  return {
    schema: ROOM_PREVIEW_SCHEMA,
    roomId,
    label: record.label,
    displayName: data.displayName,
    background: data.background,
    backgroundAsset: assetMetadata(project, data.background.asset),
    backgroundMaterial: materialMetadata(project, data.background.material),
    description: data.description,
    lifecycle: data.lifecycle,
    exits: data.exits.map((exit) => ({
      ...exit,
      targetLabel: project.rooms[exit.target.$ref.id]?.label ?? exit.target.$ref.id,
    })),
    placements: data.placements,
    cast: data.cast,
    props: data.props,
    compose: data.compose,
    overlays: data.overlays.map((overlay) => ({
      ...overlay,
      layoutMetadata: layoutMetadata(project, overlay.layout),
    })),
    diagnostics: validateRoomData(project, roomId, record),
  };
}
