import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { parseLayoutData } from './authoring-layouts';
import { parseMaterialData } from './authoring-materials';
import { entityIdSchema, type AuthoringProject, type AuthoringRecordBase } from './authoring-project';

export const roomBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export type RoomBackgroundFit = (typeof roomBackgroundFitValues)[number];

export const roomDescriptionFormatValues = ['active-text', 'plain'] as const;
export type RoomDescriptionFormat = (typeof roomDescriptionFormatValues)[number];

export const roomPathDirectionValues = [
  'northwest',
  'north',
  'northeast',
  'west',
  'east',
  'southwest',
  'south',
  'southeast',
  'custom',
] as const;
export type RoomPathDirection = (typeof roomPathDirectionValues)[number];

export const roomPreviewBackgroundValues = ['checker', 'dark', 'light'] as const;
export type RoomPreviewBackground = (typeof roomPreviewBackgroundValues)[number];

export const roomAssetRefSchema = z.object({
  $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }),
});

export const roomMaterialRefSchema = z.object({
  $ref: z.object({ collection: z.literal('materials'), id: z.string().min(1) }),
});

export const roomLayoutRefSchema = z.object({
  $ref: z.object({ collection: z.literal('layouts'), id: z.string().min(1) }),
});

export const roomObjectRefSchema = z.object({
  $ref: z.object({ collection: z.literal('objects'), id: z.string().min(1) }),
});

export const roomRoomRefSchema = z.object({
  $ref: z.object({ collection: z.literal('rooms'), id: z.string().min(1) }),
});

export const roomNormalizedRectSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(0).max(1),
  height: z.number().finite().min(0).max(1),
});

export const roomBackgroundDataSchema = z.object({
  asset: roomAssetRefSchema.nullable().default(null),
  material: roomMaterialRefSchema.nullable().default(null),
  fit: z.enum(roomBackgroundFitValues).default('cover'),
  color: z.string().nullable().default(null),
});

export const roomDescriptionDataSchema = z.object({
  format: z.enum(roomDescriptionFormatValues).default('active-text'),
  source: z.string().default(''),
});

export const roomScriptsDataSchema = z.object({
  beforeEnter: z.string().default(''),
  afterEnter: z.string().default(''),
  beforeLeave: z.string().default(''),
  afterLeave: z.string().default(''),
});

export const roomPathDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Path label is required.'),
  direction: z.enum(roomPathDirectionValues).default('custom'),
  target: roomRoomRefSchema.nullable().default(null),
  enabled: z.boolean().default(true),
  condition: z.string().default(''),
  order: z.number().finite().default(0),
});

export const roomHotspotDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Hotspot label is required.'),
  object: roomObjectRefSchema.nullable().default(null),
  bounds: roomNormalizedRectSchema.default({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
  placeInRoom: z.boolean().default(true),
  description: z.string().default(''),
  script: z.string().default(''),
});

export const roomOverlayDataSchema = z.object({
  id: entityIdSchema,
  label: z.string().min(1, 'Overlay label is required.'),
  layout: roomLayoutRefSchema.nullable().default(null),
  enabled: z.boolean().default(true),
});

export const roomDataSchema = z.object({
  kind: z.literal('room').default('room'),
  displayName: z.string().default(''),
  background: roomBackgroundDataSchema.default({ asset: null, material: null, fit: 'cover', color: null }),
  description: roomDescriptionDataSchema.default({ format: 'active-text', source: '' }),
  scripts: roomScriptsDataSchema.default({ beforeEnter: '', afterEnter: '', beforeLeave: '', afterLeave: '' }),
  paths: z.array(roomPathDataSchema).default([]),
  hotspots: z.array(roomHotspotDataSchema).default([]),
  overlays: z.array(roomOverlayDataSchema).default([]),
  preview: z.object({
    showHotspots: z.boolean().default(true),
    selectedHotspotId: entityIdSchema.nullable().default(null),
    background: z.enum(roomPreviewBackgroundValues).default('dark'),
  }).default({ showHotspots: true, selectedHotspotId: null, background: 'dark' }),
});

export type RoomAssetRef = z.infer<typeof roomAssetRefSchema>;
export type RoomMaterialRef = z.infer<typeof roomMaterialRefSchema>;
export type RoomLayoutRef = z.infer<typeof roomLayoutRefSchema>;
export type RoomObjectRef = z.infer<typeof roomObjectRefSchema>;
export type RoomRoomRef = z.infer<typeof roomRoomRefSchema>;
export type RoomNormalizedRect = z.infer<typeof roomNormalizedRectSchema>;
export type RoomBackgroundData = z.infer<typeof roomBackgroundDataSchema>;
export type RoomDescriptionData = z.infer<typeof roomDescriptionDataSchema>;
export type RoomScriptsData = z.infer<typeof roomScriptsDataSchema>;
export type RoomPathData = z.infer<typeof roomPathDataSchema>;
export type RoomHotspotData = z.infer<typeof roomHotspotDataSchema>;
export type RoomOverlayData = z.infer<typeof roomOverlayDataSchema>;
export type RoomData = z.infer<typeof roomDataSchema>;

export interface RoomSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(path: string, message: string, severity: 'error' | 'warning' | 'info' = 'error'): RoomSchemaDiagnostic {
  return { severity, path, message, category: 'authoring-rooms' };
}

export function parseRoomData(value: unknown): RoomData | null {
  const parsed = roomDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultRoomData(label = 'Room'): RoomData {
  return roomDataSchema.parse({
    kind: 'room',
    displayName: label,
    background: { asset: null, material: null, fit: 'cover', color: null },
    description: { format: 'active-text', source: '' },
    scripts: { beforeEnter: '', afterEnter: '', beforeLeave: '', afterLeave: '' },
    paths: [],
    hotspots: [],
    overlays: [],
    preview: { showHotspots: true, selectedHotspotId: null, background: 'dark' },
  });
}

export function isRoomRecord(record: AuthoringRecordBase | undefined | null): record is AuthoringRecordBase & { data: RoomData } {
  return !!record && parseRoomData(record.data) !== null;
}

function refId(ref: RoomAssetRef | RoomMaterialRef | RoomLayoutRef | RoomObjectRef | RoomRoomRef | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function validateUniqueIds(
  items: Array<{ id: string }>,
  path: string,
  label: string,
  diagnostics: RoomSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateBackgroundAsset(project: AuthoringProject, ref: RoomAssetRef | null, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const asset = project.assets[id];
  if (!asset) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing background asset '${id}'.`));
    return;
  }
  const data = parseAssetData(asset.data);
  if (!data) diagnostics.push(diagnostic(`${path}/$ref`, `Asset '${id}' has invalid asset data.`, 'warning'));
  else if (data.kind !== 'image') diagnostics.push(diagnostic(`${path}/$ref`, `Background asset '${id}' is ${data.kind}, not image.`, 'warning'));
}

function validateMaterialRef(project: AuthoringProject, ref: RoomMaterialRef | null, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const material = project.materials[id];
  if (!material) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing material '${id}'.`));
    return;
  }
  if (!parseMaterialData(material.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Material '${id}' has invalid material data.`, 'warning'));
}

function validateLayoutRef(project: AuthoringProject, ref: RoomLayoutRef | null, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  const layout = project.layouts[id];
  if (!layout) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing layout '${id}'.`));
    return;
  }
  if (!parseLayoutData(layout.data)) diagnostics.push(diagnostic(`${path}/$ref`, `Layout '${id}' has invalid layout data.`, 'warning'));
}

function validateObjectRef(project: AuthoringProject, ref: RoomObjectRef | null, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  if (!project.objects[id]) diagnostics.push(diagnostic(`${path}/$ref`, `Missing object '${id}'.`));
}

function validatePathTarget(project: AuthoringProject, roomId: string, ref: RoomRoomRef | null, path: string, diagnostics: RoomSchemaDiagnostic[]) {
  const id = refId(ref);
  if (!id) return;
  if (!project.rooms[id]) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing target room '${id}'.`));
    return;
  }
  if (id === roomId) diagnostics.push(diagnostic(`${path}/$ref`, 'Path targets the current room.', 'warning'));
}

export function validateRoomData(
  project: AuthoringProject,
  roomId: string,
  record: AuthoringRecordBase,
): RoomSchemaDiagnostic[] {
  const diagnostics: RoomSchemaDiagnostic[] = [];
  const parsed = roomDataSchema.safeParse(record.data);
  const base = `/rooms/${roomId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;
  if (record.inherits) {
    if (record.inherits.collection !== 'rooms') {
      diagnostics.push(diagnostic(`/rooms/${roomId}/inherits`, 'Room inheritance must target another room.'));
    } else if (!project.rooms[record.inherits.id]) {
      diagnostics.push(diagnostic(`/rooms/${roomId}/inherits`, `Missing inherited room '${record.inherits.id}'.`));
    }
  }

  if (!data.description.source.trim()) diagnostics.push(diagnostic(`${base}/description/source`, 'Room description is empty.', 'warning'));
  validateBackgroundAsset(project, data.background.asset, `${base}/background/asset`, diagnostics);
  validateMaterialRef(project, data.background.material, `${base}/background/material`, diagnostics);
  validateUniqueIds(data.paths, `${base}/paths`, 'path', diagnostics);
  validateUniqueIds(data.hotspots, `${base}/hotspots`, 'hotspot', diagnostics);
  validateUniqueIds(data.overlays, `${base}/overlays`, 'overlay', diagnostics);

  data.paths.forEach((path, index) => validatePathTarget(project, roomId, path.target, `${base}/paths/${index}/target`, diagnostics));
  data.hotspots.forEach((hotspot, index) => {
    validateObjectRef(project, hotspot.object, `${base}/hotspots/${index}/object`, diagnostics);
    if (hotspot.bounds.width <= 0 || hotspot.bounds.height <= 0) {
      diagnostics.push(diagnostic(`${base}/hotspots/${index}/bounds`, 'Hotspot bounds must have non-zero width and height.'));
    }
  });
  data.overlays.forEach((overlay, index) => validateLayoutRef(project, overlay.layout, `${base}/overlays/${index}/layout`, diagnostics));

  if (data.preview.selectedHotspotId && !data.hotspots.some((hotspot) => hotspot.id === data.preview.selectedHotspotId)) {
    diagnostics.push(diagnostic(`${base}/preview/selectedHotspotId`, `Missing selected hotspot '${data.preview.selectedHotspotId}'.`, 'warning'));
  }

  return diagnostics;
}

export function roomAssetRef(assetId: string): RoomAssetRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

export function roomMaterialRef(materialId: string): RoomMaterialRef {
  return { $ref: { collection: 'materials', id: materialId } };
}

export function roomLayoutRef(layoutId: string): RoomLayoutRef {
  return { $ref: { collection: 'layouts', id: layoutId } };
}

export function roomObjectRef(objectId: string): RoomObjectRef {
  return { $ref: { collection: 'objects', id: objectId } };
}

export function roomRoomRef(roomId: string): RoomRoomRef {
  return { $ref: { collection: 'rooms', id: roomId } };
}
