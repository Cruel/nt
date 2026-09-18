import type {
  AuthoringDependencyGraphDiagnostic,
  AuthoringDependencyGraphSnapshot,
  AuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-contracts';
import {
  recordContributionKey,
  serializeAuthoringDependencyNodeKey,
} from '../../shared/authoring-dependency-graph';
import type {
  PreviewResourceManifestEntry,
  RoomPreviewInputs,
} from '../../shared/focused-preview-contracts';
import { analyzeHookRegistry } from '../../shared/hook-registry-analysis';
import { lowerManagedLuaLocalizationForFocusedPreview } from '../../shared/authoring-lua-localization-lowering';
import { lowerLayoutContractForWire } from '../../shared/layout-contract-lowering';
import { resolveMessage } from '../../shared/message-resolution';
import {
  resolveStructuredMessageText,
  structuredMessageForPath,
} from '../../shared/authoring-structured-messages';
import { effectivePreviewDisplay } from '../../shared/preview-display';
import { effectivePreviewLocale, projectWithPreviewLocale } from '../../shared/preview-locale';
import {
  PSEUDO_PREVIEW_LOCALE,
  pseudoLocalizeRmlMessages,
  pseudoLocalizeText,
} from '../../shared/pseudo-localization';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type { CursorTarget } from '../../shared/project-schema/authoring-cursor-vocabulary';
import type {
  InteractableHotspotTarget,
  InteractionSubjectData,
  RoomHotspotTarget,
} from '../../shared/project-schema/authoring-features';
import {
  gameplayInstanceKindForCollection,
  resolveGameplayInstanceRecord,
} from '../../shared/project-schema/authoring-archetypes';
import {
  parseCharacterData,
  type CharacterData,
} from '../../shared/project-schema/authoring-characters';
import { resolveCharacterPresentationLayers } from '../../shared/project-schema/character-project';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import { parseInteractableData } from '../../shared/project-schema/authoring-interactables';
import {
  parseLayoutData,
  type LayoutLuaSourceData,
  type LayoutSourceData,
} from '../../shared/project-schema/authoring-layouts';
import { authoredLayoutSourceUrl } from '../../shared/project-schema/layout-source-url';
import type { AuthoringSourceAnalysisArtifact } from '../../shared/project-schema/authoring-lua-analysis';
import { resolveMaterialData } from '../../shared/project-schema/authoring-materials';
import { parseRoomData, type RoomData } from '../../shared/project-schema/authoring-rooms';
import {
  roomPreviewDocumentSchema,
  type RoomPreviewDocument,
} from '../../shared/project-schema/room-preview';
import { parseScriptModuleData } from '../../shared/project-schema/authoring-script-modules';
import { buildShaderMaterialProject } from '../../shared/project-schema/shader-material-project';
import { parseVariableData } from '../../shared/project-schema/authoring-variables';
import type { ShaderVariant } from '../../shared/shader-variants';
import { projectOriginalAssetUrl } from '../../shared/project-original-asset';

type Diagnostic = AuthoringDependencyGraphDiagnostic;
type FocusedCondition = RoomPreviewDocument['world']['cast'][number]['condition'];
type FocusedText = RoomPreviewDocument['ui']['description'];
type FocusedVisual = RoomPreviewDocument['world']['cast'][number]['visual'];
type FocusedHotspotTarget = RoomPreviewDocument['world']['hotspots'][number]['target'];

export interface BuildFocusedRoomPreviewOptions {
  project: AuthoringProject;
  projectSessionId: string;
  roomId: string;
  inputs: RoomPreviewInputs;
  graph: AuthoringDependencyGraphSnapshot;
  sourceAnalysis: readonly AuthoringSourceAnalysisArtifact<Diagnostic>[];
  activeShaderVariant: ShaderVariant;
}

export interface FocusedRoomPreviewBuildResult {
  data: RoomPreviewDocument;
  resources: PreviewResourceManifestEntry[];
  diagnostics: Diagnostic[];
}

const ownerKindByCollection = {
  rooms: 'room',
  scenes: 'scene',
  dialogues: 'dialogue',
  characters: 'character',
  interactables: 'interactable',
  verbs: 'verb',
  interactions: 'interaction',
  maps: 'map',
} as const;

const definitionCollections = Object.keys(ownerKindByCollection) as Array<
  keyof typeof ownerKindByCollection
>;

function diagnostic(path: string, message: string, code = 'focused-room.invalid'): Diagnostic {
  return { severity: 'error', code, path, message };
}

function nodeText(key: AuthoringDependencyNodeKey): string {
  return serializeAuthoringDependencyNodeKey(key);
}

function roomClosure(
  snapshot: AuthoringDependencyGraphSnapshot,
  roomId: string,
): { nodeKeys: Set<string>; edgeIds: Set<string>; owningPaths: Set<string> } {
  const graph = snapshot.graph;
  const root = nodeText({ kind: 'record', collection: 'rooms', id: roomId });
  if (!graph.nodesByKey.has(root))
    throw new Error(
      `Focused Room '${roomId}' is absent from the current dependency graph snapshot.`,
    );
  const nodeKeys = new Set<string>([root]);
  const edgeIds = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edgeId of graph.outgoingEdgeIdsByNodeKey.get(current) ?? []) {
      const edge = graph.edgesById.get(edgeId);
      if (!edge) continue;
      edgeIds.add(edgeId);
      // Exit target Rooms are integrity dependencies, not visual closure.
      if (
        edge.role === 'room-exit-target' ||
        edge.role === 'lua-possible-reference' ||
        edge.role === 'lua-recognized-reference' ||
        edge.role === 'lua-explicit-reference'
      )
        continue;
      const target = nodeText(edge.target);
      if (!nodeKeys.has(target)) {
        nodeKeys.add(target);
        queue.push(target);
      }
    }
  }
  const owningPaths = new Set<string>();
  for (const key of nodeKeys) {
    const node = graph.nodesByKey.get(key);
    if (node) owningPaths.add(node.owningPath);
  }
  for (const edgeId of edgeIds) {
    const edge = graph.edgesById.get(edgeId);
    if (edge) owningPaths.add(edge.sourcePath);
  }
  return { nodeKeys, edgeIds, owningPaths };
}

function closureDiagnostics(
  snapshot: AuthoringDependencyGraphSnapshot,
  closure: ReturnType<typeof roomClosure>,
): Diagnostic[] {
  return snapshot.graph.diagnostics.filter((item) =>
    [...closure.owningPaths].some(
      (path) =>
        item.path === path || item.path.startsWith(`${path}/`) || path.startsWith(`${item.path}/`),
    ),
  );
}

function closureAnalysisOwnerKeys(
  snapshot: AuthoringDependencyGraphSnapshot,
  closure: ReturnType<typeof roomClosure>,
): Set<string> {
  const owners = new Set<string>();
  for (const keyText of closure.nodeKeys) {
    const key = snapshot.graph.nodesByKey.get(keyText)?.key;
    if (key?.kind === 'record') owners.add(recordContributionKey(key.collection, key.id));
    if (key?.kind === 'nested') owners.add(recordContributionKey(key.ownerCollection, key.ownerId));
  }
  return owners;
}

function focusedCondition(value: RoomData['overlays'][number]['condition']): FocusedCondition {
  switch (value.kind) {
    case 'always':
      return { kind: 'always' };
    case 'all':
      return { kind: 'all', conditions: value.conditions.map(focusedCondition) };
    case 'any':
      return { kind: 'any', conditions: value.conditions.map(focusedCondition) };
    case 'not':
      return { kind: 'not', condition: focusedCondition(value.condition) };
    case 'lua-predicate':
      return { kind: 'lua-predicate', source: value.source };
    case 'variable-comparison':
      return {
        kind: 'variable-comparison',
        variableId: value.variable.$ref.id,
        operator: value.operator,
        ...(value.value !== undefined ? { value: value.value } : {}),
      };
    case 'property-comparison':
    case 'trait-presence':
    case 'location-comparison':
    case 'inventory-quantity-comparison':
      return { kind: 'runtime-only', conditionKind: value.kind };
  }
}

function cursorName(target: CursorTarget): string {
  if (target.kind === 'system') return target.cursor;
  if (target.kind === 'named') return target.id;
  return 'none';
}

function projectHotspotCursorName(project: AuthoringProject): string {
  const target = project.settings.cursors.defaults.hotspot;
  return target.kind === 'inherit'
    ? cursorName(project.settings.cursors.defaults.pointer)
    : cursorName(target);
}

function focusedSubjectTarget(subject: InteractionSubjectData): FocusedHotspotTarget {
  if (subject.kind === 'character')
    return { kind: 'character', characterId: subject.character.$ref.id };
  if (subject.kind === 'interactable')
    return { kind: 'interactable', interactableId: subject.interactable.$ref.id };
  if (subject.feature.ownerKind === 'room')
    return {
      kind: 'room-feature',
      roomId: subject.feature.room.$ref.id,
      featureId: subject.feature.featureId,
    };
  return {
    kind: 'interactable-feature',
    interactableId: subject.feature.interactable.$ref.id,
    featureId: subject.feature.featureId,
  };
}

function focusedRoomHotspotTarget(roomId: string, target: RoomHotspotTarget): FocusedHotspotTarget {
  if (target.kind === 'owner-feature')
    return { kind: 'room-feature', roomId, featureId: target.featureId };
  if (target.kind === 'exit') return { kind: 'exit', roomId, exitId: target.exitId };
  return focusedSubjectTarget(target.subject);
}

function focusedInteractableHotspotTarget(
  interactableId: string,
  target: InteractableHotspotTarget,
): FocusedHotspotTarget {
  if (target.kind === 'owner') return { kind: 'interactable', interactableId };
  if (target.kind === 'owner-feature')
    return { kind: 'interactable-feature', interactableId, featureId: target.featureId };
  return focusedSubjectTarget(target.subject);
}

function localizedText(project: AuthoringProject, key: string): string {
  const locale = effectivePreviewLocale(project);
  const result = resolveMessage(project.localization, {
    key,
    locale: locale === PSEUDO_PREVIEW_LOCALE ? project.localization.sourceLocale : locale,
  });
  const text = result.resolved?.text ?? '';
  return locale === PSEUDO_PREVIEW_LOCALE ? pseudoLocalizeText(text).text : text;
}

function focusedStructuredString(
  project: AuthoringProject,
  semanticPath: string,
  fallback: string,
) {
  const message = structuredMessageForPath(project, semanticPath);
  if (!message) return fallback;
  const locale = effectivePreviewLocale(project);
  return locale === PSEUDO_PREVIEW_LOCALE
    ? pseudoLocalizeText(message.source).text
    : resolveStructuredMessageText(project, message, locale).text;
}

function focusedText(
  project: AuthoringProject,
  value: RoomData['description'],
  semanticPath?: string,
): FocusedText {
  if (value.source.kind === 'lua-expression')
    return {
      markup: value.markup,
      source: { kind: 'lua-expression', source: value.source.source },
    };
  return {
    markup: value.markup,
    source: {
      kind: 'resolved',
      text:
        value.source.kind === 'inline'
          ? semanticPath
            ? focusedStructuredString(project, semanticPath, value.source.text)
            : value.source.text
          : localizedText(project, value.source.key),
    },
  };
}

function characterVisual(
  data: CharacterData,
  requestedProfileId: string | null | undefined,
  requestedPoseId: string | null,
  expressionId: string | null,
  appearanceId: string | null | undefined,
  idleId: string | null,
  path: string,
  diagnostics: Diagnostic[],
): FocusedVisual {
  const profileId = requestedProfileId ?? data.defaults.profileId;
  const profile = data.profiles.find((item) => item.id === profileId) ?? data.profiles[0];
  const requestedPose = requestedPoseId ?? profile?.defaultPoseId ?? '';
  const selectedExpressionId = expressionId ?? data.defaults.expressionId;
  const expression =
    data.expressions.find((item) => item.id === selectedExpressionId) ?? data.expressions[0];
  const pose =
    profile?.poses.find((item) => item.id === requestedPose) ?? profile?.poses[0] ?? null;
  const resolvedPoseId = pose?.id ?? requestedPose;
  const selectedAppearanceId = appearanceId ?? data.defaults.appearanceId;
  const selectedIdleId = idleId ?? data.defaults.idleId;
  const idle = selectedIdleId ? data.idles.find((item) => item.id === selectedIdleId) : null;
  if (!profile) diagnostics.push(diagnostic(path, 'Character has no resolvable profile.'));
  if (!pose) diagnostics.push(diagnostic(path, 'Character has no resolvable pose.'));
  if (!expression) diagnostics.push(diagnostic(path, 'Character has no resolvable expression.'));
  if (selectedIdleId && !idle)
    diagnostics.push(diagnostic(path, `Character idle '${selectedIdleId}' is missing.`));
  return {
    profileId: profile?.id ?? profileId,
    requestedPoseId: requestedPose,
    resolvedPoseId,
    expressionId: expression?.id ?? selectedExpressionId,
    appearanceId: selectedAppearanceId,
    idleId: idle?.id ?? null,
    layers: resolveCharacterPresentationLayers(
      data,
      profile?.id ?? profileId,
      resolvedPoseId,
      expression?.id ?? selectedExpressionId,
      selectedAppearanceId,
    ).map((layer) => ({
      id: layer.id,
      role: layer.role,
      spriteAssetId: layer.sprite?.$ref.id ?? null,
      materialId: layer.material?.$ref.id ?? null,
      offset: layer.offset,
      scale: layer.scale,
      anchor: layer.anchor,
      visible: layer.visible,
    })),
    idle: idle
      ? {
          kind: idle.kind,
          amplitude: idle.amplitude,
          periodMs: idle.periodMs,
          clock: idle.clock,
        }
      : null,
  };
}

function sourceComponent(
  project: AuthoringProject,
  value: LayoutSourceData | LayoutLuaSourceData,
  options: Readonly<{ pseudoLocalizeMessages?: boolean }> = {},
) {
  if (value.sourceMode === 'inline')
    return {
      kind: 'inline' as const,
      text: options.pseudoLocalizeMessages
        ? pseudoLocalizeRmlMessages(project, value.sourceText)
        : value.sourceText,
    };
  const assetId = value.sourceAsset?.$ref.id;
  const asset = assetId ? parseAssetData(project.assets[assetId]?.data) : null;
  return {
    kind: 'asset' as const,
    logicalPath: asset ? `project:/${asset.source.path}` : `project:/__missing/${assetId ?? ''}`,
  };
}

function layoutHasExecutableRmlLua(
  analyses: readonly AuthoringSourceAnalysisArtifact<Diagnostic>[],
  layoutId: string,
): boolean {
  const prefix = `/layouts/${layoutId}/`;
  return analyses.some(
    (artifact) =>
      artifact.complete &&
      artifact.regions.some(
        (region) => region.sourcePath.startsWith(prefix) && region.sourceKind !== 'lua-field',
      ),
  );
}

function gameHudLayoutId(project: AuthoringProject): string | null {
  return project.settings.ui.systemLayouts['game-hud']?.$ref.id ?? null;
}

function buildLayouts(
  project: AuthoringProject,
  room: RoomData,
  analyses: readonly AuthoringSourceAnalysisArtifact<Diagnostic>[],
  diagnostics: Diagnostic[],
) {
  const output: RoomPreviewDocument['layouts'] = [];
  const append = (
    layoutId: string | null,
    instanceId: string,
    mount: RoomPreviewDocument['layouts'][number]['mount'],
  ) => {
    if (layoutId === null) {
      output.push({
        instanceId,
        layoutId: null,
        mount,
        source: { kind: 'builtin-game-hud' },
        scriptEnabled: false,
        containsDedicatedLuaSource: false,
        containsExecutableRmlLua: false,
        contract: null,
        scalePolicy: { ui: 'inherit', text: 'inherit' },
      });
      return;
    }
    const record = project.layouts[layoutId];
    const data = parseLayoutData(record?.data);
    if (!data) {
      diagnostics.push(diagnostic(`/layouts/${layoutId}`, `Layout '${layoutId}' is invalid.`));
      return;
    }
    const lua = sourceComponent(project, data.lua);
    const rml = sourceComponent(project, data.rml, {
      pseudoLocalizeMessages: effectivePreviewLocale(project) === PSEUDO_PREVIEW_LOCALE,
    });
    output.push({
      instanceId,
      layoutId,
      mount,
      source: {
        kind: 'authored',
        layoutKind: data.layoutKind,
        templateId: data.layoutKind === 'fragment' ? 'layout-fragment-host-v1' : null,
        sourceUrl: authoredLayoutSourceUrl(project, layoutId, data.rml),
        defaultParent: data.mount.defaultParent ?? null,
        scopedStyles: data.mount.scopedStyles,
        scriptNamespace: data.script.namespace ?? null,
        rml,
        rcss: sourceComponent(project, data.rcss),
        lua,
      },
      scriptEnabled: data.script.enabled,
      containsDedicatedLuaSource:
        lua.kind === 'inline'
          ? new TextEncoder().encode(lua.text.replace(/^\uFEFF/, '')).byteLength > 0
          : true,
      containsExecutableRmlLua: layoutHasExecutableRmlLua(analyses, layoutId),
      contract: lowerLayoutContractForWire(data.contract),
      scalePolicy: data.scalePolicy ?? { ui: 'inherit', text: 'inherit' },
    });
  };
  append(gameHudLayoutId(project), 'game-hud', { kind: 'game-hud' });
  room.overlays.forEach((overlay) =>
    append(overlay.layout.$ref.id, `room-overlay:${overlay.id}`, {
      kind: 'room-overlay',
      overlayId: overlay.id,
      order: overlay.order,
      visible: overlay.visible,
    }),
  );
  return output.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
}

function admissionTargetFromNode(
  key: AuthoringDependencyNodeKey,
): { kind: 'record'; collection: AuthoringCollectionKey; id: string } | null {
  if (key.kind === 'record') return { kind: 'record', collection: key.collection, id: key.id };
  return null;
}

type AdmissionTarget =
  | { kind: 'record'; collection: AuthoringCollectionKey; id: string }
  | {
      kind: 'property-value';
      owner: {
        kind: (typeof ownerKindByCollection)[keyof typeof ownerKindByCollection];
        id: string;
      };
      propertyId: string;
    };

function admissionTargets(
  snapshot: AuthoringDependencyGraphSnapshot,
  closure: ReturnType<typeof roomClosure>,
): AdmissionTarget[] {
  const targets: AdmissionTarget[] = [];
  const correlatedProperties = new Map<string, { owner: boolean; target: AdmissionTarget }>();
  for (const edgeId of closure.edgeIds) {
    const edge = snapshot.graph.edgesById.get(edgeId);
    if (
      !edge ||
      !['lua-possible-reference', 'lua-recognized-reference', 'lua-explicit-reference'].includes(
        edge.role,
      )
    )
      continue;
    if (!edge.facets.includes('preview-visual') && !edge.facets.includes('preview-ui')) continue;
    const propertyId = edge.detail?.propertyId;
    const propertyOwnerCollection = edge.detail?.propertyOwnerCollection as
      | keyof typeof ownerKindByCollection
      | undefined;
    const propertyOwnerId = edge.detail?.propertyOwnerId;
    if (propertyId && propertyOwnerCollection && propertyOwnerId) {
      const ownerKind = ownerKindByCollection[propertyOwnerCollection];
      if (!ownerKind) continue;
      const correlationKey = `${edge.role}:${edge.sourcePath}:${propertyOwnerCollection}:${propertyOwnerId}:${propertyId}:${edge.evidence?.map((item) => JSON.stringify(item)).join('|') ?? ''}`;
      const correlated = correlatedProperties.get(correlationKey) ?? {
        owner: false,
        target: {
          kind: 'property-value' as const,
          owner: { kind: ownerKind, id: propertyOwnerId },
          propertyId,
        },
      };
      if (
        edge.target.kind === 'record' &&
        edge.target.collection === propertyOwnerCollection &&
        edge.target.id === propertyOwnerId &&
        snapshot.graph.nodesByKey.has(nodeText(edge.target))
      )
        correlated.owner = true;
      correlatedProperties.set(correlationKey, correlated);
      continue;
    }
    const target = admissionTargetFromNode(edge.target);
    if (target) targets.push(target);
  }
  for (const correlation of correlatedProperties.values())
    if (correlation.owner) targets.push(correlation.target);
  const byKey = new Map<string, AdmissionTarget>();
  for (const target of targets) byKey.set(JSON.stringify(target), target);
  return [...byKey.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compositionDraftTargets(
  snapshot: AuthoringDependencyGraphSnapshot,
  moduleId: string | null,
): AdmissionTarget[] {
  if (!moduleId) return [];
  const moduleSourcePrefix = `/scripts/${moduleId}/`;
  const targets: AdmissionTarget[] = [];
  for (const edge of snapshot.graph.edgesById.values()) {
    if (
      !['lua-possible-reference', 'lua-recognized-reference', 'lua-explicit-reference'].includes(
        edge.role,
      )
    )
      continue;
    const fromComposition =
      edge.sourcePath.startsWith(moduleSourcePrefix) ||
      edge.evidence?.some(
        (evidence) =>
          evidence.kind === 'lua-occurrence' &&
          evidence.occurrence.sourcePath.startsWith(moduleSourcePrefix),
      );
    if (!fromComposition) continue;
    const target = admissionTargetFromNode(edge.target);
    if (
      target?.kind === 'record' &&
      (target.collection === 'characters' || target.collection === 'interactables')
    )
      targets.push(target);
  }
  return [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function recordForOwner(
  project: AuthoringProject,
  kind: string,
  id: string,
): AuthoringRecordBase | null {
  const collection = `${kind}s` as AuthoringCollectionKey;
  const record =
    (project[collection] as Record<string, AuthoringRecordBase> | undefined)?.[id] ?? null;
  if (!record) return null;
  const gameplayKind = gameplayInstanceKindForCollection(collection);
  return gameplayKind ? resolveGameplayInstanceRecord(project, gameplayKind, record) : record;
}

function resolvedProperty(
  project: AuthoringProject,
  kind: string,
  id: string,
  propertyId: string,
): { kind: 'value'; value: null | boolean | number | string } | { kind: 'missing' } {
  const record = recordForOwner(project, kind, id);
  const local = record?.localProperties?.find((property) => property.id === propertyId);
  if (local)
    return typeof local.value === 'object'
      ? { kind: 'missing' }
      : { kind: 'value', value: local.value };
  for (const traitId of record?.traits ?? []) {
    const member = project.traits[traitId]?.properties.find(
      (property) => property.id === propertyId,
    );
    if (member?.defaultValue !== undefined)
      return typeof member.defaultValue === 'object'
        ? { kind: 'missing' }
        : { kind: 'value', value: member.defaultValue };
  }
  return { kind: 'missing' };
}

function buildAdmissionAndState(
  project: AuthoringProject,
  roomId: string,
  room: RoomData,
  targets: readonly AdmissionTarget[],
  compositionTargets: readonly AdmissionTarget[],
  structuredConditionVariableIds: readonly string[],
) {
  const definitions = new Map<
    string,
    { collection: (typeof definitionCollections)[number]; id: string }
  >();
  const variableIds = new Set<string>();
  const properties = new Map<string, { ownerKind: string; ownerId: string; propertyId: string }>();
  const interactableLocationIds = new Set<string>();
  for (const target of targets) {
    if (target.kind === 'record') {
      if (
        definitionCollections.includes(target.collection as (typeof definitionCollections)[number])
      )
        definitions.set(`${target.collection}:${target.id}`, {
          collection: target.collection as (typeof definitionCollections)[number],
          id: target.id,
        });
      if (target.collection === 'variables') variableIds.add(target.id);
      if (target.collection === 'interactables') interactableLocationIds.add(target.id);
    } else if (target.kind === 'property-value') {
      properties.set(`${target.owner.kind}:${target.owner.id}:${target.propertyId}`, {
        ownerKind: target.owner.kind,
        ownerId: target.owner.id,
        propertyId: target.propertyId,
      });
    }
  }
  for (const occurrence of room.interactables) {
    const interactableId = occurrence.interactable.$ref.id;
    const instance = project.interactableInstances[interactableId];
    if (instance) {
      const definitionId = instance.definition.$ref.id;
      definitions.set(`interactables:${definitionId}`, {
        collection: 'interactables',
        id: definitionId,
      });
    }
    interactableLocationIds.add(interactableId);
  }
  const compositionDraftCharacterIds = new Set<string>();
  const compositionDraftInteractableIds = new Set<string>();
  for (const target of compositionTargets) {
    if (target.kind !== 'record') continue;
    if (target.collection === 'characters') compositionDraftCharacterIds.add(target.id);
    if (target.collection === 'interactables') compositionDraftInteractableIds.add(target.id);
  }
  const sortedDefinitions = [...definitions.values()].sort((a, b) =>
    `${a.collection}:${a.id}`.localeCompare(`${b.collection}:${b.id}`),
  );
  const sortedProperties = [...properties.values()].sort((a, b) =>
    `${a.ownerKind}:${a.ownerId}:${a.propertyId}`.localeCompare(
      `${b.ownerKind}:${b.ownerId}:${b.propertyId}`,
    ),
  );
  const sortedVariableIds = [...variableIds].sort();
  const sortedStateVariableIds = [
    ...new Set([...sortedVariableIds, ...structuredConditionVariableIds]),
  ].sort();
  const sortedLocationIds = [...interactableLocationIds].sort();
  return {
    admission: {
      definitions: sortedDefinitions,
      variableIds: sortedVariableIds,
      properties: sortedProperties,
      interactableLocationIds: sortedLocationIds,
      compositionDraftCharacterIds: [...compositionDraftCharacterIds].sort(),
      compositionDraftInteractableIds: [...compositionDraftInteractableIds].sort(),
    },
    state: {
      variables: sortedStateVariableIds.flatMap((id) => {
        const data = parseVariableData(project.variables[id]?.data);
        return data && data.type !== 'message' ? [{ id, type: data.type, value: data.value }] : [];
      }),
      properties: sortedProperties.map((property) => ({
        ...property,
        result: resolvedProperty(
          project,
          property.ownerKind,
          property.ownerId,
          property.propertyId,
        ),
      })),
      definitions: sortedDefinitions.map((item) => ({
        ...item,
        displayName:
          item.collection === 'rooms' ||
          item.collection === 'scenes' ||
          item.collection === 'dialogues' ||
          item.collection === 'characters' ||
          item.collection === 'interactables'
            ? (((project[item.collection][item.id]?.data as { displayName?: unknown } | undefined)
                ?.displayName as string | undefined) ?? null)
            : null,
      })),
      interactableLocations: sortedLocationIds.flatMap((interactableId) => {
        const instance = project.interactableInstances[interactableId];
        return instance ? [{ interactableId, location: structuredClone(instance.location) }] : [];
      }),
    },
  };
}

function structuredConditionVariableIds(room: RoomData): string[] {
  const values = [
    ...room.overlays.map((item) => item.condition),
    ...room.cast.map((item) => item.condition),
    ...room.props.map((item) => item.condition),
    ...room.environments.map((item) => item.condition),
    ...room.exits.map((item) => item.condition),
  ];
  const ids = new Set<string>();
  const collect = (condition: (typeof values)[number]) => {
    if (condition.kind === 'variable-comparison') ids.add(condition.variable.$ref.id);
    else if (condition.kind === 'all' || condition.kind === 'any')
      condition.conditions.forEach(collect);
    else if (condition.kind === 'not') collect(condition.condition);
  };
  values.forEach(collect);
  return [...ids].sort();
}

function collectVisualIds(data: RoomPreviewDocument) {
  const assets = new Set<string>();
  const materials = new Set<string>();
  const addAsset = (id: string | null) => id && assets.add(id);
  const addMaterial = (id: string | null) => id && materials.add(id);
  addAsset(data.world.background.assetId);
  addMaterial(data.world.background.materialId);
  for (const item of [...data.world.persistentCharacters, ...data.world.cast]) {
    for (const layer of item.visual.layers) {
      addAsset(layer.spriteAssetId);
      addMaterial(layer.materialId);
    }
  }
  for (const item of data.world.interactables) {
    addAsset(item.spriteAssetId);
    addMaterial(item.materialId);
  }
  for (const item of data.world.props) {
    addAsset(item.assetId);
    addMaterial(item.materialId);
  }
  for (const item of data.world.environments) {
    addAsset(item.assetId);
    addMaterial(item.materialId);
  }
  return { assets, materials };
}

function completeMaterialClosure(project: AuthoringProject, materialIds: Set<string>) {
  const assetIds = new Set<string>();
  for (const id of materialIds) {
    const resolved = resolveMaterialData(project, id).data;
    if (!resolved) continue;
    for (const texture of Object.values(resolved.textures))
      if (texture.source && '$ref' in texture.source) assetIds.add(texture.source.$ref.id);
  }
  return { assetIds };
}

function layoutResourceIds(project: AuthoringProject, layouts: RoomPreviewDocument['layouts']) {
  const assets = new Set<string>();
  const materials = new Set<string>();
  const scripts = new Set<string>();
  for (const layout of layouts) {
    if (!layout.layoutId) continue;
    const data = parseLayoutData(project.layouts[layout.layoutId]?.data);
    if (!data) continue;
    for (const family of ['images', 'fonts', 'stylesheets', 'templates', 'data'] as const)
      for (const ref of data.dependencies[family] ?? []) assets.add(ref.$ref.id);
    for (const path of data.dependencies.scripts) scripts.add(path);
    for (const ref of data.dependencies.materials) materials.add(ref.$ref.id);
    for (const source of [data.rml, data.rcss, data.lua])
      if (source.sourceMode === 'asset' && source.sourceAsset)
        assets.add(source.sourceAsset.$ref.id);
  }
  const defaultFont = project.settings.text.defaultFont?.$ref.id;
  if (defaultFont) assets.add(defaultFont);
  return { assets, materials, scripts };
}

async function resourceManifest(
  project: AuthoringProject,
  projectSessionId: string,
  assetIds: Set<string>,
  alphaCoverageAssetIds: Set<string>,
  projectSourcePaths: Set<string>,
  _variant: ShaderVariant,
  diagnostics: Diagnostic[],
): Promise<PreviewResourceManifestEntry[]> {
  const resources: PreviewResourceManifestEntry[] = [];
  for (const assetId of [...assetIds].sort()) {
    const data = parseAssetData(project.assets[assetId]?.data);
    if (!data?.contentHash || data.byteSize === undefined) {
      diagnostics.push(
        diagnostic(`/assets/${assetId}`, `Focused resource '${assetId}' lacks hash/byte metadata.`),
      );
      continue;
    }
    const base = {
      resourceId: `asset:${assetId}`,
      sourceKind: 'authoring-asset',
      assetId,
      usageRoles: ['room-preview'] as string[],
      fetchUrl: projectOriginalAssetUrl(projectSessionId, assetId),
      logicalPath: `project:/${data.source.path}`,
      contentHash: data.contentHash as `sha256:${string}`,
      byteSize: data.byteSize,
    } as const;
    resources.push(
      data.kind === 'image'
        ? {
            ...base,
            kind: 'image',
            sampling: data.sampling ?? 'linear',
            retainAlphaCoverage: alphaCoverageAssetIds.has(assetId),
          }
        : { ...base, kind: data.kind },
    );
  }
  if (projectSourcePaths.size > 0) {
    const paths = [...projectSourcePaths].sort();
    const response = await window.noveltea.readProjectTextSources({
      projectSessionId,
      entries: paths.map((projectRelativePath, index) => ({
        readKey: `room-preview-source:${index}`,
        projectRelativePath,
        expectedContentHash: null,
      })),
    });
    const byKey = new Map(response.entries.map((entry) => [entry.readKey, entry]));
    const encoder = new TextEncoder();
    paths.forEach((projectRelativePath, index) => {
      const entry = byKey.get(`room-preview-source:${index}`);
      if (!entry || entry.status !== 'ready') {
        diagnostics.push(
          diagnostic(`/layouts`, `Focused project source '${projectRelativePath}' is unavailable.`),
        );
        return;
      }
      resources.push({
        resourceId: `source:${projectRelativePath}`,
        sourceKind: 'project-source',
        usageRoles: ['room-preview'],
        fetchProjectRelativePath: projectRelativePath,
        logicalPath: `project:/${projectRelativePath}`,
        contentHash: entry.contentHash,
        byteSize: encoder.encode(entry.text).byteLength + (entry.hadUtf8Bom ? 3 : 0),
        kind: 'lua',
      });
    });
  }
  return resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

export async function buildFocusedRoomPreview(
  options: BuildFocusedRoomPreviewOptions,
): Promise<FocusedRoomPreviewBuildResult> {
  const {
    project: authoredProject,
    projectSessionId,
    roomId,
    graph,
    sourceAnalysis,
    activeShaderVariant,
  } = options;
  const diagnostics: Diagnostic[] = [];
  const managedLua = lowerManagedLuaLocalizationForFocusedPreview(
    projectWithPreviewLocale(authoredProject),
  );
  const project = managedLua.project;
  diagnostics.push(
    ...managedLua.diagnostics.map((item) => ({
      severity: 'error' as const,
      code: item.code,
      path: item.path,
      message: item.message,
    })),
  );
  const sourceRecord = project.rooms[roomId];
  const record = recordForOwner(project, 'room', roomId);
  const room = parseRoomData(record?.data);
  if (!sourceRecord || !record || !room) throw new Error(`Room '${roomId}' is missing or invalid.`);
  const hookRegistry = analyzeHookRegistry(project);
  diagnostics.push(
    ...hookRegistry.diagnostics.map((item) => ({
      severity: item.severity === 'info' ? ('warning' as const) : item.severity,
      code: item.code,
      path: item.path,
      message: item.message,
    })),
  );
  const compositionHook = hookRegistry.explain('compose', roomId).winner ?? null;
  const closure = roomClosure(graph, roomId);
  const analysisOwnerKeys = closureAnalysisOwnerKeys(graph, closure);
  const relevantSourceAnalysis = sourceAnalysis.filter((artifact) =>
    analysisOwnerKeys.has(artifact.semanticOwnerKey),
  );
  diagnostics.push(...closureDiagnostics(graph, closure));
  for (const artifact of relevantSourceAnalysis)
    if (!artifact.complete)
      diagnostics.push(
        diagnostic(
          `/rooms/${roomId}`,
          'Room source analysis is incomplete; focused Lua admission cannot be built safely.',
          'focused-room.incomplete-source-analysis',
        ),
      );

  const persistentCharacters: RoomPreviewDocument['world']['persistentCharacters'] = [];
  const interactables = [...room.interactables]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((occurrence) => {
      const instance = project.interactableInstances[occurrence.interactable.$ref.id];
      if (
        !instance ||
        instance.location.kind !== 'room' ||
        instance.location.room.$ref.id !== roomId
      )
        return [];
      const definition = parseInteractableData(
        recordForOwner(project, 'interactable', instance.definition.$ref.id)?.data,
      );
      if (!definition) return [];
      return [
        {
          occurrenceId: occurrence.id,
          interactableId: instance.id,
          condition: focusedCondition(occurrence.condition),
          placementId: occurrence.placementId,
          spriteAssetId: definition.presentation.sprite?.$ref.id ?? null,
          materialId: definition.presentation.material?.$ref.id ?? null,
          enabled: instance.enabled,
          visible: instance.visible,
          occurrenceVisible: occurrence.visible,
          order: occurrence.order,
        },
      ];
    });
  const hotspotSource = (assetId: string | null, path: string) => {
    const asset = assetId ? parseAssetData(project.assets[assetId]?.data) : null;
    if (
      asset?.kind === 'image' &&
      asset.imageMetadata &&
      asset.imageMetadata.width <= 65535 &&
      asset.imageMetadata.height <= 65535
    )
      return {
        sourceAssetId: assetId!,
        sourceWidth: asset.imageMetadata.width,
        sourceHeight: asset.imageMetadata.height,
      };
    diagnostics.push(
      diagnostic(
        path,
        'Focused Hotspot preview requires a dimensioned Image Asset no larger than 65535 pixels per axis.',
        'focused-room.hotspot-source-invalid',
      ),
    );
    return null;
  };
  const roomHotspotSource =
    room.hotspots.length > 0
      ? hotspotSource(
          room.background.asset?.$ref.id ?? null,
          `/rooms/${roomId}/data/background/asset`,
        )
      : null;
  const hotspots: RoomPreviewDocument['world']['hotspots'] = roomHotspotSource
    ? room.hotspots.map((hotspot) => ({
        ownerKind: 'room' as const,
        ownerId: roomId,
        hotspotId: hotspot.id,
        label: hotspot.label,
        condition: focusedCondition(hotspot.condition),
        inputOrder: hotspot.inputOrder,
        shape: { kind: 'rect' as const, bounds: { ...hotspot.shape.bounds } },
        target: focusedRoomHotspotTarget(roomId, hotspot.target),
        cursor: hotspot.cursor ? cursorName(hotspot.cursor) : projectHotspotCursorName(project),
        ...roomHotspotSource,
        placementId: null,
      }))
    : [];
  for (const occurrence of interactables) {
    const instance = project.interactableInstances[occurrence.interactableId];
    const definition = instance
      ? parseInteractableData(
          recordForOwner(project, 'interactable', instance.definition.$ref.id)?.data,
        )
      : null;
    if (!definition || definition.presentation.hotspots.kind === 'none') continue;
    const source = hotspotSource(
      definition.presentation.sprite?.$ref.id ?? null,
      `/interactables/${instance?.definition.$ref.id ?? occurrence.interactableId}/data/presentation/sprite`,
    );
    if (!source) continue;
    const fallbackCursor = definition.presentation.cursor
      ? cursorName(definition.presentation.cursor)
      : projectHotspotCursorName(project);
    if (definition.presentation.hotspots.kind === 'sprite-alpha') {
      const hotspot = definition.presentation.hotspots.hotspot;
      hotspots.push({
        ownerKind: 'interactable',
        ownerId: occurrence.interactableId,
        hotspotId: hotspot.id,
        label: hotspot.label,
        condition: focusedCondition(hotspot.condition),
        inputOrder: hotspot.inputOrder,
        shape: { kind: 'alpha' },
        target: focusedInteractableHotspotTarget(occurrence.interactableId, hotspot.target),
        cursor: fallbackCursor,
        ...source,
        placementId: occurrence.placementId,
      });
      continue;
    }
    for (const hotspot of definition.presentation.hotspots.hotspots) {
      hotspots.push({
        ownerKind: 'interactable',
        ownerId: occurrence.interactableId,
        hotspotId: hotspot.id,
        label: hotspot.label,
        condition: focusedCondition(hotspot.condition),
        inputOrder: hotspot.inputOrder,
        shape: { kind: 'rect', bounds: { ...hotspot.shape.bounds } },
        target: focusedInteractableHotspotTarget(occurrence.interactableId, hotspot.target),
        cursor: hotspot.cursor ? cursorName(hotspot.cursor) : fallbackCursor,
        ...source,
        placementId: occurrence.placementId,
      });
    }
  }
  const layouts = buildLayouts(project, room, relevantSourceAnalysis, diagnostics);
  const targets = admissionTargets(graph, closure);
  const { admission, state } = buildAdmissionAndState(
    project,
    roomId,
    room,
    targets,
    compositionDraftTargets(graph, compositionHook?.moduleId ?? null),
    structuredConditionVariableIds(room),
  );
  const profile = effectivePreviewDisplay(
    options.inputs.displayPreference,
    project.settings.display,
  );
  const data: RoomPreviewDocument = {
    schema: 'noveltea.room-preview',
    environment: {
      profile: { name: profile.name, nativeResolution: profile.nativeResolution },
      project: {
        referenceResolution: project.settings.display.referenceResolution,
        worldRasterPolicy: project.settings.display.worldRasterPolicy,
        barColor: project.settings.display.barColor,
        accessibility: project.settings.accessibility,
      },
    },
    room: {
      roomId,
      recordLabel: sourceRecord.label,
      displayName: focusedStructuredString(
        project,
        `/rooms/${roomId}/data/displayName`,
        room.displayName,
      ),
      visit: { visitIndex: 1, sourceRoomId: null, entryExitId: null },
    },
    luaAdmission: admission as RoomPreviewDocument['luaAdmission'],
    queryState: state as RoomPreviewDocument['queryState'],
    shaderMaterials: { schema: 'noveltea.shader-materials', shaders: {}, materials: {} },
    cursors: {
      defaultCursor:
        project.settings.cursors.defaults.default.kind === 'system'
          ? project.settings.cursors.defaults.default.cursor
          : project.settings.cursors.defaults.default.kind === 'named'
            ? project.settings.cursors.defaults.default.id
            : 'none',
      pointerCursor:
        project.settings.cursors.defaults.pointer.kind === 'system'
          ? project.settings.cursors.defaults.pointer.cursor
          : project.settings.cursors.defaults.pointer.kind === 'named'
            ? project.settings.cursors.defaults.pointer.id
            : 'none',
      hotspotCursor:
        project.settings.cursors.defaults.hotspot.kind === 'inherit'
          ? project.settings.cursors.defaults.pointer.kind === 'system'
            ? project.settings.cursors.defaults.pointer.cursor
            : project.settings.cursors.defaults.pointer.kind === 'named'
              ? project.settings.cursors.defaults.pointer.id
              : 'none'
          : project.settings.cursors.defaults.hotspot.kind === 'system'
            ? project.settings.cursors.defaults.hotspot.cursor
            : project.settings.cursors.defaults.hotspot.kind === 'named'
              ? project.settings.cursors.defaults.hotspot.id
              : 'none',
      named: project.settings.cursors.named.flatMap((cursor) => {
        const asset = parseAssetData(project.assets[cursor.image.$ref.id]?.data);
        if (asset?.kind !== 'image' || !asset.imageMetadata) return [];
        return [
          {
            id: cursor.id,
            logicalPath: `project:/${asset.source.path}`,
            width: asset.imageMetadata.width,
            height: asset.imageMetadata.height,
            hotspotX: cursor.hotspotX,
            hotspotY: cursor.hotspotY,
          },
        ];
      }),
    },
    world: {
      presentationSpace: {
        size: { ...room.presentationSpace.size },
        bounds: room.presentationSpace.bounds ? { ...room.presentationSpace.bounds } : null,
        edgePolicy: room.presentationSpace.edgePolicy,
        view: {
          center: { ...room.presentationSpace.defaultView.center },
          zoom: room.presentationSpace.defaultView.zoom,
          rotationDegrees: room.presentationSpace.defaultView.rotationDegrees,
        },
      },
      anchors: room.anchors.map((anchor) => ({ id: anchor.id, bounds: { ...anchor.bounds } })),
      background: {
        assetId: room.background.asset?.$ref.id ?? null,
        materialId: room.background.material?.$ref.id ?? null,
        fit: room.background.fit,
        color: room.background.color,
      },
      placements: room.placements.map((placement) => ({
        id: placement.id,
        bounds: placement.bounds,
        order: placement.order ?? 0,
        label: placement.presentation.label
          ? focusedText(
              project,
              placement.presentation.label,
              `/rooms/${roomId}/data/placements/@${placement.id}/presentation/label`,
            )
          : null,
        layoutId: placement.presentation.layout?.$ref.id ?? null,
      })),
      persistentCharacters,
      cast: room.cast.flatMap((entry) => {
        const character = parseCharacterData(
          recordForOwner(project, 'character', entry.character.$ref.id)?.data,
        );
        if (!character) {
          diagnostics.push(
            diagnostic(
              `/rooms/${roomId}/data/cast/${entry.id}`,
              `Character '${entry.character.$ref.id}' is invalid.`,
            ),
          );
          return [];
        }
        if (
          character.initialWorldState.location.kind !== 'room' ||
          character.initialWorldState.location.room.$ref.id !== roomId
        )
          return [];
        return [
          {
            entryId: entry.id,
            characterId: entry.character.$ref.id,
            condition: focusedCondition(entry.condition),
            placementId: entry.placementId,
            enabled: character.initialWorldState.enabled,
            visible: character.initialWorldState.visible,
            occurrenceVisible: entry.visible,
            order: entry.order,
            visual: characterVisual(
              character,
              entry.profileId,
              entry.poseId,
              entry.expressionId,
              entry.appearanceId,
              entry.idleId,
              `/rooms/${roomId}/data/cast/${entry.id}`,
              diagnostics,
            ),
          },
        ];
      }),
      interactables,
      props: room.props.map((item) => ({
        propId: item.id,
        condition: focusedCondition(item.condition),
        placementId: item.placementId,
        assetId: item.asset?.$ref.id ?? null,
        materialId: item.material?.$ref.id ?? null,
        visible: item.visible,
        order: item.order,
      })),
      environments: room.environments.map((item) => ({
        environmentId: item.id,
        condition: focusedCondition(item.condition),
        assetId: item.asset?.$ref.id ?? null,
        materialId: item.material.$ref.id,
        bounds: item.bounds,
        plane: item.plane,
        order: item.order,
        clock: item.clock,
        scrollPerSecond: item.scrollPerSecond,
        opacity: item.opacity,
        visible: item.visible,
      })),
      overlays: room.overlays.map((item) => ({
        overlayId: item.id,
        condition: focusedCondition(item.condition),
        layoutId: item.layout.$ref.id,
        visible: item.visible,
        order: item.order,
      })),
      hotspots,
    },
    layouts,
    ui: {
      description: focusedText(project, room.description, `/rooms/${roomId}/data/description`),
      exits: room.exits.map((item) => ({
        exitId: item.id,
        label: focusedStructuredString(
          project,
          `/rooms/${roomId}/data/exits/@${item.id}/label`,
          item.label,
        ),
        direction: item.direction,
        targetRoomId: item.target.$ref.id,
        condition: focusedCondition(item.condition),
      })),
    },
    composition: compositionHook
      ? (() => {
          const moduleId = compositionHook.moduleId;
          const source = parseScriptModuleData(project.scripts[moduleId]?.data)?.source;
          if (!source) {
            diagnostics.push(
              diagnostic(
                `/scripts/${moduleId}`,
                `Composition Script Module '${moduleId}' is invalid.`,
              ),
            );
            return null;
          }
          if (source.kind === 'inline-lua')
            return {
              moduleId,
              exportName: compositionHook.exportName,
              source: { kind: 'inline' as const, text: source.source },
            };
          return {
            moduleId,
            exportName: compositionHook.exportName,
            source: { kind: 'asset' as const, logicalPath: `project:/${source.path}` },
          };
        })()
      : null,
  };

  const visual = collectVisualIds(data);
  for (const artifact of relevantSourceAnalysis)
    for (const assetId of artifact.sourceAssetIds) visual.assets.add(assetId);
  const layoutIds = layoutResourceIds(project, layouts);
  for (const id of layoutIds.assets) visual.assets.add(id);
  for (const id of layoutIds.materials) visual.materials.add(id);
  const materialClosure = completeMaterialClosure(project, visual.materials);
  for (const id of materialClosure.assetIds) visual.assets.add(id);
  for (const cursor of project.settings.cursors.named) visual.assets.add(cursor.image.$ref.id);
  const materialProject = await buildShaderMaterialProject(project);
  diagnostics.push(
    ...materialProject.diagnostics.map((item) => ({
      severity: item.severity === 'info' ? ('warning' as const) : item.severity,
      path: item.path,
      message: item.message,
      code: 'focused-room.material',
    })),
  );
  data.shaderMaterials = materialProject.project;
  const resources = await resourceManifest(
    project,
    projectSessionId,
    visual.assets,
    new Set(
      interactables.flatMap((interactable) => {
        const instance = project.interactableInstances[interactable.interactableId];
        const source = instance
          ? parseInteractableData(
              recordForOwner(project, 'interactable', instance.definition.$ref.id)?.data,
            )
          : null;
        return source?.presentation.hotspots.kind === 'sprite-alpha' && interactable.spriteAssetId
          ? [interactable.spriteAssetId]
          : [];
      }),
    ),
    layoutIds.scripts,
    activeShaderVariant,
    diagnostics,
  );
  return { data: roomPreviewDocumentSchema.parse(data), resources, diagnostics };
}
