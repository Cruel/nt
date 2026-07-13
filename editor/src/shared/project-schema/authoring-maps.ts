import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { assetRefSchema, layoutRefSchema, roomRefSchema, textContentSchema } from './authoring-flow';
import { parseRoomData } from './authoring-rooms';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const mapPointSchema = strict({ x: z.number().finite(), y: z.number().finite() });
export const mapLocationShapeSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('point') }),
  strict({ kind: z.literal('circle'), radius: z.number().finite().positive() }),
  strict({ kind: z.literal('rect'), width: z.number().finite().positive(), height: z.number().finite().positive() }),
]);
export const mapLocationSchema = strict({
  id: entityIdSchema,
  room: roomRefSchema,
  position: mapPointSchema,
  shape: mapLocationShapeSchema,
  label: textContentSchema.nullable(),
});
export const roomExitRefSchema = strict({ room: entityIdSchema, exit: entityIdSchema });
export const mapConnectionSchema = strict({
  id: entityIdSchema,
  exit: roomExitRefSchema,
  sourceLocation: entityIdSchema,
  targetLocation: entityIdSchema,
});
export const mapPresentationSchema = strict({
  title: textContentSchema.nullable(),
  background: assetRefSchema.nullable(),
  layout: layoutRefSchema.nullable(),
  initialMode: z.enum(['minimap', 'full-map']),
});
export const mapDataSchema = strict({
  kind: z.literal('map'),
  presentation: mapPresentationSchema,
  locations: z.array(mapLocationSchema),
  connections: z.array(mapConnectionSchema),
});

export type MapData = z.infer<typeof mapDataSchema>;
export interface MapSchemaDiagnostic { severity: 'error' | 'warning' | 'info'; path: string; message: string; category?: string }
const diagnostic = (path: string, message: string, severity: MapSchemaDiagnostic['severity'] = 'error'): MapSchemaDiagnostic => ({ path, message, severity, category: 'authoring-maps' });

export function parseMapData(value: unknown): MapData | null { const parsed = mapDataSchema.safeParse(value); return parsed.success ? parsed.data : null; }
export function defaultMapData(): MapData {
  return { kind: 'map', presentation: { title: null, background: null, layout: null, initialMode: 'full-map' }, locations: [], connections: [] };
}

function duplicateDiagnostics(items: readonly { id: string }[], path: string, label: string, diagnostics: MapSchemaDiagnostic[]) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) { if (seen.has(item.id)) diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`)); seen.add(item.id); }
}

export function validateMapData(project: AuthoringProject, mapId: string, record: AuthoringRecordBase): MapSchemaDiagnostic[] {
  const base = `/maps/${mapId}/data`; const parsed = mapDataSchema.safeParse(record.data);
  if (!parsed.success) return parsed.error.issues.map((issue) => diagnostic(`${base}/${issue.path.join('/')}`, issue.message));
  const data = parsed.data; const diagnostics: MapSchemaDiagnostic[] = [];
  duplicateDiagnostics(data.locations, `${base}/locations`, 'map location', diagnostics); duplicateDiagnostics(data.connections, `${base}/connections`, 'map connection', diagnostics);
  const locations = new Map(data.locations.map((location) => [location.id, location]));
  const rooms = new Set<string>();
  for (const [index, location] of data.locations.entries()) {
    if (!project.rooms[location.room.$ref.id]) diagnostics.push(diagnostic(`${base}/locations/${index}/room/$ref`, `Missing room '${location.room.$ref.id}'.`));
    if (rooms.has(location.room.$ref.id)) diagnostics.push(diagnostic(`${base}/locations/${index}/room/$ref`, `Room '${location.room.$ref.id}' already has a map location.`, 'warning'));
    rooms.add(location.room.$ref.id);
  }
  if (data.presentation.background && !project.assets[data.presentation.background.$ref.id]) diagnostics.push(diagnostic(`${base}/presentation/background/$ref`, `Missing asset '${data.presentation.background.$ref.id}'.`));
  if (data.presentation.layout && !project.layouts[data.presentation.layout.$ref.id]) diagnostics.push(diagnostic(`${base}/presentation/layout/$ref`, `Missing layout '${data.presentation.layout.$ref.id}'.`));
  for (const [index, connection] of data.connections.entries()) {
    const path = `${base}/connections/${index}`; const source = locations.get(connection.sourceLocation); const target = locations.get(connection.targetLocation);
    if (!source) diagnostics.push(diagnostic(`${path}/sourceLocation`, `Missing source location '${connection.sourceLocation}'.`));
    if (!target) diagnostics.push(diagnostic(`${path}/targetLocation`, `Missing target location '${connection.targetLocation}'.`));
    const room = project.rooms[connection.exit.room]; const exit = room ? parseRoomData(room.data)?.exits.find((candidate) => candidate.id === connection.exit.exit) : null;
    if (!room) diagnostics.push(diagnostic(`${path}/exit/room`, `Missing room '${connection.exit.room}'.`));
    else if (!exit) diagnostics.push(diagnostic(`${path}/exit/exit`, `Missing exit '${connection.exit.exit}' in room '${connection.exit.room}'.`));
    if (source && source.room.$ref.id !== connection.exit.room) diagnostics.push(diagnostic(`${path}/sourceLocation`, 'Connection source location must belong to the exit room.'));
    if (exit && target && target.room.$ref.id !== exit.target.$ref.id) diagnostics.push(diagnostic(`${path}/targetLocation`, 'Connection target location must belong to the exit target room.'));
  }
  return diagnostics;
}
