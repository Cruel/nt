import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { parseMaterialData } from './authoring-materials';
import { entityIdSchema } from './authoring-common';
import { roomRefSchema } from './authoring-flow';
import { inventoryDefinitionSchema } from './authoring-inventories';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';

export const characterPreviewBackgroundValues = [
  'transparent',
  'checker',
  'dark',
  'light',
] as const;
export const characterIdleKindValues = ['bob', 'sway', 'pulse'] as const;
export const presentationClockValues = ['gameplay', 'unscaled-presentation'] as const;
export type CharacterPreviewBackground = (typeof characterPreviewBackgroundValues)[number];

export const characterAssetRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('assets'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const characterMaterialRefSchema = z
  .object({
    $ref: z.object({ collection: z.literal('materials'), id: z.string().min(1) }).strict(),
  })
  .strict();

export const characterVector2Schema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const characterPresentationLayerDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Layer label is required.'),
    role: z.string().min(1).nullable().default(null),
  })
  .strict();

export const characterLayerCompositionDataSchema = z
  .object({
    layerId: entityIdSchema,
    sprite: characterAssetRefSchema.nullable().default(null),
    material: characterMaterialRefSchema.nullable().default(null),
    offset: characterVector2Schema.default({ x: 0, y: 0 }),
    scale: z.number().finite().positive().default(1),
    anchor: characterVector2Schema.default({ x: 0.5, y: 1 }),
    visible: z.boolean().default(true),
  })
  .strict();

export const characterPoseDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Pose label is required.'),
    layers: z.array(characterLayerCompositionDataSchema).default([]),
  })
  .strict();

export const characterPresentationProfileDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Profile label is required.'),
    layers: z.array(characterPresentationLayerDataSchema).default([]),
    defaultPoseId: entityIdSchema,
    poses: z.array(characterPoseDataSchema).default([]),
  })
  .strict();

export const characterLayerOverrideDataSchema = z
  .object({
    layerId: entityIdSchema,
    sprite: characterAssetRefSchema.nullable().optional(),
    material: characterMaterialRefSchema.nullable().optional(),
    visible: z.boolean().optional(),
  })
  .strict();

export const characterProfileLayerOverridesDataSchema = z
  .object({
    profileId: entityIdSchema,
    layers: z.array(characterLayerOverrideDataSchema).default([]),
  })
  .strict();

export const characterExpressionDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Expression label is required.'),
    profiles: z.array(characterProfileLayerOverridesDataSchema).default([]),
  })
  .strict();

export const characterAppearanceDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Appearance label is required.'),
    profiles: z.array(characterProfileLayerOverridesDataSchema).default([]),
  })
  .strict();

export const characterIdleDataSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Idle label is required.'),
    kind: z.enum(characterIdleKindValues),
    amplitude: z.number().finite().nonnegative(),
    periodMs: z.number().int().positive(),
    clock: z.enum(presentationClockValues),
  })
  .strict();

export const characterDialogueStyleSchema = z
  .object({
    name: z.string().default(''),
    nameColor: z.string().nullable().default(null),
    textColor: z.string().nullable().default(null),
    styleClass: z.string().default(''),
  })
  .strict();

export const characterInitialWorldLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unplaced') }).strict(),
  z.object({ kind: z.literal('room'), room: roomRefSchema }).strict(),
]);

export const characterDataSchema = z
  .object({
    kind: z.literal('character').default('character'),
    displayName: z.string().default(''),
    dialogue: characterDialogueStyleSchema.default({
      name: '',
      nameColor: null,
      textColor: null,
      styleClass: '',
    }),
    defaults: z
      .object({
        profileId: entityIdSchema,
        expressionId: entityIdSchema,
        appearanceId: entityIdSchema.nullable().default(null),
        idleId: entityIdSchema.nullable().default(null),
      })
      .strict()
      .default({
        profileId: 'stage',
        expressionId: 'neutral',
        appearanceId: null,
        idleId: null,
      }),
    profiles: z.array(characterPresentationProfileDataSchema).default([]),
    expressions: z.array(characterExpressionDataSchema).default([]),
    appearances: z.array(characterAppearanceDataSchema).default([]),
    idles: z.array(characterIdleDataSchema).default([]),
    inventories: z.array(inventoryDefinitionSchema),
    initialWorldState: z
      .object({
        location: characterInitialWorldLocationSchema,
        enabled: z.boolean(),
        visible: z.boolean(),
      })
      .strict()
      .default({ location: { kind: 'unplaced' }, enabled: true, visible: true }),
  })
  .strict();

export type CharacterAssetRef = z.infer<typeof characterAssetRefSchema>;
export type CharacterMaterialRef = z.infer<typeof characterMaterialRefSchema>;
export type CharacterPresentationLayerData = z.infer<typeof characterPresentationLayerDataSchema>;
export type CharacterLayerCompositionData = z.infer<typeof characterLayerCompositionDataSchema>;
export type CharacterPoseData = z.infer<typeof characterPoseDataSchema>;
export type CharacterPresentationProfileData = z.infer<
  typeof characterPresentationProfileDataSchema
>;
export type CharacterLayerOverrideData = z.infer<typeof characterLayerOverrideDataSchema>;
export type CharacterProfileLayerOverridesData = z.infer<
  typeof characterProfileLayerOverridesDataSchema
>;
export type CharacterExpressionData = z.infer<typeof characterExpressionDataSchema>;
export type CharacterAppearanceData = z.infer<typeof characterAppearanceDataSchema>;
export type CharacterIdleData = z.infer<typeof characterIdleDataSchema>;
export type CharacterDialogueStyle = z.infer<typeof characterDialogueStyleSchema>;
export type CharacterData = z.infer<typeof characterDataSchema>;

export interface CharacterSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
}

function diagnostic(
  path: string,
  message: string,
  severity: 'error' | 'warning' | 'info' = 'error',
): CharacterSchemaDiagnostic {
  return { severity, path, message, category: 'Characters' };
}

export function parseCharacterData(value: unknown): CharacterData | null {
  const parsed = characterDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function defaultCharacterData(label = 'Character'): CharacterData {
  return characterDataSchema.parse({
    kind: 'character',
    displayName: label,
    dialogue: {
      name: label,
      nameColor: null,
      textColor: null,
      styleClass: '',
    },
    defaults: {
      profileId: 'stage',
      expressionId: 'neutral',
      appearanceId: null,
      idleId: null,
    },
    profiles: [
      {
        id: 'stage',
        label: 'Stage',
        layers: [{ id: 'body', label: 'Body', role: 'body' }],
        defaultPoseId: 'default',
        poses: [
          {
            id: 'default',
            label: 'Default',
            layers: [
              {
                layerId: 'body',
                sprite: null,
                material: null,
                offset: { x: 0, y: 0 },
                scale: 1,
                anchor: { x: 0.5, y: 1 },
                visible: true,
              },
            ],
          },
        ],
      },
    ],
    expressions: [
      {
        id: 'neutral',
        label: 'Neutral',
        profiles: [],
      },
    ],
    appearances: [],
    idles: [],
    inventories: [],
    initialWorldState: { location: { kind: 'unplaced' }, enabled: true, visible: true },
  });
}

export function isCharacterRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: CharacterData } {
  return !!record && parseCharacterData(record.data) !== null;
}

function refId(ref: CharacterAssetRef | CharacterMaterialRef | null | undefined): string | null {
  return ref?.$ref.id ?? null;
}

function validateUniqueIds(
  items: Array<{ id: string }>,
  path: string,
  label: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}

function validateSpriteRef(
  project: AuthoringProject,
  ref: CharacterAssetRef | null,
  path: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const id = refId(ref);
  if (!id) return;
  const asset = project.assets[id];
  if (!asset) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing sprite asset '${id}'.`));
    return;
  }
  const data = parseAssetData(asset.data);
  if (!data)
    diagnostics.push(
      diagnostic(`${path}/$ref`, `Asset '${id}' has invalid asset data.`, 'warning'),
    );
  else if (data.kind !== 'image')
    diagnostics.push(
      diagnostic(`${path}/$ref`, `Sprite asset '${id}' is ${data.kind}, not image.`, 'warning'),
    );
}

function validateMaterialRef(
  project: AuthoringProject,
  ref: CharacterMaterialRef | null,
  path: string,
  diagnostics: CharacterSchemaDiagnostic[],
) {
  const id = refId(ref);
  if (!id) return;
  const material = project.materials[id];
  if (!material) {
    diagnostics.push(diagnostic(`${path}/$ref`, `Missing material '${id}'.`));
    return;
  }
  if (!parseMaterialData(material.data))
    diagnostics.push(
      diagnostic(`${path}/$ref`, `Material '${id}' has invalid material data.`, 'warning'),
    );
}

export function validateCharacterData(
  project: AuthoringProject,
  characterId: string,
  record: AuthoringRecordBase,
): CharacterSchemaDiagnostic[] {
  const diagnostics: CharacterSchemaDiagnostic[] = [];
  const parsed = characterDataSchema.safeParse(record.data);
  const base = `/characters/${characterId}/data`;
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      diagnostics.push(diagnostic(`${base}/${issue.path.map(String).join('/')}`, issue.message));
    return diagnostics;
  }

  const data = parsed.data;

  if (data.profiles.length === 0)
    diagnostics.push(diagnostic(`${base}/profiles`, 'Character requires at least one profile.'));
  if (data.expressions.length === 0)
    diagnostics.push(
      diagnostic(`${base}/expressions`, 'Character requires at least one expression.'),
    );
  validateUniqueIds(data.profiles, `${base}/profiles`, 'profile', diagnostics);
  validateUniqueIds(data.expressions, `${base}/expressions`, 'expression', diagnostics);
  validateUniqueIds(data.appearances, `${base}/appearances`, 'appearance', diagnostics);
  validateUniqueIds(data.idles, `${base}/idles`, 'idle', diagnostics);

  const profiles = new Set(data.profiles.map((profile) => profile.id));
  const expressions = new Set(data.expressions.map((expression) => expression.id));
  const appearances = new Set(data.appearances.map((appearance) => appearance.id));
  const idles = new Set(data.idles.map((idle) => idle.id));

  if (!profiles.has(data.defaults.profileId))
    diagnostics.push(
      diagnostic(
        `${base}/defaults/profileId`,
        `Missing default profile '${data.defaults.profileId}'.`,
      ),
    );
  if (!expressions.has(data.defaults.expressionId))
    diagnostics.push(
      diagnostic(
        `${base}/defaults/expressionId`,
        `Missing default expression '${data.defaults.expressionId}'.`,
      ),
    );
  if (data.defaults.idleId && !idles.has(data.defaults.idleId))
    diagnostics.push(
      diagnostic(`${base}/defaults/idleId`, `Missing default idle '${data.defaults.idleId}'.`),
    );

  if (data.defaults.appearanceId && !appearances.has(data.defaults.appearanceId))
    diagnostics.push(
      diagnostic(
        `${base}/defaults/appearanceId`,
        `Missing default appearance '${data.defaults.appearanceId}'.`,
      ),
    );

  const validateOverrides = (
    entries: Array<{
      profiles: Array<{ profileId: string; layers: CharacterLayerOverrideData[] }>;
    }>,
    collection: 'expressions' | 'appearances',
  ) => {
    entries.forEach((entry, entryIndex) => {
      validateUniqueIds(
        entry.profiles.map((profile) => ({ id: profile.profileId })),
        `${base}/${collection}/${entryIndex}/profiles`,
        'profile override',
        diagnostics,
      );
      entry.profiles.forEach((profileOverride, profileIndex) => {
        const profile = data.profiles.find(
          (candidate) => candidate.id === profileOverride.profileId,
        );
        if (!profile) {
          diagnostics.push(
            diagnostic(
              `${base}/${collection}/${entryIndex}/profiles/${profileIndex}/profileId`,
              `Missing profile '${profileOverride.profileId}'.`,
            ),
          );
          return;
        }
        const layerIds = new Set(profile.layers.map((layer) => layer.id));
        validateUniqueIds(
          profileOverride.layers.map((layer) => ({ id: layer.layerId })),
          `${base}/${collection}/${entryIndex}/profiles/${profileIndex}/layers`,
          'layer override',
          diagnostics,
        );
        profileOverride.layers.forEach((layer, layerIndex) => {
          const path = `${base}/${collection}/${entryIndex}/profiles/${profileIndex}/layers/${layerIndex}`;
          if (!layerIds.has(layer.layerId))
            diagnostics.push(diagnostic(`${path}/layerId`, `Missing layer '${layer.layerId}'.`));
          if (layer.sprite !== undefined)
            validateSpriteRef(project, layer.sprite, `${path}/sprite`, diagnostics);
          if (layer.material !== undefined)
            validateMaterialRef(project, layer.material, `${path}/material`, diagnostics);
        });
      });
    });
  };

  data.profiles.forEach((profile, profileIndex) => {
    const profilePath = `${base}/profiles/${profileIndex}`;
    if (profile.layers.length === 0)
      diagnostics.push(diagnostic(`${profilePath}/layers`, 'Profile requires at least one layer.'));
    if (profile.poses.length === 0)
      diagnostics.push(diagnostic(`${profilePath}/poses`, 'Profile requires at least one pose.'));
    validateUniqueIds(profile.layers, `${profilePath}/layers`, 'layer', diagnostics);
    validateUniqueIds(profile.poses, `${profilePath}/poses`, 'pose', diagnostics);
    const layerIds = new Set(profile.layers.map((layer) => layer.id));
    const poseIds = new Set(profile.poses.map((pose) => pose.id));
    if (!poseIds.has(profile.defaultPoseId))
      diagnostics.push(
        diagnostic(
          `${profilePath}/defaultPoseId`,
          `Missing default pose '${profile.defaultPoseId}'.`,
        ),
      );
    profile.poses.forEach((pose, poseIndex) => {
      const posePath = `${profilePath}/poses/${poseIndex}`;
      validateUniqueIds(
        pose.layers.map((layer) => ({ id: layer.layerId })),
        `${posePath}/layers`,
        'pose layer',
        diagnostics,
      );
      pose.layers.forEach((layer, layerIndex) => {
        const path = `${posePath}/layers/${layerIndex}`;
        if (!layerIds.has(layer.layerId))
          diagnostics.push(diagnostic(`${path}/layerId`, `Missing layer '${layer.layerId}'.`));
        validateSpriteRef(project, layer.sprite, `${path}/sprite`, diagnostics);
        validateMaterialRef(project, layer.material, `${path}/material`, diagnostics);
      });
    });
  });
  validateOverrides(data.expressions, 'expressions');
  validateOverrides(data.appearances, 'appearances');

  const selectedProfile = data.profiles.find((profile) => profile.id === data.defaults.profileId);
  const selectedPose = selectedProfile?.poses.find(
    (pose) => pose.id === selectedProfile.defaultPoseId,
  );
  const hasSprite = selectedPose?.layers.some((layer) => layer.sprite) ?? false;
  if (selectedProfile && selectedPose && !hasSprite) {
    diagnostics.push(
      diagnostic(`${base}/preview`, 'Selected profile pose has no sprite asset yet.', 'warning'),
    );
  }
  const location = data.initialWorldState.location;
  if (location.kind === 'room' && !project.rooms[location.room.$ref.id])
    diagnostics.push(
      diagnostic(
        `${base}/initialWorldState/location/room/$ref`,
        `Missing room '${location.room.$ref.id}'.`,
      ),
    );

  return diagnostics;
}

export function characterAssetRef(assetId: string): CharacterAssetRef {
  return { $ref: { collection: 'assets', id: assetId } };
}

export function characterMaterialRef(materialId: string): CharacterMaterialRef {
  return { $ref: { collection: 'materials', id: materialId } };
}
