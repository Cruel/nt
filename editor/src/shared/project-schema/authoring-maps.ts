import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import {
  assetRefSchema,
  conditionSchema,
  layoutRefSchema,
  roomRefSchema,
  textContentSchema,
} from './authoring-flow';
import { parseRoomData } from './authoring-rooms';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateCondition as validateSharedCondition } from './authoring-condition-validation';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const normalizedCoordinate = z.number().finite().min(0).max(1);

export const mapPointSchema = strict({ x: normalizedCoordinate, y: normalizedCoordinate });
export const mapPolygonSchema = strict({ points: z.array(mapPointSchema).min(3) });
export const roomExitRefSchema = strict({ room: entityIdSchema, exit: entityIdSchema });

export const mapLocationSchema = strict({
  id: entityIdSchema,
  room: roomRefSchema,
  regions: z.array(mapPolygonSchema),
  label: textContentSchema.nullable(),
  icon: assetRefSchema.nullable(),
  style: z.string().trim().min(1).nullable(),
  labelAnchor: mapPointSchema.nullable(),
  connectionAnchor: mapPointSchema.nullable(),
  visibility: conditionSchema,
  pickOrder: z.number().int(),
  logicalOrder: z.number().int(),
});

export const mapConnectionSchema = strict({
  id: entityIdSchema,
  exits: z.array(roomExitRefSchema).min(1).max(2),
  label: textContentSchema.nullable(),
  icon: assetRefSchema.nullable(),
  style: z.string().trim().min(1).nullable(),
  visibility: conditionSchema,
  logicalOrder: z.number().int(),
  path: z.array(mapPointSchema),
  hitRegions: z.array(mapPolygonSchema),
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
export interface MapSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}
const diagnostic = (
  path: string,
  message: string,
  severity: MapSchemaDiagnostic['severity'] = 'error',
): MapSchemaDiagnostic => ({ path, message, severity, category: 'Maps' });

export function parseMapData(value: unknown): MapData | null {
  const parsed = mapDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function defaultMapData(): MapData {
  return {
    kind: 'map',
    presentation: { title: null, background: null, layout: null, initialMode: 'full-map' },
    locations: [],
    connections: [],
  };
}

function duplicateDiagnostics(
  items: readonly { id: string }[],
  path: string,
  label: string,
  diagnostics: MapSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id))
      diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  }
}

function validateCondition(
  project: AuthoringProject,
  condition: z.infer<typeof conditionSchema>,
  path: string,
  diagnostics: MapSchemaDiagnostic[],
) {
  diagnostics.push(...validateSharedCondition(project, condition, path));
}

function resolveExit(project: AuthoringProject, reference: z.infer<typeof roomExitRefSchema>) {
  const room = project.rooms[reference.room];
  const exit = room
    ? parseRoomData(room.data)?.exits.find((candidate) => candidate.id === reference.exit)
    : null;
  return { room, exit };
}

export function validateMapData(
  project: AuthoringProject,
  mapId: string,
  record: AuthoringRecordBase,
): MapSchemaDiagnostic[] {
  const base = `/maps/${mapId}/data`;
  const parsed = mapDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  const data = parsed.data;
  const diagnostics: MapSchemaDiagnostic[] = [];
  duplicateDiagnostics(data.locations, `${base}/locations`, 'map location', diagnostics);
  duplicateDiagnostics(data.connections, `${base}/connections`, 'map connection', diagnostics);
  const locationsByRoom = new Map<string, (typeof data.locations)[number]>();
  for (const [index, location] of data.locations.entries()) {
    const path = `${base}/locations/${index}`;
    const roomId = location.room.$ref.id;
    if (!project.rooms[roomId])
      diagnostics.push(diagnostic(`${path}/room/$ref`, `Missing room '${roomId}'.`));
    if (locationsByRoom.has(roomId))
      diagnostics.push(
        diagnostic(`${path}/room/$ref`, `Room '${roomId}' already has a Map Location.`),
      );
    else locationsByRoom.set(roomId, location);
    if (location.icon && !project.assets[location.icon.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/icon/$ref`, `Missing asset '${location.icon.$ref.id}'.`),
      );
    validateCondition(project, location.visibility, `${path}/visibility`, diagnostics);
  }
  if (data.presentation.background && !project.assets[data.presentation.background.$ref.id])
    diagnostics.push(
      diagnostic(
        `${base}/presentation/background/$ref`,
        `Missing asset '${data.presentation.background.$ref.id}'.`,
      ),
    );
  if (data.presentation.layout && !project.layouts[data.presentation.layout.$ref.id])
    diagnostics.push(
      diagnostic(
        `${base}/presentation/layout/$ref`,
        `Missing layout '${data.presentation.layout.$ref.id}'.`,
      ),
    );

  for (const [index, connection] of data.connections.entries()) {
    const path = `${base}/connections/${index}`;
    if (connection.icon && !project.assets[connection.icon.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/icon/$ref`, `Missing asset '${connection.icon.$ref.id}'.`),
      );
    validateCondition(project, connection.visibility, `${path}/visibility`, diagnostics);

    const resolved = connection.exits.map((reference, exitIndex) => {
      const result = resolveExit(project, reference);
      if (!result.room)
        diagnostics.push(
          diagnostic(`${path}/exits/${exitIndex}/room`, `Missing room '${reference.room}'.`),
        );
      else if (!result.exit)
        diagnostics.push(
          diagnostic(
            `${path}/exits/${exitIndex}/exit`,
            `Missing exit '${reference.exit}' in room '${reference.room}'.`,
          ),
        );
      return { reference, ...result };
    });
    const linked = resolved.filter(
      (entry): entry is typeof entry & { exit: NonNullable<typeof entry.exit> } =>
        Boolean(entry.exit),
    );
    for (const entry of linked) {
      if (!locationsByRoom.has(entry.reference.room))
        diagnostics.push(
          diagnostic(
            `${path}/exits`,
            `Connection source room '${entry.reference.room}' has no Map Location.`,
          ),
        );
      if (!locationsByRoom.has(entry.exit.target.$ref.id))
        diagnostics.push(
          diagnostic(
            `${path}/exits`,
            `Connection target room '${entry.exit.target.$ref.id}' has no Map Location.`,
          ),
        );
    }
    if (connection.exits.length === 2 && linked.length === 2) {
      const [forward, reverse] = linked;
      if (
        forward.reference.room !== reverse.exit.target.$ref.id ||
        reverse.reference.room !== forward.exit.target.$ref.id ||
        forward.reference.room === reverse.reference.room
      )
        diagnostics.push(
          diagnostic(
            `${path}/exits`,
            'A two-exit Map Connection must reference reciprocal exits between the same two Rooms.',
          ),
        );
    }
  }
  return diagnostics;
}
