import { parseAssetData } from './project-schema/authoring-assets';
import { parseCharacterData } from './project-schema/authoring-characters';
import type {
  CompiledCondition,
  CompiledProjectWireV1,
  CompiledText,
} from './project-schema/compiled-project';
import {
  COMPILED_PROJECT_SCHEMA,
  COMPILED_PROJECT_SCHEMA_VERSION,
} from './project-schema/compiled-project';
import type { Condition, TextContent } from './project-schema/authoring-flow';
import {
  systemLayoutRoleValues,
  parseLayoutData,
  type LayoutSourceData,
} from './project-schema/authoring-layouts';
import { parseMapData } from './project-schema/authoring-maps';
import { parseInteractableData } from './project-schema/authoring-interactables';
import type { AuthoringProject, AuthoringRecordBase } from './project-schema/authoring-project';
import { parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { parseVariableData } from './project-schema/authoring-variables';
import { parseVerbData } from './project-schema/authoring-verbs';

type WireDefinitions = CompiledProjectWireV1['definitions'];
type WireResources = CompiledProjectWireV1['resources'];

export type SharedCharacterDefinition = WireDefinitions['characters'][number];
export type SharedRoomDefinition = Omit<WireDefinitions['rooms'][number], 'lifecycle'> & {
  lifecycle: Omit<WireDefinitions['rooms'][number]['lifecycle'], 'hooks'>;
};
export type SharedInteractableDefinition = WireDefinitions['interactables'][number];
export type SharedVerbDefinition = Omit<
  WireDefinitions['verbs'][number],
  'availability' | 'defaultProgram'
>;
export type SharedInteractionDefinition = Omit<WireDefinitions['interactions'][number], 'rules'>;
export type SharedSceneDefinition = Omit<
  WireDefinitions['scenes'][number],
  'program' | 'continuation'
>;
export type SharedDialogueDefinition = Omit<
  WireDefinitions['dialogues'][number],
  'program' | 'completion'
>;
export type SharedMapDefinition = WireDefinitions['maps'][number];

/**
 * Phase 4C's deterministic, non-publishable intermediate. Phase 4D/4E add
 * specialized programs and continuations before the strict wire validator is
 * allowed to see a CompiledProjectWireV1.
 */
export interface CompiledProjectSharedDraft {
  schema: typeof COMPILED_PROJECT_SCHEMA;
  schemaVersion: typeof COMPILED_PROJECT_SCHEMA_VERSION;
  project: CompiledProjectWireV1['project'];
  settings: CompiledProjectWireV1['settings'];
  startupHook: CompiledProjectWireV1['startupHook'];
  entrypoint: CompiledProjectWireV1['entrypoint'];
  properties: CompiledProjectWireV1['properties'];
  variables: CompiledProjectWireV1['variables'];
  localization: CompiledProjectWireV1['localization'];
  resources: WireResources;
  definitions: {
    characters: SharedCharacterDefinition[];
    rooms: SharedRoomDefinition[];
    interactables: SharedInteractableDefinition[];
    verbs: SharedVerbDefinition[];
    interactions: SharedInteractionDefinition[];
    scenes: SharedSceneDefinition[];
    dialogues: SharedDialogueDefinition[];
    maps: SharedMapDefinition[];
  };
}

export interface SharedLoweringDiagnostic {
  code: string;
  path: string;
  message: string;
}

export interface SharedLoweringResult {
  diagnostics: SharedLoweringDiagnostic[];
  draft?: CompiledProjectSharedDraft;
}

function sortedEntries<T>(records: Record<string, T>): Array<[string, T]> {
  return Object.entries(records).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assetRef(ref: { $ref: { id: string } } | null | undefined) {
  return ref ? { kind: 'asset' as const, id: ref.$ref.id } : null;
}

function materialRef(ref: { $ref: { id: string } } | null | undefined) {
  return ref ? { kind: 'material' as const, id: ref.$ref.id } : null;
}

function layoutRef(ref: { $ref: { id: string } } | null | undefined) {
  return ref ? { kind: 'layout' as const, id: ref.$ref.id } : null;
}

function characterRef(ref: { $ref: { id: string } } | null | undefined) {
  return ref ? { kind: 'character' as const, id: ref.$ref.id } : null;
}

function roomRef(id: string) {
  return { kind: 'room' as const, id };
}

function compileText(text: TextContent): CompiledText {
  return { markup: text.markup, source: { ...text.source } };
}

function compileCondition(condition: Condition): CompiledCondition {
  if (condition.kind !== 'variable-comparison') return { ...condition };
  return {
    kind: condition.kind,
    operator: condition.operator,
    variable: { kind: 'variable', id: condition.variable.$ref.id },
    ...(condition.value === undefined ? {} : { value: condition.value }),
  };
}

function propertyAssignments(record: AuthoringRecordBase) {
  return Object.entries(record.properties ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([propertyId, value]) => ({ propertyId, value }));
}

function propertyBase(id: string, record: AuthoringRecordBase) {
  return {
    id,
    extends: record.extends ?? null,
    propertyAssignments: propertyAssignments(record),
  };
}

function compileLayoutSource(source: LayoutSourceData) {
  if (source.sourceMode === 'asset' && source.sourceAsset) {
    return {
      kind: 'asset' as const,
      asset: { kind: 'asset' as const, id: source.sourceAsset.$ref.id },
    };
  }
  return { kind: 'inline' as const, text: source.sourceText };
}

function compileEntrypoint(
  entrypoint: NonNullable<AuthoringProject['entrypoint']>,
): CompiledProjectWireV1['entrypoint'] {
  if (entrypoint.kind === 'room') return { kind: 'room', room: roomRef(entrypoint.id) };
  if (entrypoint.kind === 'scene')
    return { kind: 'scene', scene: { kind: 'scene', id: entrypoint.id } };
  return { kind: 'dialogue', dialogue: { kind: 'dialogue', id: entrypoint.id } };
}

export function lowerSharedAuthoringProject(project: AuthoringProject): SharedLoweringResult {
  const diagnostics: SharedLoweringDiagnostic[] = [];
  if (!project.entrypoint) {
    diagnostics.push({
      code: 'COMPILER_ENTRYPOINT_REQUIRED',
      path: '/entrypoint',
      message: 'A Room, Scene, or Dialogue entrypoint is required for compiled gameplay.',
    });
    return { diagnostics };
  }

  const requireData = <T>(value: T | null, path: string): T | undefined => {
    if (value) return value;
    diagnostics.push({
      code: 'COMPILER_VALIDATED_DATA_MISSING',
      path,
      message: 'Validated project data could not be lowered.',
    });
    return undefined;
  };

  const assets: WireResources['assets'] = [];
  for (const [id, record] of sortedEntries(project.assets)) {
    const data = requireData(parseAssetData(record.data), `/assets/${id}/data`);
    if (data)
      assets.push({ id, kind: data.kind, path: data.source.path, aliases: [...data.aliases] });
  }

  const layouts: WireResources['layouts'] = [];
  for (const [id, record] of sortedEntries(project.layouts)) {
    const data = requireData(parseLayoutData(record.data), `/layouts/${id}/data`);
    if (!data) continue;
    layouts.push({
      id,
      kind: data.layoutKind,
      target: data.target,
      rml: compileLayoutSource(data.rml),
      rcss: compileLayoutSource(data.rcss),
      lua: compileLayoutSource(data.lua),
      script: { enabled: data.script.enabled, namespace: data.script.namespace ?? null },
      mount: {
        defaultParent: data.mount.defaultParent ?? null,
        scopedStyles: data.mount.scopedStyles,
      },
      dependencies: {
        images: data.dependencies.images.map((ref) => assetRef(ref)!),
        fonts: data.dependencies.fonts.map((ref) => assetRef(ref)!),
        stylesheets: data.dependencies.stylesheets.map((ref) => assetRef(ref)!),
        materials: data.dependencies.materials.map((ref) => materialRef(ref)!),
        scripts: data.dependencies.scripts.map((ref) => assetRef(ref)!),
      },
    });
  }

  const scripts: WireResources['scripts'] = [];
  for (const [id, record] of sortedEntries(project.scripts)) {
    const data = requireData(parseScriptModuleData(record.data), `/scripts/${id}/data`);
    if (!data) continue;
    scripts.push({
      id,
      source:
        data.source.kind === 'inline-lua'
          ? { kind: 'inline-lua', source: data.source.source }
          : { kind: 'asset', asset: assetRef(data.source.asset)! },
    });
  }

  const characters: SharedCharacterDefinition[] = [];
  for (const [id, record] of sortedEntries(project.characters)) {
    const data = requireData(parseCharacterData(record.data), `/characters/${id}/data`);
    if (!data) continue;
    characters.push({
      ...propertyBase(id, record),
      displayName: data.displayName,
      dialogue: { ...data.dialogue },
      defaults: {
        poseId: data.defaults.poseId,
        expressionId: data.defaults.expressionId,
        ...(data.defaults.idleId ? { idleId: data.defaults.idleId } : {}),
      },
      poses: data.poses.map((pose) => ({
        id: pose.id,
        sprite: assetRef(pose.sprite),
        material: materialRef(pose.material),
        offset: { ...pose.offset },
        scale: pose.scale,
        anchor: { ...pose.anchor },
      })),
      expressions: data.expressions.map((expression) => ({
        id: expression.id,
        poseId: expression.poseId,
        sprite: assetRef(expression.sprite),
        material: materialRef(expression.material),
      })),
      ...(data.idles.length > 0
        ? {
            idles: data.idles.map((idle) => ({
              id: idle.id,
              kind: idle.kind,
              amplitude: idle.amplitude,
              periodMs: idle.periodMs,
              clock: idle.clock,
            })),
          }
        : {}),
      initialWorldState: {
        enabled: data.initialWorldState.enabled,
        visible: data.initialWorldState.visible,
        location:
          data.initialWorldState.location.kind === 'nowhere'
            ? { kind: 'nowhere' }
            : {
                kind: 'room-placement',
                placement: {
                  room: roomRef(data.initialWorldState.location.placement.room),
                  placementId: data.initialWorldState.location.placement.placement,
                },
              },
      },
    });
  }

  const rooms: SharedRoomDefinition[] = [];
  for (const [id, record] of sortedEntries(project.rooms)) {
    const data = requireData(parseRoomData(record.data), `/rooms/${id}/data`);
    if (!data) continue;
    rooms.push({
      ...propertyBase(id, record),
      displayName: data.displayName,
      background: {
        asset: assetRef(data.background.asset),
        material: materialRef(data.background.material),
        fit: data.background.fit,
        color: data.background.color,
      },
      description: compileText(data.description),
      overlays: data.overlays.map((overlay) => ({
        id: overlay.id,
        layout: layoutRef(overlay.layout)!,
        condition: compileCondition(overlay.condition),
        visible: overlay.visible,
        order: overlay.order,
      })),
      placements: data.placements.map((placement, index) => ({
        id: placement.id,
        bounds: { ...placement.bounds },
        order: placement.order ?? index,
        presentation: {
          label: placement.presentation.label ? compileText(placement.presentation.label) : null,
          layout: layoutRef(placement.presentation.layout),
        },
      })),
      cast: data.cast.map((entry) => ({
        id: entry.id,
        character: characterRef(entry.character)!,
        condition: compileCondition(entry.condition),
        placementId: entry.placementId,
        poseId: entry.poseId,
        expressionId: entry.expressionId,
        ...(entry.idleId ? { idleId: entry.idleId } : {}),
        visible: entry.visible,
        order: entry.order,
      })),
      props: data.props.map((entry) => ({
        id: entry.id,
        condition: compileCondition(entry.condition),
        placementId: entry.placementId,
        asset: assetRef(entry.asset),
        material: materialRef(entry.material),
        visible: entry.visible,
        order: entry.order,
      })),
      ...(data.environments.length > 0
        ? {
            environments: data.environments.map((entry) => ({
              id: entry.id,
              condition: compileCondition(entry.condition),
              asset: assetRef(entry.asset),
              material: materialRef(entry.material)!,
              bounds: { ...entry.bounds },
              plane: entry.plane,
              order: entry.order,
              clock: entry.clock,
              scrollPerSecond: { ...entry.scrollPerSecond },
              opacity: entry.opacity,
              visible: entry.visible,
            })),
          }
        : {}),
      compose: data.compose
        ? { script: { kind: 'script', id: data.compose.script.$ref.id } }
        : null,
      exits: data.exits.map((exit) => ({
        id: exit.id,
        label: compileText({ markup: 'plain', source: { kind: 'inline', text: exit.label } }),
        direction: exit.direction,
        target: roomRef(exit.target.$ref.id),
        condition: compileCondition(exit.condition),
        transition: exit.transition ? { ...exit.transition } : null,
      })),
      lifecycle: {
        canEnter: compileCondition(data.lifecycle.canEnter),
        canLeave: compileCondition(data.lifecycle.canLeave),
      },
    });
  }

  const interactables: SharedInteractableDefinition[] = [];
  for (const [id, record] of sortedEntries(project.interactables)) {
    const data = requireData(parseInteractableData(record.data), `/interactables/${id}/data`);
    if (!data) continue;
    const location = data.initialState.location;
    interactables.push({
      ...propertyBase(id, record),
      displayName: data.displayName,
      presentation: {
        sprite: assetRef(data.presentation.sprite),
        material: materialRef(data.presentation.material),
      },
      initialState: {
        enabled: data.initialState.enabled,
        visible: data.initialState.visible,
        location:
          location.kind === 'room-placement'
            ? {
                kind: 'room-placement',
                placement: {
                  room: roomRef(location.placement.room),
                  placementId: location.placement.placement,
                },
              }
            : { kind: location.kind },
      },
    });
  }

  const verbs: SharedVerbDefinition[] = [];
  for (const [id, record] of sortedEntries(project.verbs)) {
    const data = requireData(parseVerbData(record.data), `/verbs/${id}/data`);
    if (data)
      verbs.push({
        ...propertyBase(id, record),
        arity: data.arity,
        operandRoles: [...data.operandRoles],
        actionText: compileText(data.actionText),
        quickAction: data.quickAction,
      });
  }

  const interactions: SharedInteractionDefinition[] = [];
  for (const [id, record] of sortedEntries(project.interactions)) {
    const data = requireData(parseInteractionData(record.data), `/interactions/${id}/data`);
    if (data) interactions.push({ ...propertyBase(id, record) });
  }

  const scenes: SharedSceneDefinition[] = [];
  for (const [id, record] of sortedEntries(project.scenes)) {
    const data = requireData(parseSceneData(record.data), `/scenes/${id}/data`);
    if (!data) continue;
    scenes.push({
      ...propertyBase(id, record),
      displayName: data.displayName,
      defaultBackground: {
        asset: assetRef(data.defaultBackground.asset),
        material: materialRef(data.defaultBackground.material),
        color: data.defaultBackground.color,
        fit: data.defaultBackground.fit,
      },
      defaultLayout: layoutRef(data.defaultLayout),
    });
  }

  const dialogues: SharedDialogueDefinition[] = [];
  for (const [id, record] of sortedEntries(project.dialogues)) {
    const data = requireData(parseDialogueData(record.data), `/dialogues/${id}/data`);
    if (data)
      dialogues.push({
        ...propertyBase(id, record),
        displayName: data.displayName,
        defaultSpeaker: characterRef(data.defaultSpeaker),
        settings: { ...data.settings },
      });
  }

  const maps: SharedMapDefinition[] = [];
  for (const [id, record] of sortedEntries(project.maps)) {
    const data = requireData(parseMapData(record.data), `/maps/${id}/data`);
    if (!data) continue;
    maps.push({
      ...propertyBase(id, record),
      presentation: {
        title: data.presentation.title ? compileText(data.presentation.title) : null,
        background: assetRef(data.presentation.background),
        layout: layoutRef(data.presentation.layout),
        initialMode: data.presentation.initialMode,
      },
      locations: data.locations.map((location) => ({
        id: location.id,
        room: roomRef(location.room.$ref.id),
        position: { ...location.position },
        shape: { ...location.shape },
        label: location.label ? compileText(location.label) : null,
      })),
      connections: data.connections.map((connection) => ({
        id: connection.id,
        exit: { room: roomRef(connection.exit.room), exitId: connection.exit.exit },
        sourceLocationId: connection.sourceLocation,
        targetLocationId: connection.targetLocation,
      })),
    });
  }

  const properties = sortedEntries(project.properties).map(([id, definition]) => ({
    id,
    label: definition.label,
    description: definition.description ?? '',
    type: definition.type,
    nullable: definition.nullable,
    ...(definition.defaultValue === undefined ? {} : { defaultValue: definition.defaultValue }),
    enumValues: [...(definition.enumValues ?? [])],
    ownerKinds: [...definition.ownerKinds],
    persistence: definition.persistence,
  }));

  const variables: CompiledProjectWireV1['variables'] = [];
  for (const [id, record] of sortedEntries(project.variables)) {
    const data = requireData(parseVariableData(record.data), `/variables/${id}/data`);
    if (data)
      variables.push({
        id,
        type: data.type,
        defaultValue: data.defaultValue,
        enumValues: [...(data.enumValues ?? [])],
      });
  }

  if (diagnostics.length > 0) return { diagnostics };
  const settings = project.settings;
  const draft: CompiledProjectSharedDraft = {
    schema: COMPILED_PROJECT_SCHEMA,
    schemaVersion: COMPILED_PROJECT_SCHEMA_VERSION,
    project: { ...project.project },
    settings: {
      display: {
        aspectRatio: { ...settings.display.aspectRatio },
        orientation: settings.display.orientation,
        barColor: settings.display.barColor,
      },
      text: { defaultFont: assetRef(settings.text.defaultFont) },
      titleScreen: {
        titleImage: assetRef(settings.titleScreen.titleImage),
        showProjectTitle: settings.titleScreen.showProjectTitle,
        showAuthor: settings.titleScreen.showAuthor,
        subtitle: settings.titleScreen.subtitle,
        startLabel: settings.titleScreen.startLabel,
      },
      roomNavigationTransition: { ...settings.presentation.roomNavigationTransition },
      systemLayouts: systemLayoutRoleValues.map((role) => ({
        role,
        layout: layoutRef(settings.ui.systemLayouts[role]),
      })),
    },
    startupHook: project.startupHook ? { source: project.startupHook.source } : null,
    entrypoint: compileEntrypoint(project.entrypoint),
    properties,
    variables,
    localization: {
      defaultLocale: project.localization.defaultLocale,
      fallbackLocale: project.localization.fallbackLocale,
      catalogs: sortedEntries(project.localization.catalogs).map(([locale, entries]) => ({
        locale,
        entries: sortedEntries(entries).map(([key, value]) => ({ key, value })),
      })),
    },
    resources: { assets, layouts, scripts },
    definitions: { characters, rooms, interactables, verbs, interactions, scenes, dialogues, maps },
  };
  return { diagnostics, draft };
}
