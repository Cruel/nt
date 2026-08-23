import { parseAssetData } from './project-schema/authoring-assets';
import {
  resolveArchetypeConfiguration,
  resolveGameplayInstanceRecord,
} from './project-schema/authoring-archetypes';
import { parseCharacterData } from './project-schema/authoring-characters';
import type {
  CompiledCondition,
  CompiledProjectWireV4,
  CompiledText,
} from './project-schema/compiled-project';
import {
  COMPILED_PROJECT_SCHEMA,
  COMPILED_PROJECT_SCHEMA_VERSION,
} from './project-schema/compiled-project';
import type { Condition, TextContent } from './project-schema/authoring-flow';
import type {
  FeatureData,
  InteractionSubjectData,
  InteractableHotspotTarget,
  RoomHotspotTarget,
} from './project-schema/authoring-features';
import {
  systemLayoutRoleValues,
  parseLayoutData,
  resolveLayoutScalePolicy,
  type LayoutSourceData,
  type LayoutStateShapeData,
} from './project-schema/authoring-layouts';
import { parseMapData } from './project-schema/authoring-maps';
import {
  parseInteractableData,
  type InteractableData,
} from './project-schema/authoring-interactables';
import {
  parseItemDefinitionData,
  parseItemStackData,
  type ItemStackData,
} from './project-schema/authoring-items';
import type { InventoryReferenceData } from './project-schema/authoring-inventories';
import type { AuthoringProject, AuthoringRecordBase } from './project-schema/authoring-project';
import { compileRoomNavigationTransition, parseRoomData } from './project-schema/authoring-rooms';
import { parseSceneData } from './project-schema/authoring-scenes';
import { parseDialogueData } from './project-schema/authoring-dialogues';
import { parseInteractionData } from './project-schema/authoring-interactions';
import { parseScriptModuleData } from './project-schema/authoring-script-modules';
import { parseVariableData } from './project-schema/authoring-variables';
import { parseVerbData, type SubjectSelector } from './project-schema/authoring-verbs';

type WireDefinitions = CompiledProjectWireV4['definitions'];
type WireResources = CompiledProjectWireV4['resources'];

export type SharedCharacterDefinition = WireDefinitions['characters'][number];
export type SharedRoomDefinition = Omit<WireDefinitions['rooms'][number], 'lifecycle'> & {
  lifecycle: Omit<WireDefinitions['rooms'][number]['lifecycle'], 'hooks'>;
};
export type SharedInteractableDefinition = WireDefinitions['interactables'][number];
export type SharedItemDefinition = WireDefinitions['itemDefinitions'][number];
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
 * Deterministic, non-publishable intermediate. Specialized programs and
 * continuations extend it before the strict wire validator is allowed to see
 * the current compiled-project wire shape.
 */
export interface CompiledProjectSharedDraft {
  schema: typeof COMPILED_PROJECT_SCHEMA;
  schemaVersion: typeof COMPILED_PROJECT_SCHEMA_VERSION;
  project: CompiledProjectWireV4['project'];
  settings: CompiledProjectWireV4['settings'];
  bootstrapModule: CompiledProjectWireV4['bootstrapModule'];
  entrypoint: CompiledProjectWireV4['entrypoint'];
  properties: CompiledProjectWireV4['properties'];
  traits: CompiledProjectWireV4['traits'];
  archetypes: CompiledProjectWireV4['archetypes'];
  inventories: CompiledProjectWireV4['inventories'];
  itemStacks: CompiledProjectWireV4['itemStacks'];
  localization: CompiledProjectWireV4['localization'];
  resources: WireResources;
  saveContract: CompiledProjectWireV4['saveContract'];
  definitions: {
    characters: SharedCharacterDefinition[];
    rooms: SharedRoomDefinition[];
    interactables: SharedInteractableDefinition[];
    itemDefinitions: SharedItemDefinition[];
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

function compileHighlight(highlight: {
  kind: 'default' | 'material' | 'none';
  material?: { $ref: { id: string } };
}) {
  return highlight.kind === 'material'
    ? { kind: 'material' as const, material: materialRef(highlight.material)! }
    : { kind: highlight.kind };
}

export function compileInteractionSubject(subject: InteractionSubjectData) {
  if (subject.kind === 'character')
    return { kind: 'character' as const, character: characterRef(subject.character)! };
  if (subject.kind === 'interactable')
    return {
      kind: 'interactable' as const,
      interactable: { kind: 'interactable' as const, id: subject.interactable.$ref.id },
    };
  if (subject.kind === 'item-stack')
    return {
      kind: 'item-stack' as const,
      itemStack: { kind: 'item-stack' as const, id: subject.itemStack.$ref.id },
    };
  return {
    kind: 'feature' as const,
    feature:
      subject.feature.ownerKind === 'room'
        ? {
            ownerKind: 'room' as const,
            room: roomRef(subject.feature.room.$ref.id),
            featureId: subject.feature.featureId,
          }
        : {
            ownerKind: 'interactable' as const,
            interactable: {
              kind: 'interactable' as const,
              id: subject.feature.interactable.$ref.id,
            },
            featureId: subject.feature.featureId,
          },
  };
}

export function compileSubjectSelector(selector: SubjectSelector) {
  if (selector.kind === 'any-subject') return { kind: 'any-subject' as const };
  if (selector.kind === 'family') return { kind: 'family' as const, family: selector.family };
  if (selector.kind === 'trait')
    return {
      kind: 'trait' as const,
      trait: { kind: 'trait' as const, id: selector.trait.$ref.id },
    };
  if (selector.kind === 'item-definition')
    return {
      kind: 'item-definition' as const,
      itemDefinition: { kind: 'item-definition' as const, id: selector.itemDefinition.$ref.id },
    };
  if (selector.kind === 'qualified-pattern')
    return {
      kind: 'qualified-pattern' as const,
      family: selector.family,
      pattern: selector.pattern,
    };
  return { kind: 'exact' as const, subject: compileInteractionSubject(selector.subject) };
}

function compileRoomHotspotTarget(target: RoomHotspotTarget) {
  if (target.kind === 'owner-feature') return { ...target };
  if (target.kind === 'exit') return { ...target };
  return { kind: 'subject' as const, subject: compileInteractionSubject(target.subject) };
}

function compileInteractableHotspotTarget(target: InteractableHotspotTarget) {
  if (target.kind === 'owner' || target.kind === 'owner-feature') return { ...target };
  return { kind: 'subject' as const, subject: compileInteractionSubject(target.subject) };
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
  const source = text.source;
  return {
    markup: text.markup,
    source:
      source.kind === 'inline'
        ? { kind: 'inline', text: source.text }
        : source.kind === 'localized'
          ? { kind: 'localized', key: source.key }
          : { kind: 'lua-expression', source: source.source },
  };
}

function compileCondition(condition: Condition): CompiledCondition {
  if (condition.kind === 'always') return { kind: 'always' };
  if (condition.kind === 'lua-predicate') {
    return { kind: 'lua-predicate', source: condition.source };
  }
  return {
    kind: 'global-property-comparison',
    operator: condition.operator,
    property: { kind: 'property', id: condition.variable.$ref.id },
    ...(condition.value === undefined ? {} : { value: condition.value }),
  };
}

function propertyAssignments(record: Pick<AuthoringRecordBase, 'properties'>) {
  return Object.entries(record.properties ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([propertyId, value]) => ({ propertyId, value }));
}

function definitionBase(id: string) {
  return { id };
}

function propertyBase(id: string, record: Pick<AuthoringRecordBase, 'traits' | 'properties'>) {
  return {
    id,
    traits: [...(record.traits ?? [])].sort(),
    propertyAssignments: propertyAssignments(record),
  };
}

function compileInventories(inventories: readonly { id: string; label: string }[]) {
  return inventories.map((inventory) => ({ ...inventory }));
}

function compileInventoryReference(inventory: InventoryReferenceData) {
  const owner = inventory.owner;
  const compiledOwner =
    owner.kind === 'project'
      ? { kind: 'project' as const }
      : owner.kind === 'character'
        ? {
            kind: 'character' as const,
            character: { kind: 'character' as const, id: owner.character.$ref.id },
          }
        : owner.kind === 'interactable'
          ? {
              kind: 'interactable' as const,
              interactable: { kind: 'interactable' as const, id: owner.interactable.$ref.id },
            }
          : owner.kind === 'room-feature'
            ? {
                kind: 'room-feature' as const,
                room: roomRef(owner.room.$ref.id),
                featureId: owner.featureId,
              }
            : {
                kind: 'interactable-feature' as const,
                interactable: {
                  kind: 'interactable' as const,
                  id: owner.interactable.$ref.id,
                },
                featureId: owner.featureId,
              };
  return { owner: compiledOwner, inventoryId: inventory.inventoryId };
}

function compileInteractableLocation(location: InteractableData['initialState']['location']) {
  if (location.kind === 'unplaced') return { kind: 'unplaced' as const };
  if (location.kind === 'room')
    return { kind: 'room' as const, room: roomRef(location.room.$ref.id) };
  return {
    kind: 'inventory' as const,
    inventory: compileInventoryReference(location.inventory),
  };
}

function compileItemStackLocation(location: ItemStackData['location']) {
  return compileInteractableLocation(location);
}

function compileFeature(feature: FeatureData) {
  return {
    ...propertyBase(feature.id, feature),
    label: feature.label,
    inventories: compileInventories(feature.inventories),
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

function compileLayoutStateShape(shape: LayoutStateShapeData): unknown {
  const common = {
    type: shape.type,
    nullable: shape.nullable,
    hasDefault: Object.prototype.hasOwnProperty.call(shape, 'defaultValue'),
    defaultValue: shape.defaultValue ?? null,
  };
  if (shape.type === 'array') return { ...common, items: compileLayoutStateShape(shape.items) };
  if (shape.type === 'object')
    return {
      ...common,
      fields: Object.entries(shape.fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, field]) => ({
          id,
          required: field.required,
          shape: compileLayoutStateShape(field.shape),
        })),
    };
  return common;
}

function compileEntrypoint(
  entrypoint: NonNullable<AuthoringProject['entrypoint']>,
): CompiledProjectWireV4['entrypoint'] {
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
    if (data) {
      if (data.kind === 'image') {
        if (!data.imageMetadata) {
          diagnostics.push({
            code: 'hotspot.compiled.image_metadata_missing',
            path: `/assets/${id}/data/imageMetadata`,
            message: `Image Asset '${id}' requires image metadata before compilation.`,
          });
          continue;
        }
        assets.push({
          id,
          kind: data.kind,
          path: data.source.path,
          aliases: [...data.aliases],
          sampling: data.sampling ?? 'linear',
          width: data.imageMetadata.width,
          height: data.imageMetadata.height,
        });
      } else {
        assets.push({
          id,
          kind: data.kind,
          path: data.source.path,
          aliases: [...data.aliases],
        });
      }
    }
  }

  const layouts: WireResources['layouts'] = [];
  for (const [id, record] of sortedEntries(project.layouts)) {
    const data = requireData(parseLayoutData(record.data), `/layouts/${id}/data`);
    if (!data) continue;
    const contract = {
      inputs: Object.entries(data.contract.inputs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([inputId, input]) => ({
          id: inputId,
          type: input.type,
          nullable: input.nullable,
          hasDefault: Object.prototype.hasOwnProperty.call(input, 'defaultValue'),
          defaultValue: input.defaultValue ?? null,
        })),
      signals: Object.entries(data.contract.signals)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([signalId, signal]) => ({
          id: signalId,
          fields: Object.entries(signal.fields)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([fieldId, field]) => ({
              id: fieldId,
              type: field.type,
              nullable: field.nullable,
              required: field.required,
            })),
        })),
      state: data.contract.state ? compileLayoutStateShape(data.contract.state) : null,
    };
    layouts.push({
      id,
      kind: data.layoutKind,
      target: data.target,
      scalePolicy: resolveLayoutScalePolicy(data.target, data.scalePolicy),
      ...(contract.inputs.length > 0 || contract.signals.length > 0 || contract.state !== null
        ? { contract }
        : {}),
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
    const effectiveRecord = resolveGameplayInstanceRecord(project, 'character', record);
    const data = requireData(parseCharacterData(effectiveRecord?.data), `/characters/${id}/data`);
    if (!data || !effectiveRecord) continue;
    characters.push({
      ...propertyBase(id, effectiveRecord),
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
      inventories: compileInventories(data.inventories),
      initialWorldState: {
        enabled: data.initialWorldState.enabled,
        visible: data.initialWorldState.visible,
        location:
          data.initialWorldState.location.kind === 'unplaced'
            ? { kind: 'unplaced' }
            : { kind: 'room', room: roomRef(data.initialWorldState.location.room.$ref.id) },
      },
    });
  }

  const rooms: SharedRoomDefinition[] = [];
  for (const [id, record] of sortedEntries(project.rooms)) {
    const effectiveRecord = resolveGameplayInstanceRecord(project, 'room', record);
    const data = requireData(parseRoomData(effectiveRecord?.data), `/rooms/${id}/data`);
    if (!data || !effectiveRecord) continue;
    rooms.push({
      ...propertyBase(id, effectiveRecord),
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
      features: data.features.map(compileFeature),
      hotspots: data.hotspots.map((hotspot) => ({
        id: hotspot.id,
        label: hotspot.label,
        condition: compileCondition(hotspot.condition),
        inputOrder: hotspot.inputOrder,
        highlight: compileHighlight(hotspot.highlight),
        shape: { kind: 'rect', bounds: { ...hotspot.shape.bounds } },
        target: compileRoomHotspotTarget(hotspot.target),
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
      interactables: data.interactables.map((entry) => ({
        id: entry.id,
        interactable: { kind: 'interactable', id: entry.interactable.$ref.id },
        condition: compileCondition(entry.condition),
        placementId: entry.placementId,
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
      scriptHooks: data.scriptHooks.map((mapping) => ({
        hook: mapping.hook,
        handler: {
          module: { kind: 'script', id: mapping.handler.module.$ref.id },
          export: mapping.handler.export.trim(),
        },
      })),
      exits: data.exits.map((exit) => ({
        id: exit.id,
        label: compileText({ markup: 'plain', source: { kind: 'inline', text: exit.label } }),
        direction: exit.direction,
        target: roomRef(exit.target.$ref.id),
        condition: compileCondition(exit.condition),
        transition: exit.transition ? compileRoomNavigationTransition(exit.transition) : null,
      })),
      lifecycle: {
        canEnter: compileCondition(data.lifecycle.canEnter),
        canLeave: compileCondition(data.lifecycle.canLeave),
      },
    });
  }

  const interactables: SharedInteractableDefinition[] = [];
  for (const [id, record] of sortedEntries(project.interactables)) {
    const effectiveRecord = resolveGameplayInstanceRecord(project, 'interactable', record);
    const data = requireData(
      parseInteractableData(effectiveRecord?.data),
      `/interactables/${id}/data`,
    );
    if (!data || !effectiveRecord) continue;
    const hotspotDefinition = data.presentation.hotspots!;
    interactables.push({
      ...propertyBase(id, effectiveRecord),
      displayName: data.displayName,
      features: data.features.map(compileFeature),
      inventories: compileInventories(data.inventories),
      presentation: {
        sprite: assetRef(data.presentation.sprite),
        material: materialRef(data.presentation.material),
        hotspots:
          hotspotDefinition.kind === 'sprite-alpha'
            ? {
                kind: 'sprite-alpha',
                hotspot: {
                  ...hotspotDefinition.hotspot,
                  condition: compileCondition(hotspotDefinition.hotspot.condition),
                  highlight: compileHighlight(hotspotDefinition.hotspot.highlight),
                  target: compileInteractableHotspotTarget(hotspotDefinition.hotspot.target),
                },
              }
            : {
                kind: 'custom',
                hotspots: hotspotDefinition.hotspots.map((hotspot) => ({
                  id: hotspot.id,
                  label: hotspot.label,
                  condition: compileCondition(hotspot.condition),
                  inputOrder: hotspot.inputOrder,
                  highlight: compileHighlight(hotspot.highlight),
                  target: compileInteractableHotspotTarget(hotspot.target),
                  shape: { kind: 'rect', bounds: { ...hotspot.shape.bounds } },
                })),
              },
      },
      initialState: {
        enabled: data.initialState.enabled,
        visible: data.initialState.visible,
        location: compileInteractableLocation(data.initialState.location),
      },
    });
  }

  const itemDefinitions: SharedItemDefinition[] = [];
  for (const [id, record] of sortedEntries(project.itemDefinitions)) {
    const data = requireData(parseItemDefinitionData(record.data), `/itemDefinitions/${id}/data`);
    if (!data) continue;
    itemDefinitions.push({
      ...propertyBase(id, record),
      displayName: data.displayName,
      description: data.description,
      presentation: {
        sprite: assetRef(data.presentation.sprite),
        material: materialRef(data.presentation.material),
      },
      stackLimit: data.stackLimit,
    });
  }

  const itemStacks: CompiledProjectWireV4['itemStacks'] = [];
  for (const [id, record] of sortedEntries(project.itemStacks)) {
    const data = requireData(parseItemStackData(record.data), `/itemStacks/${id}/data`);
    if (!data) continue;
    itemStacks.push({
      id,
      definition: { kind: 'item-definition', id: data.definition.$ref.id },
      quantity: data.quantity,
      location: compileItemStackLocation(data.location),
    });
  }

  const verbs: SharedVerbDefinition[] = [];
  for (const [id, record] of sortedEntries(project.verbs)) {
    const data = requireData(parseVerbData(record.data), `/verbs/${id}/data`);
    if (data)
      verbs.push({
        ...definitionBase(id),
        slots: data.slots.map((slot) => ({
          id: slot.id,
          label: compileText(slot.label),
          prompt: compileText(slot.prompt),
          selectors: slot.selectors.map(compileSubjectSelector),
        })),
        bindingOrder: [...data.bindingOrder],
        actionText: compileText(data.actionText),
        completedCommandText: compileText(data.completedCommandText),
        quickAction: data.quickAction,
      });
  }

  const interactions: SharedInteractionDefinition[] = [];
  for (const [id, record] of sortedEntries(project.interactions)) {
    const data = requireData(parseInteractionData(record.data), `/interactions/${id}/data`);
    if (data) interactions.push({ ...definitionBase(id) });
  }

  const scenes: SharedSceneDefinition[] = [];
  for (const [id, record] of sortedEntries(project.scenes)) {
    const data = requireData(parseSceneData(record.data), `/scenes/${id}/data`);
    if (!data) continue;
    scenes.push({
      ...definitionBase(id),
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
        ...definitionBase(id),
        displayName: data.displayName,
        defaultSpeaker: characterRef(data.defaultSpeaker),
        settings: { ...data.settings },
      });
  }

  const maps: SharedMapDefinition[] = [];
  for (const [id, record] of sortedEntries(project.maps)) {
    const data = requireData(parseMapData(record.data), `/maps/${id}/data`);
    if (!data) continue;
    const locationByRoom = new Map(
      data.locations.map((location) => [location.room.$ref.id, location.id] as const),
    );
    maps.push({
      ...definitionBase(id),
      presentation: {
        title: data.presentation.title ? compileText(data.presentation.title) : null,
        background: assetRef(data.presentation.background),
        layout: layoutRef(data.presentation.layout),
        initialMode: data.presentation.initialMode,
      },
      locations: data.locations.map((location) => ({
        id: location.id,
        room: roomRef(location.room.$ref.id),
        regions: location.regions.map((region) => ({
          points: region.points.map((point) => ({ ...point })),
        })),
        label: location.label ? compileText(location.label) : null,
        icon: assetRef(location.icon),
        style: location.style,
        labelAnchor: location.labelAnchor ? { ...location.labelAnchor } : null,
        connectionAnchor: location.connectionAnchor ? { ...location.connectionAnchor } : null,
        visibility: compileCondition(location.visibility),
        pickOrder: location.pickOrder,
        logicalOrder: location.logicalOrder,
      })),
      connections: data.connections.map((connection) => {
        const first = connection.exits[0];
        const sourceRoom = first.room;
        const sourceExit = parseRoomData(project.rooms[sourceRoom]?.data)?.exits.find(
          (exit) => exit.id === first.exit,
        );
        return {
          id: connection.id,
          exits: connection.exits.map((exit) => ({
            room: roomRef(exit.room),
            exitId: exit.exit,
          })),
          sourceLocationId: locationByRoom.get(sourceRoom) ?? '',
          targetLocationId: locationByRoom.get(sourceExit?.target.$ref.id ?? '') ?? '',
          label: connection.label ? compileText(connection.label) : null,
          icon: assetRef(connection.icon),
          style: connection.style,
          visibility: compileCondition(connection.visibility),
          logicalOrder: connection.logicalOrder,
          path: connection.path.map((point) => ({ ...point })),
          hitRegions: connection.hitRegions.map((region) => ({
            points: region.points.map((point) => ({ ...point })),
          })),
        };
      }),
    });
  }

  const archetypes: CompiledProjectWireV4['archetypes'] = [];
  for (const [id, record] of sortedEntries(project.archetypes)) {
    const configuration = resolveArchetypeConfiguration(project, id);
    if (!configuration) {
      diagnostics.push({
        code: 'authoring.compile.invalid-archetype',
        path: `/archetypes/${id}`,
        message: `Archetype '${id}' does not resolve to a valid compiled configuration.`,
      });
      continue;
    }
    const kind = record.data.instanceKind;
    if (kind === 'room') {
      const data = requireData(parseRoomData(configuration.data), `/archetypes/${id}/data`);
      if (!data) continue;
      const identity = {
        traits: [...configuration.traits].sort(),
        propertyAssignments: propertyAssignments(configuration),
      };
      const declared = {
        ...identity,
        displayName: data.displayName,
        background: {
          asset: assetRef(data.background.asset),
          material: materialRef(data.background.material),
          fit: data.background.fit,
          color: data.background.color,
        },
        description: compileText(data.description),
        exits: data.exits.map((exit) => ({
          id: exit.id,
          label: compileText({ markup: 'plain', source: { kind: 'inline', text: exit.label } }),
          direction: exit.direction,
          target: roomRef(exit.target.$ref.id),
          condition: compileCondition(exit.condition),
          transition: exit.transition ? compileRoomNavigationTransition(exit.transition) : null,
        })),
        lifecycle: {
          canEnter: compileCondition(data.lifecycle.canEnter),
          canLeave: compileCondition(data.lifecycle.canLeave),
          hooks: [],
        },
        overlays: data.overlays.map((overlay) => ({
          id: overlay.id,
          layout: layoutRef(overlay.layout)!,
          condition: compileCondition(overlay.condition),
          visible: overlay.visible,
          order: overlay.order,
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
        interactables: data.interactables.map((entry) => ({
          id: entry.id,
          interactable: { kind: 'interactable' as const, id: entry.interactable.$ref.id },
          condition: compileCondition(entry.condition),
          placementId: entry.placementId,
          visible: entry.visible,
          order: entry.order,
        })),
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
        scriptHooks: data.scriptHooks.map((mapping) => ({
          hook: mapping.hook,
          handler: {
            module: { kind: 'script' as const, id: mapping.handler.module.$ref.id },
            export: mapping.handler.export.trim(),
          },
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
        features: data.features.map(compileFeature),
        hotspots: data.hotspots.map((hotspot) => ({
          id: hotspot.id,
          label: hotspot.label,
          condition: compileCondition(hotspot.condition),
          inputOrder: hotspot.inputOrder,
          highlight: compileHighlight(hotspot.highlight),
          shape: { kind: 'rect' as const, bounds: { ...hotspot.shape.bounds } },
          target: compileRoomHotspotTarget(hotspot.target),
        })),
      };
      archetypes.push({ id, instanceKind: 'room', configuration: declared });
    } else if (kind === 'character') {
      const raw = {
        ...(configuration.data as object),
        initialWorldState: { location: { kind: 'unplaced' }, enabled: true, visible: true },
      };
      const data = requireData(parseCharacterData(raw), `/archetypes/${id}/data`);
      if (!data) continue;
      archetypes.push({
        id,
        instanceKind: 'character',
        configuration: {
          traits: [...configuration.traits].sort(),
          propertyAssignments: propertyAssignments(configuration),
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
          inventories: compileInventories(data.inventories),
        },
      });
    } else {
      const raw = {
        ...(configuration.data as object),
        initialState: { location: { kind: 'unplaced' }, enabled: true, visible: true },
      };
      const data = requireData(parseInteractableData(raw), `/archetypes/${id}/data`);
      if (!data) continue;
      const hotspotDefinition = data.presentation.hotspots!;
      archetypes.push({
        id,
        instanceKind: 'interactable',
        configuration: {
          traits: [...configuration.traits].sort(),
          propertyAssignments: propertyAssignments(configuration),
          displayName: data.displayName,
          features: data.features.map(compileFeature),
          inventories: compileInventories(data.inventories),
          presentation: {
            sprite: assetRef(data.presentation.sprite),
            material: materialRef(data.presentation.material),
            hotspots:
              hotspotDefinition.kind === 'sprite-alpha'
                ? {
                    kind: 'sprite-alpha',
                    hotspot: {
                      ...hotspotDefinition.hotspot,
                      condition: compileCondition(hotspotDefinition.hotspot.condition),
                      highlight: compileHighlight(hotspotDefinition.hotspot.highlight),
                      target: compileInteractableHotspotTarget(hotspotDefinition.hotspot.target),
                    },
                  }
                : {
                    kind: 'custom',
                    hotspots: hotspotDefinition.hotspots.map((hotspot) => ({
                      id: hotspot.id,
                      label: hotspot.label,
                      condition: compileCondition(hotspot.condition),
                      inputOrder: hotspot.inputOrder,
                      highlight: compileHighlight(hotspot.highlight),
                      target: compileInteractableHotspotTarget(hotspot.target),
                      shape: { kind: 'rect', bounds: { ...hotspot.shape.bounds } },
                    })),
                  },
          },
        },
      });
    }
  }

  const properties: CompiledProjectWireV4['properties'] = sortedEntries(project.properties).map(
    ([id, definition]) => ({
      id,
      label: definition.label,
      description: definition.description ?? '',
      type: definition.type,
      nullable: definition.nullable,
      ...(definition.defaultValue === undefined ? {} : { defaultValue: definition.defaultValue }),
      enumValues: [...(definition.enumValues ?? [])],
      ownerKinds: [...definition.ownerKinds],
      scope: 'identity' as const,
    }),
  );

  const traits: CompiledProjectWireV4['traits'] = sortedEntries(project.traits).map(
    ([id, trait]) => ({
      id,
      label: trait.label,
      description: trait.description ?? '',
      ownerKinds: [...trait.ownerKinds].sort(),
      properties: trait.properties
        .map((property) => ({ ...property }))
        .sort((left, right) => left.propertyId.localeCompare(right.propertyId)),
    }),
  );

  const propertyIds = new Set(properties.map((property) => property.id));
  for (const [id, record] of sortedEntries(project.variables)) {
    const data = requireData(parseVariableData(record.data), `/variables/${id}/data`);
    if (!data) continue;
    if (propertyIds.has(id)) {
      diagnostics.push({
        code: 'authoring.compile.global-property-id-collision',
        path: `/variables/${id}/id`,
        message: `Variable '${id}' conflicts with a Property declaration using the same ID.`,
      });
      continue;
    }
    propertyIds.add(id);
    properties.push({
      id,
      label: record.label,
      description: record.description ?? '',
      type: data.type,
      nullable: false,
      defaultValue: data.defaultValue,
      enumValues: [...(data.enumValues ?? [])],
      scope: 'global',
    });
  }

  if (diagnostics.length > 0) return { diagnostics };
  const settings = project.settings;
  const draft: CompiledProjectSharedDraft = {
    schema: COMPILED_PROJECT_SCHEMA,
    schemaVersion: COMPILED_PROJECT_SCHEMA_VERSION,
    saveContract: 'sc1:00000000000000000000000000000000',
    project: { ...project.project },
    settings: {
      display: {
        referenceResolution: { ...settings.display.referenceResolution },
        worldRasterPolicy: settings.display.worldRasterPolicy,
        barColor: settings.display.barColor,
      },
      accessibility: {
        uiScale: { ...settings.accessibility.uiScale },
        textScale: { ...settings.accessibility.textScale },
      },
      text: { defaultFont: assetRef(settings.text.defaultFont) },
      titleScreen: {
        titleImage: assetRef(settings.titleScreen.titleImage),
        showProjectTitle: settings.titleScreen.showProjectTitle,
        showAuthor: settings.titleScreen.showAuthor,
        subtitle: settings.titleScreen.subtitle,
        startLabel: settings.titleScreen.startLabel,
      },
      roomNavigationTransition: compileRoomNavigationTransition(
        settings.presentation.roomNavigationTransition,
      ),
      systemLayouts: systemLayoutRoleValues.map((role) => ({
        role,
        layout: layoutRef(settings.ui.systemLayouts[role]),
      })),
    },
    bootstrapModule: { kind: 'script', id: project.bootstrapModule.$ref.id },
    entrypoint: compileEntrypoint(project.entrypoint),
    properties,
    traits,
    archetypes,
    inventories: compileInventories(project.inventories),
    itemStacks,
    localization: {
      defaultLocale: project.localization.defaultLocale,
      fallbackLocale: project.localization.fallbackLocale,
      catalogs: sortedEntries(project.localization.catalogs).map(([locale, entries]) => ({
        locale,
        entries: sortedEntries(entries).map(([key, value]) => ({ key, value })),
      })),
    },
    resources: { assets, layouts, scripts },
    definitions: {
      characters,
      rooms,
      interactables,
      itemDefinitions,
      verbs,
      interactions,
      scenes,
      dialogues,
      maps,
    },
  };
  return { diagnostics, draft };
}
