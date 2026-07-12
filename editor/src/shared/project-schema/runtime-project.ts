import { z } from 'zod';

export const RUNTIME_PROJECT_SCHEMA = 'noveltea.runtime.project' as const;
export const RUNTIME_PROJECT_SCHEMA_VERSION = 1 as const;
const id = z.string().min(1);
const runtimeValue = z.union([z.null(), z.boolean(), z.number(), z.string()]);

export const runtimeProjectSchema = z.object({
  schema: z.literal(RUNTIME_PROJECT_SCHEMA),
  schemaVersion: z.literal(RUNTIME_PROJECT_SCHEMA_VERSION),
  identity: z.object({ id, name: z.string(), version: z.string(), author: z.string(), website: z.string() }),
  settings: z.object({ locale: z.string(), defaultFont: z.string(), allowSaves: z.boolean() }),
  entrypoint: z.object({ kind: z.enum(['room', 'dialogue', 'scene', 'script']), id }),
  variables: z.record(z.string(), runtimeValue),
  assets: z.array(z.object({ id, path: z.string().min(1), mediaType: z.string() })),
  assetAliases: z.array(z.object({ id, assetId: id })),
  rooms: z.array(z.object({ id, name: z.string(), description: z.string(), mapId: id.nullable().optional(), objectIds: z.array(id), verbIds: z.array(id) })),
  objects: z.array(z.object({ id, name: z.string(), description: z.string(), verbIds: z.array(id) })),
  verbs: z.array(z.object({ id, label: z.string() })),
  actions: z.array(z.object({ id, verbId: id, objectId: id.nullable().optional(), steps: z.array(z.string()) })),
  dialogues: z.array(z.object({ id, nodes: z.array(z.object({ id, text: z.string(), choices: z.array(z.object({ label: z.string(), nextNodeId: id.nullable().optional() })) })) })),
  scenes: z.array(z.object({ id, steps: z.array(z.string()) })),
  maps: z.array(z.object({ id, assetId: id.nullable().optional(), locations: z.array(z.object({ id, roomId: id, x: z.number(), y: z.number() })) })),
  scripts: z.array(z.object({ id, source: z.string() })),
  layouts: z.array(z.object({ id, documentAssetId: id })),
  runtimeUi: z.object({ defaultLayoutId: id.nullable(), themeAssetId: id.nullable() }),
}).passthrough();

export type RuntimeProjectWire = z.infer<typeof runtimeProjectSchema>;
