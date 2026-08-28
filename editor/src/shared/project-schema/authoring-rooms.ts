import { z } from 'zod';
import { parseAssetData } from './authoring-assets';
import { entityIdSchema } from './authoring-common';
import {
  assetRefSchema,
  characterRefSchema,
  conditionSchema,
  inlineTextContent,
  layoutRefSchema,
  materialRefSchema,
  roomRefSchema,
  scriptRefSchema,
  textContentSchema,
} from './authoring-flow';
import { parseLayoutData } from './authoring-layouts';
import type { AuthoringProject, AuthoringRecordBase } from './authoring-project';
import { validateVariableRuntimeValue } from './authoring-variable-usage';
import { hotspotCommonShape, rectHotspotShapeSchema } from './authoring-hotspots';
import { featureDataSchema, roomHotspotTargetSchema } from './authoring-features';
import { parseCharacterData } from './authoring-characters';
import { interactableInstanceRefSchema, parseInteractableData } from './authoring-interactables';
import { resolveGameplayInstanceRecord } from './authoring-archetypes';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const roomBackgroundFitValues = ['cover', 'contain', 'stretch', 'center'] as const;
export const roomExitDirectionValues = [
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
export const roomNavigationTransitionKindValues = ['cut', 'fade', 'dissolve'] as const;
export const roomEnvironmentPlaneValues = [
  'world-background',
  'world-content',
  'world-overlay',
] as const;
export const roomEnvironmentClockValues = ['gameplay', 'unscaled-presentation'] as const;

export const roomAssetRefSchema = assetRefSchema;
export const roomMaterialRefSchema = materialRefSchema;
export const roomLayoutRefSchema = layoutRefSchema;
export const roomCharacterRefSchema = characterRefSchema;
export const roomInteractableRefSchema = interactableInstanceRefSchema;
export const roomScriptRefSchema = scriptRefSchema;
export const roomRoomRefSchema = roomRefSchema;
export const roomNormalizedRectSchema = strict({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
});
export const roomWorldPointSchema = strict({
  x: z.number().finite(),
  y: z.number().finite(),
});
export const roomWorldRectSchema = strict({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
export const roomCameraViewSchema = strict({
  center: roomWorldPointSchema,
  zoom: z.number().finite().positive(),
  rotationDegrees: z.number().finite(),
});
export const roomNamedCameraViewSchema = strict({
  id: entityIdSchema,
  view: roomCameraViewSchema,
});
export const roomPresentationSpaceSchema = strict({
  size: strict({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  }),
  bounds: roomWorldRectSchema.nullable(),
  edgePolicy: z.enum(['contain', 'overscan']),
  defaultView: roomCameraViewSchema,
  views: z.array(roomNamedCameraViewSchema),
});
export const roomAnchorDataSchema = strict({
  id: entityIdSchema,
  bounds: roomNormalizedRectSchema,
});

export const roomBackgroundDataSchema = strict({
  asset: roomAssetRefSchema.nullable(),
  material: roomMaterialRefSchema.nullable(),
  fit: z.enum(roomBackgroundFitValues),
  color: z.string().nullable(),
});
export const roomNavigationTransitionSchema = strict({
  kind: z.enum(roomNavigationTransitionKindValues),
  durationMs: z.number().int().nonnegative(),
  color: z.string().nullable(),
  skippable: z.boolean(),
});
export const roomOverlayDataSchema = strict({
  id: entityIdSchema,
  layout: roomLayoutRefSchema,
  condition: conditionSchema,
  visible: z.boolean(),
  order: z.number().int(),
});
export const roomPlacementDataSchema = strict({
  id: entityIdSchema,
  bounds: roomNormalizedRectSchema,
  order: z.number().int().optional(),
  presentation: strict({
    label: textContentSchema.nullable(),
    layout: roomLayoutRefSchema.nullable(),
  }),
});
export const roomCastDataSchema = strict({
  id: entityIdSchema,
  character: roomCharacterRefSchema,
  condition: conditionSchema,
  placementId: entityIdSchema,
  profileId: entityIdSchema.nullable().optional(),
  poseId: entityIdSchema.nullable(),
  expressionId: entityIdSchema.nullable(),
  appearanceId: entityIdSchema.nullable().optional(),
  idleId: entityIdSchema.nullable().default(null),
  visible: z.boolean(),
  order: z.number().int(),
});
export const roomPropDataSchema = strict({
  id: entityIdSchema,
  condition: conditionSchema,
  placementId: entityIdSchema,
  asset: roomAssetRefSchema.nullable(),
  material: roomMaterialRefSchema.nullable(),
  visible: z.boolean(),
  order: z.number().int(),
});
export const roomInteractableDataSchema = strict({
  id: entityIdSchema,
  interactable: roomInteractableRefSchema,
  condition: conditionSchema,
  placementId: entityIdSchema,
  visible: z.boolean(),
  order: z.number().int(),
});
export const roomEnvironmentDataSchema = strict({
  id: entityIdSchema,
  condition: conditionSchema,
  asset: roomAssetRefSchema.nullable(),
  material: roomMaterialRefSchema,
  bounds: roomNormalizedRectSchema,
  plane: z.enum(roomEnvironmentPlaneValues),
  order: z.number().int(),
  clock: z.enum(roomEnvironmentClockValues),
  scrollPerSecond: strict({ x: z.number().finite(), y: z.number().finite() }),
  opacity: z.number().finite().min(0).max(1),
  visible: z.boolean(),
});
export const roomScriptHookKindValues = [
  'can-enter',
  'can-leave',
  'reject-enter',
  'reject-leave',
  'before-enter',
  'after-enter',
  'before-leave',
  'after-leave',
  'compose',
] as const;
export const roomScriptHookMappingSchema = strict({
  hook: z.enum(roomScriptHookKindValues),
  handler: strict({
    module: roomScriptRefSchema,
    export: z.string().check(z.trim(), z.minLength(1)),
  }),
});
export const roomExitDataSchema = strict({
  id: entityIdSchema,
  label: z.string().min(1),
  direction: z.enum(roomExitDirectionValues),
  target: roomRoomRefSchema,
  condition: conditionSchema,
  transition: roomNavigationTransitionSchema.nullable().optional(),
});
export const roomHotspotDataSchema = strict({
  ...hotspotCommonShape,
  shape: rectHotspotShapeSchema,
  target: roomHotspotTargetSchema,
});
export const roomLifecycleDataSchema = strict({
  canEnter: conditionSchema,
  canLeave: conditionSchema,
});
export const roomDataSchema = strict({
  kind: z.literal('room'),
  displayName: z.string(),
  background: roomBackgroundDataSchema,
  description: textContentSchema,
  presentationSpace: roomPresentationSpaceSchema,
  anchors: z.array(roomAnchorDataSchema),
  overlays: z.array(roomOverlayDataSchema),
  cast: z.array(roomCastDataSchema),
  props: z.array(roomPropDataSchema),
  interactables: z.array(roomInteractableDataSchema),
  environments: z.array(roomEnvironmentDataSchema).default([]),
  scriptHooks: z.array(roomScriptHookMappingSchema),
  lifecycle: roomLifecycleDataSchema,
  exits: z.array(roomExitDataSchema),
  placements: z.array(roomPlacementDataSchema),
  features: z.array(featureDataSchema),
  hotspots: z.array(roomHotspotDataSchema),
});

export type RoomAssetRef = z.infer<typeof roomAssetRefSchema>;
export type RoomMaterialRef = z.infer<typeof roomMaterialRefSchema>;
export type RoomLayoutRef = z.infer<typeof roomLayoutRefSchema>;
export type RoomCharacterRef = z.infer<typeof roomCharacterRefSchema>;
export type RoomRoomRef = z.infer<typeof roomRoomRefSchema>;
export type RoomNormalizedRect = z.infer<typeof roomNormalizedRectSchema>;
export type RoomCameraView = z.infer<typeof roomCameraViewSchema>;
export type RoomPresentationSpace = z.infer<typeof roomPresentationSpaceSchema>;
export type RoomAnchorData = z.infer<typeof roomAnchorDataSchema>;
export type RoomOverlayData = z.infer<typeof roomOverlayDataSchema>;
export type RoomPlacementData = z.infer<typeof roomPlacementDataSchema>;
export type RoomCastData = z.infer<typeof roomCastDataSchema>;
export type RoomPropData = z.infer<typeof roomPropDataSchema>;
export type RoomInteractableData = z.infer<typeof roomInteractableDataSchema>;
export type RoomEnvironmentData = z.infer<typeof roomEnvironmentDataSchema>;
export type RoomNavigationTransition = z.infer<typeof roomNavigationTransitionSchema>;
export type RoomExitData = z.infer<typeof roomExitDataSchema>;
export type RoomData = z.infer<typeof roomDataSchema>;
export type RoomHotspotData = z.infer<typeof roomHotspotDataSchema>;
export type RoomFeatureData = z.infer<typeof featureDataSchema>;

export interface RoomSchemaDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category?: string;
  code?: string;
}
const diagnostic = (
  path: string,
  message: string,
  severity: RoomSchemaDiagnostic['severity'] = 'error',
  code?: string,
): RoomSchemaDiagnostic => ({
  path,
  message,
  severity,
  category: 'Rooms',
  ...(code ? { code } : {}),
});

export function parseRoomData(value: unknown): RoomData | null {
  const parsed = roomDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function defaultRoomData(label = 'Room'): RoomData {
  return {
    kind: 'room',
    displayName: label,
    background: { asset: null, material: null, fit: 'cover', color: null },
    description: inlineTextContent(),
    presentationSpace: {
      size: { width: 1920, height: 1080 },
      bounds: null,
      edgePolicy: 'contain',
      defaultView: { center: { x: 960, y: 540 }, zoom: 1, rotationDegrees: 0 },
      views: [],
    },
    anchors: [],
    overlays: [],
    placements: [],
    cast: [],
    props: [],
    interactables: [],
    environments: [],
    scriptHooks: [],
    exits: [],
    features: [],
    hotspots: [],
    lifecycle: {
      canEnter: { kind: 'always' },
      canLeave: { kind: 'always' },
    },
  };
}
export function isRoomRecord(
  record: AuthoringRecordBase | undefined | null,
): record is AuthoringRecordBase & { data: RoomData } {
  return !!record && parseRoomData(record.data) !== null;
}
export const roomAssetRef = (id: string): RoomAssetRef => ({ $ref: { collection: 'assets', id } });
export const roomMaterialRef = (id: string): RoomMaterialRef => ({
  $ref: { collection: 'materials', id },
});
export const roomLayoutRef = (id: string): RoomLayoutRef => ({
  $ref: { collection: 'layouts', id },
});
export const roomCharacterRef = (id: string): RoomCharacterRef => ({
  $ref: { collection: 'characters', id },
});
export const roomInteractableRef = (id: string) => ({
  $ref: { collection: 'interactables' as const, id },
});
export const roomRoomRef = (id: string): RoomRoomRef => ({ $ref: { collection: 'rooms', id } });

function uniqueIds(
  items: readonly { id: string }[],
  path: string,
  label: string,
  diagnostics: RoomSchemaDiagnostic[],
) {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.id))
      diagnostics.push(diagnostic(`${path}/${index}/id`, `Duplicate ${label} ID '${item.id}'.`));
    seen.add(item.id);
  });
}
function validateCondition(
  project: AuthoringProject,
  condition: z.infer<typeof conditionSchema>,
  path: string,
  diagnostics: RoomSchemaDiagnostic[],
) {
  if (condition.kind !== 'variable-comparison') return;
  const variableId = condition.variable.$ref.id;
  if (condition.value === undefined) {
    if (!project.variables[variableId])
      diagnostics.push(diagnostic(`${path}/variable/$ref`, `Missing variable '${variableId}'.`));
    return;
  }
  const result = validateVariableRuntimeValue(project, variableId, condition.value);
  if (!result.ok)
    diagnostics.push(
      diagnostic(
        result.kind === 'missing' ? `${path}/variable/$ref` : `${path}/value`,
        result.message,
      ),
    );
}
export function validateRoomNavigationTransition(
  value: z.infer<typeof roomNavigationTransitionSchema>,
  path: string,
  diagnostics: RoomSchemaDiagnostic[],
) {
  if (value.kind !== 'cut' && value.durationMs === 0)
    diagnostics.push(
      diagnostic(`${path}/durationMs`, 'Animated transitions require a positive duration.'),
    );
}

export function compileRoomNavigationTransition(
  value: z.infer<typeof roomNavigationTransitionSchema>,
) {
  return {
    ...value,
    durationMs: value.kind === 'cut' ? 0 : value.durationMs,
    color: value.kind === 'fade' ? value.color : null,
  };
}
export function validateRoomData(
  project: AuthoringProject,
  roomId: string,
  record: AuthoringRecordBase,
): RoomSchemaDiagnostic[] {
  const base = `/rooms/${roomId}/data`;
  const parsed = roomDataSchema.safeParse(record.data);
  if (!parsed.success)
    return parsed.error.issues.map((issue) =>
      diagnostic(`${base}/${issue.path.join('/')}`, issue.message),
    );
  const data = parsed.data;
  const diagnostics: RoomSchemaDiagnostic[] = [];
  if (
    !data.description.source ||
    (data.description.source.kind === 'inline' && !data.description.source.text.trim())
  )
    diagnostics.push(diagnostic(`${base}/description`, 'Room description is empty.', 'warning'));
  if (data.background.asset) {
    const asset = project.assets[data.background.asset.$ref.id];
    if (!asset)
      diagnostics.push(
        diagnostic(
          `${base}/background/asset/$ref`,
          `Missing background asset '${data.background.asset.$ref.id}'.`,
        ),
      );
    else if (parseAssetData(asset.data)?.kind !== 'image')
      diagnostics.push(
        diagnostic(
          `${base}/background/asset/$ref`,
          'Room background asset must be an image.',
          'warning',
        ),
      );
  }
  if (data.background.material && !project.materials[data.background.material.$ref.id])
    diagnostics.push(
      diagnostic(
        `${base}/background/material/$ref`,
        `Missing material '${data.background.material.$ref.id}'.`,
      ),
    );
  uniqueIds(
    data.presentationSpace.views,
    `${base}/presentationSpace/views`,
    'Camera View',
    diagnostics,
  );
  uniqueIds(data.anchors, `${base}/anchors`, 'Anchor', diagnostics);
  uniqueIds(data.overlays, `${base}/overlays`, 'overlay', diagnostics);
  uniqueIds(data.exits, `${base}/exits`, 'exit', diagnostics);
  const exitDirections = new Set<RoomExitData['direction']>();
  data.exits.forEach((exit, index) => {
    if (exitDirections.has(exit.direction))
      diagnostics.push(
        diagnostic(
          `${base}/exits/${index}/direction`,
          `Duplicate exit direction '${exit.direction}'. Each Room direction may be used once.`,
        ),
      );
    exitDirections.add(exit.direction);
  });
  uniqueIds(data.placements, `${base}/placements`, 'placement', diagnostics);
  uniqueIds(data.cast, `${base}/cast`, 'cast', diagnostics);
  uniqueIds(data.props, `${base}/props`, 'prop', diagnostics);
  uniqueIds(data.interactables, `${base}/interactables`, 'Interactable instance', diagnostics);
  uniqueIds(data.environments, `${base}/environments`, 'environment', diagnostics);
  uniqueIds(data.features, `${base}/features`, 'Feature', diagnostics);
  uniqueIds(data.hotspots, `${base}/hotspots`, 'hotspot', diagnostics);
  const presentationBounds = data.presentationSpace.bounds ?? {
    x: 0,
    y: 0,
    width: data.presentationSpace.size.width,
    height: data.presentationSpace.size.height,
  };
  if (
    presentationBounds.x < 0 ||
    presentationBounds.y < 0 ||
    presentationBounds.x + presentationBounds.width > data.presentationSpace.size.width ||
    presentationBounds.y + presentationBounds.height > data.presentationSpace.size.height
  )
    diagnostics.push(
      diagnostic(
        `${base}/presentationSpace/bounds`,
        'Presentation bounds must stay inside the World Presentation Space size.',
      ),
    );
  const validateView = (view: RoomCameraView, path: string) => {
    if (
      view.center.x < presentationBounds.x ||
      view.center.y < presentationBounds.y ||
      view.center.x > presentationBounds.x + presentationBounds.width ||
      view.center.y > presentationBounds.y + presentationBounds.height
    )
      diagnostics.push(
        diagnostic(`${path}/center`, 'Camera View center must stay inside presentation bounds.'),
      );
  };
  validateView(data.presentationSpace.defaultView, `${base}/presentationSpace/defaultView`);
  data.presentationSpace.views.forEach((entry, index) =>
    validateView(entry.view, `${base}/presentationSpace/views/${index}/view`),
  );
  const placements = new Set(data.placements.map((placement) => placement.id));
  data.overlays.forEach((overlay, index) => {
    const layout = project.layouts[overlay.layout.$ref.id];
    if (!layout)
      diagnostics.push(
        diagnostic(
          `${base}/overlays/${index}/layout/$ref`,
          `Missing layout '${overlay.layout.$ref.id}'.`,
        ),
      );
    else if (!parseLayoutData(layout.data))
      diagnostics.push(
        diagnostic(
          `${base}/overlays/${index}/layout/$ref`,
          `Layout '${overlay.layout.$ref.id}' is invalid.`,
          'warning',
        ),
      );
    validateCondition(
      project,
      overlay.condition,
      `${base}/overlays/${index}/condition`,
      diagnostics,
    );
  });
  data.exits.forEach((exit, index) => {
    if (!project.rooms[exit.target.$ref.id])
      diagnostics.push(
        diagnostic(
          `${base}/exits/${index}/target/$ref`,
          `Missing target room '${exit.target.$ref.id}'.`,
        ),
      );
    else if (exit.target.$ref.id === roomId)
      diagnostics.push(
        diagnostic(
          `${base}/exits/${index}/target/$ref`,
          'Exit targets the current room.',
          'warning',
        ),
      );
    validateCondition(project, exit.condition, `${base}/exits/${index}/condition`, diagnostics);
    if (exit.transition)
      validateRoomNavigationTransition(
        exit.transition,
        `${base}/exits/${index}/transition`,
        diagnostics,
      );
  });
  data.placements.forEach((placement, index) => {
    if (placement.presentation.layout && !project.layouts[placement.presentation.layout.$ref.id])
      diagnostics.push(
        diagnostic(
          `${base}/placements/${index}/presentation/layout/$ref`,
          `Missing layout '${placement.presentation.layout.$ref.id}'.`,
        ),
      );
  });
  data.cast.forEach((entry, index) => {
    const path = `${base}/cast/${index}`;
    const character = project.characters[entry.character.$ref.id];
    const characterData = character ? parseCharacterData(character.data) : null;
    if (!character)
      diagnostics.push(
        diagnostic(`${path}/character/$ref`, `Missing character '${entry.character.$ref.id}'.`),
      );
    if (!placements.has(entry.placementId))
      diagnostics.push(
        diagnostic(`${path}/placementId`, `Missing placement '${entry.placementId}'.`),
      );
    const profileId = entry.profileId ?? characterData?.defaults.profileId ?? null;
    const profile = characterData?.profiles.find((item) => item.id === profileId);
    const poseId = entry.poseId ?? profile?.defaultPoseId ?? null;
    const pose = profile?.poses.find((item) => item.id === poseId);
    const expression = characterData?.expressions?.find((item) => item.id === entry.expressionId);
    const appearance = characterData?.appearances?.find((item) => item.id === entry.appearanceId);
    const idle = characterData?.idles?.find((item) => item.id === entry.idleId);
    if (entry.profileId && !profile)
      diagnostics.push(diagnostic(`${path}/profileId`, `Missing profile '${entry.profileId}'.`));
    if (entry.poseId && !pose)
      diagnostics.push(diagnostic(`${path}/poseId`, `Missing pose '${entry.poseId}'.`));
    if (entry.expressionId && !expression)
      diagnostics.push(
        diagnostic(`${path}/expressionId`, `Missing expression '${entry.expressionId}'.`),
      );
    if (entry.idleId && !idle)
      diagnostics.push(diagnostic(`${path}/idleId`, `Missing idle '${entry.idleId}'.`));
    if (entry.appearanceId && !appearance)
      diagnostics.push(
        diagnostic(`${path}/appearanceId`, `Missing appearance '${entry.appearanceId}'.`),
      );
    validateCondition(project, entry.condition, `${path}/condition`, diagnostics);
  });
  data.props.forEach((entry, index) => {
    const path = `${base}/props/${index}`;
    if (!placements.has(entry.placementId))
      diagnostics.push(
        diagnostic(`${path}/placementId`, `Missing placement '${entry.placementId}'.`),
      );
    if (!entry.asset && !entry.material)
      diagnostics.push(diagnostic(path, 'Room prop requires an asset and/or material.'));
    if (entry.asset && !project.assets[entry.asset.$ref.id])
      diagnostics.push(diagnostic(`${path}/asset/$ref`, `Missing asset '${entry.asset.$ref.id}'.`));
    if (entry.material && !project.materials[entry.material.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/material/$ref`, `Missing material '${entry.material.$ref.id}'.`),
      );
    validateCondition(project, entry.condition, `${path}/condition`, diagnostics);
  });
  data.interactables.forEach((entry, index) => {
    const path = `${base}/interactables/${index}`;
    const instance = project.interactableInstances[entry.interactable.$ref.id];
    const interactableRecord = instance
      ? project.interactables[instance.definition.$ref.id]
      : undefined;
    const effectiveRecord = interactableRecord
      ? resolveGameplayInstanceRecord(project, 'interactable', interactableRecord)
      : null;
    const interactable = effectiveRecord ? parseInteractableData(effectiveRecord.data) : null;
    if (!instance)
      diagnostics.push(
        diagnostic(
          `${path}/interactable/$ref`,
          `Missing Interactable Instance '${entry.interactable.$ref.id}'.`,
        ),
      );
    else if (!interactableRecord)
      diagnostics.push(
        diagnostic(
          `${path}/interactable/$ref`,
          `Interactable Instance '${entry.interactable.$ref.id}' has no valid definition.`,
        ),
      );
    else if (entry.visible && interactable && !interactable.presentation.sprite)
      diagnostics.push(
        diagnostic(
          `${path}/interactable/$ref`,
          `Visible Interactable '${entry.interactable.$ref.id}' has no sprite and will not render.`,
          'warning',
          'room.interactable.sprite-missing',
        ),
      );
    if (!placements.has(entry.placementId))
      diagnostics.push(
        diagnostic(`${path}/placementId`, `Missing placement '${entry.placementId}'.`),
      );
    validateCondition(project, entry.condition, `${path}/condition`, diagnostics);
  });
  data.environments.forEach((entry, index) => {
    const path = `${base}/environments/${index}`;
    if (entry.asset && !project.assets[entry.asset.$ref.id])
      diagnostics.push(diagnostic(`${path}/asset/$ref`, `Missing asset '${entry.asset.$ref.id}'.`));
    if (!project.materials[entry.material.$ref.id])
      diagnostics.push(
        diagnostic(`${path}/material/$ref`, `Missing material '${entry.material.$ref.id}'.`),
      );
    validateCondition(project, entry.condition, `${path}/condition`, diagnostics);
  });
  const scriptHookKinds = new Set<string>();
  data.scriptHooks.forEach((mapping, index) => {
    const path = `${base}/scriptHooks/${index}`;
    if (scriptHookKinds.has(mapping.hook))
      diagnostics.push(
        diagnostic(`${path}/hook`, `Duplicate Room script hook mapping '${mapping.hook}'.`),
      );
    scriptHookKinds.add(mapping.hook);
    if (!project.scripts[mapping.handler.module.$ref.id])
      diagnostics.push(
        diagnostic(
          `${path}/handler/module/$ref`,
          `Missing Script Module '${mapping.handler.module.$ref.id}'.`,
        ),
      );
  });
  validateCondition(project, data.lifecycle.canEnter, `${base}/lifecycle/canEnter`, diagnostics);
  validateCondition(project, data.lifecycle.canLeave, `${base}/lifecycle/canLeave`, diagnostics);
  return diagnostics;
}
