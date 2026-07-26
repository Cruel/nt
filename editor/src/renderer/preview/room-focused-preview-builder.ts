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
import { effectivePreviewDisplay } from '../../shared/preview-display';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  parseCharacterData,
  type CharacterData,
} from '../../shared/project-schema/authoring-characters';
import type { AuthoringCollectionKey } from '../../shared/project-schema/authoring-collections';
import type {
  AuthoringProject,
  AuthoringRecordBase,
} from '../../shared/project-schema/authoring-project';
import { parseInteractableData } from '../../shared/project-schema/authoring-interactables';
import {
  parseLayoutData,
  type LayoutSourceData,
} from '../../shared/project-schema/authoring-layouts';
import type {
  AuthoringSourceAnalysisArtifact,
  LuaExplicitDependencyTarget,
} from '../../shared/project-schema/authoring-lua-analysis';
import {
  parseMaterialData,
  resolveMaterialData,
} from '../../shared/project-schema/authoring-materials';
import { parseRoomData, type RoomData } from '../../shared/project-schema/authoring-rooms';
import {
  roomPreviewDocumentV2Schema,
  type RoomPreviewDocumentV2,
} from '../../shared/project-schema/room-preview-v2';
import { parseScriptModuleData } from '../../shared/project-schema/authoring-script-modules';
import {
  hasCompleteShaderCompiledOutputMetadata,
  parseShaderData,
} from '../../shared/project-schema/authoring-shaders';
import {
  buildMaterialDefinition,
  buildShaderDefinition,
} from '../../shared/project-schema/shader-material-project';
import { parseVariableData } from '../../shared/project-schema/authoring-variables';
import type { ShaderVariant } from '../../shared/shader-variants';

type Diagnostic = AuthoringDependencyGraphDiagnostic;
type FocusedCondition = RoomPreviewDocumentV2['world']['cast'][number]['condition'];
type FocusedText = RoomPreviewDocumentV2['ui']['description'];
type FocusedVisual = RoomPreviewDocumentV2['world']['cast'][number]['visual'];

export interface BuildFocusedRoomPreviewOptions {
  project: AuthoringProject;
  roomId: string;
  inputs: RoomPreviewInputs;
  graph: AuthoringDependencyGraphSnapshot;
  sourceAnalysis: readonly AuthoringSourceAnalysisArtifact<Diagnostic>[];
  activeShaderVariant: ShaderVariant;
}

export interface FocusedRoomPreviewBuildResult {
  data: RoomPreviewDocumentV2;
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
      if (edge.role === 'room-exit-target') continue;
      const target = nodeText(edge.target);
      if (!nodeKeys.has(target)) {
        nodeKeys.add(target);
        queue.push(target);
      }
    }
    for (const edgeId of graph.incomingEdgeIdsByNodeKey.get(current) ?? []) {
      const edge = graph.edgesById.get(edgeId);
      if (!edge || !['character-room-placement', 'interactable-room-placement'].includes(edge.role))
        continue;
      edgeIds.add(edgeId);
      const source = nodeText(edge.source);
      if (!nodeKeys.has(source)) {
        nodeKeys.add(source);
        queue.push(source);
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
    if (key?.kind === 'property-value')
      owners.add(recordContributionKey(key.ownerCollection, key.ownerId));
  }
  return owners;
}

function focusedCondition(value: RoomData['overlays'][number]['condition']): FocusedCondition {
  if (value.kind === 'always') return { kind: 'always' };
  if (value.kind === 'lua-predicate') return { kind: 'lua-predicate', source: value.source };
  return {
    kind: 'variable-comparison',
    variableId: value.variable.$ref.id,
    operator: value.operator,
    ...(value.value !== undefined ? { value: value.value } : {}),
  };
}

function localizedText(project: AuthoringProject, key: string): string {
  const localization = project.localization;
  const primary = localization.catalogs[localization.defaultLocale]?.[key];
  if (primary !== undefined) return primary;
  if (localization.fallbackLocale)
    return localization.catalogs[localization.fallbackLocale]?.[key] ?? '';
  return '';
}

function focusedText(project: AuthoringProject, value: RoomData['description']): FocusedText {
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
          ? value.source.text
          : localizedText(project, value.source.key),
    },
  };
}

function characterVisual(
  data: CharacterData,
  requestedPoseId: string | null,
  expressionId: string | null,
  idleId: string | null,
  path: string,
  diagnostics: Diagnostic[],
): FocusedVisual {
  const requestedPose = requestedPoseId ?? data.defaults.poseId;
  const selectedExpressionId = expressionId ?? data.defaults.expressionId;
  const expression =
    data.expressions.find((item) => item.id === selectedExpressionId) ?? data.expressions[0];
  const resolvedPoseId = expression?.poseId ?? requestedPose;
  const pose = data.poses.find((item) => item.id === resolvedPoseId) ?? data.poses[0];
  const selectedIdleId = idleId ?? data.defaults.idleId;
  const idle = selectedIdleId ? data.idles.find((item) => item.id === selectedIdleId) : null;
  if (!pose) diagnostics.push(diagnostic(path, 'Character has no resolvable pose.'));
  if (!expression) diagnostics.push(diagnostic(path, 'Character has no resolvable expression.'));
  if (selectedIdleId && !idle)
    diagnostics.push(diagnostic(path, `Character idle '${selectedIdleId}' is missing.`));
  return {
    requestedPoseId: requestedPose,
    resolvedPoseId: pose?.id ?? resolvedPoseId,
    expressionId: expression?.id ?? selectedExpressionId,
    idleId: idle?.id ?? null,
    pose: {
      spriteAssetId: pose?.sprite?.$ref.id ?? null,
      materialId: pose?.material?.$ref.id ?? null,
      offset: pose?.offset ?? { x: 0, y: 0 },
      scale: pose?.scale ?? 1,
      anchor: pose?.anchor ?? { x: 0.5, y: 1 },
    },
    expression: {
      spriteAssetId: expression?.sprite?.$ref.id ?? null,
      materialId: expression?.material?.$ref.id ?? null,
    },
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

function sourceComponent(project: AuthoringProject, value: LayoutSourceData) {
  if (value.sourceMode === 'inline') return { kind: 'inline' as const, text: value.sourceText };
  const assetId = value.sourceAsset?.$ref.id;
  const asset = assetId ? parseAssetData(project.assets[assetId]?.data) : null;
  return { kind: 'asset' as const, logicalPath: asset?.source.path ?? `missing:${assetId ?? ''}` };
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
  const output: RoomPreviewDocumentV2['layouts'] = [];
  const append = (
    layoutId: string | null,
    instanceId: string,
    mount: RoomPreviewDocumentV2['layouts'][number]['mount'],
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
    output.push({
      instanceId,
      layoutId,
      mount,
      source: {
        kind: 'authored',
        layoutKind: data.layoutKind,
        templateId: data.layoutKind === 'fragment' ? 'layout-fragment-host-v1' : null,
        sourceUrl:
          data.rml.sourceMode === 'asset'
            ? `project:/${sourceComponent(project, data.rml).kind === 'asset' ? sourceComponent(project, data.rml).logicalPath : ''}`
            : 'project:/__noveltea_inline_layout.rml',
        defaultParent: data.mount.defaultParent ?? null,
        scopedStyles: data.mount.scopedStyles,
        scriptNamespace: data.script.namespace ?? null,
        rml: sourceComponent(project, data.rml),
        rcss: sourceComponent(project, data.rcss),
        lua,
      },
      scriptEnabled: data.script.enabled,
      containsDedicatedLuaSource:
        lua.kind === 'inline'
          ? new TextEncoder().encode(lua.text.replace(/^\uFEFF/, '')).byteLength > 0
          : true,
      containsExecutableRmlLua: layoutHasExecutableRmlLua(analyses, layoutId),
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

function explicitTargetsForRoom(
  project: AuthoringProject,
  room: RoomData,
): LuaExplicitDependencyTarget[] {
  const output: LuaExplicitDependencyTarget[] = [];
  const add = (targets: readonly LuaExplicitDependencyTarget[] | undefined) => {
    if (targets) output.push(...targets);
  };
  add(room.compose?.additionalDependencies?.targets);
  for (const condition of [
    ...room.overlays.map((item) => item.condition),
    ...room.cast.map((item) => item.condition),
    ...room.props.map((item) => item.condition),
    ...room.environments.map((item) => item.condition),
    ...room.exits.map((item) => item.condition),
  ])
    if (condition.kind === 'lua-predicate') add(condition.additionalDependencies?.targets);
  for (const text of [
    room.description,
    ...room.placements.map((item) => item.presentation.label),
  ].filter(Boolean) as RoomData['description'][])
    if (text.source.kind === 'lua-expression') add(text.source.additionalDependencies?.targets);
  for (const layoutId of [
    gameHudLayoutId(project),
    ...room.overlays.map((item) => item.layout.$ref.id),
  ]) {
    if (!layoutId) continue;
    add(parseLayoutData(project.layouts[layoutId]?.data)?.script.additionalDependencies?.targets);
  }
  return output;
}

function admissionTargetFromNode(
  key: AuthoringDependencyNodeKey,
): LuaExplicitDependencyTarget | null {
  if (key.kind === 'record') return { kind: 'record', collection: key.collection, id: key.id };
  if (key.kind === 'property-definition')
    return { kind: 'property-definition', propertyId: key.id };
  if (key.kind === 'property-value')
    return {
      kind: 'property-value',
      owner: {
        kind: ownerKindByCollection[key.ownerCollection as keyof typeof ownerKindByCollection],
        id: key.ownerId,
      },
      propertyId: key.propertyId,
    };
  if (key.kind === 'nested' && key.family === 'room-placement')
    return { kind: 'room-placement', roomId: key.ownerId, placementId: key.id };
  if (key.kind === 'nested' && key.family === 'room-exit')
    return { kind: 'room-exit', roomId: key.ownerId, exitId: key.id };
  return null;
}

function admissionTargets(
  snapshot: AuthoringDependencyGraphSnapshot,
  closure: ReturnType<typeof roomClosure>,
  explicit: readonly LuaExplicitDependencyTarget[],
): LuaExplicitDependencyTarget[] {
  const targets = [...explicit];
  for (const edgeId of closure.edgeIds) {
    const edge = snapshot.graph.edgesById.get(edgeId);
    if (!edge || !['lua-possible-reference', 'lua-explicit-reference'].includes(edge.role))
      continue;
    const target = admissionTargetFromNode(edge.target);
    if (target) targets.push(target);
  }
  const byKey = new Map<string, LuaExplicitDependencyTarget>();
  for (const target of targets) byKey.set(JSON.stringify(target), target);
  return [...byKey.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compositionDraftTargets(
  snapshot: AuthoringDependencyGraphSnapshot,
  roomId: string,
  room: RoomData,
  analyses: readonly AuthoringSourceAnalysisArtifact<Diagnostic>[],
): LuaExplicitDependencyTarget[] {
  if (!room.compose) return [];
  const scriptId = room.compose.script.$ref.id;
  const ownerKey = recordContributionKey('rooms', roomId);
  const compositionSourcePaths = new Set(
    analyses
      .filter((artifact) => artifact.semanticOwnerKey === ownerKey)
      .flatMap((artifact) => artifact.regions)
      .filter((region) => region.sourcePath.startsWith(`/scripts/${scriptId}/`))
      .map((region) => region.sourcePath),
  );
  const targets: LuaExplicitDependencyTarget[] = [
    ...(room.compose.additionalDependencies?.targets ?? []),
  ];
  for (const edge of snapshot.graph.edgesById.values()) {
    if (!['lua-possible-reference', 'lua-explicit-reference'].includes(edge.role)) continue;
    const fromComposition =
      compositionSourcePaths.has(edge.sourcePath) ||
      edge.evidence?.some(
        (evidence) =>
          evidence.kind === 'lua-occurrence' &&
          compositionSourcePaths.has(evidence.occurrence.sourcePath),
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
  return (project[collection] as Record<string, AuthoringRecordBase> | undefined)?.[id] ?? null;
}

function resolvedProperty(
  project: AuthoringProject,
  kind: string,
  id: string,
  propertyId: string,
): { kind: 'value'; value: null | boolean | number | string } | { kind: 'missing' } {
  const visited = new Set<string>();
  let record = recordForOwner(project, kind, id);
  while (record && !visited.has(record.id)) {
    visited.add(record.id);
    if (Object.hasOwn(record.properties ?? {}, propertyId))
      return { kind: 'value', value: record.properties![propertyId] };
    record = record.extends ? recordForOwner(project, kind, record.extends) : null;
  }
  const fallback = project.properties[propertyId]?.defaultValue;
  return fallback !== undefined ? { kind: 'value', value: fallback } : { kind: 'missing' };
}

function buildAdmissionAndState(
  project: AuthoringProject,
  targets: readonly LuaExplicitDependencyTarget[],
  compositionTargets: readonly LuaExplicitDependencyTarget[],
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
      variables: sortedVariableIds.flatMap((id) => {
        const data = parseVariableData(project.variables[id]?.data);
        return data ? [{ id, type: data.type, value: data.defaultValue }] : [];
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
          ((project[item.collection][item.id]?.data as { displayName?: unknown } | undefined)
            ?.displayName as string | undefined) ??
          project[item.collection][item.id]?.label ??
          null,
      })),
      interactableLocations: sortedLocationIds.flatMap((interactableId) => {
        const location = parseInteractableData(project.interactables[interactableId]?.data)
          ?.initialState.location;
        if (!location) return [];
        return [
          {
            interactableId,
            location:
              location.kind === 'room-placement'
                ? {
                    kind: 'room-placement' as const,
                    roomId: location.placement.room,
                    placementId: location.placement.placement,
                  }
                : { kind: location.kind },
          },
        ];
      }),
    },
  };
}

function collectVisualIds(data: RoomPreviewDocumentV2) {
  const assets = new Set<string>();
  const materials = new Set<string>();
  const addAsset = (id: string | null) => id && assets.add(id);
  const addMaterial = (id: string | null) => id && materials.add(id);
  addAsset(data.world.background.assetId);
  addMaterial(data.world.background.materialId);
  for (const item of [...data.world.persistentCharacters, ...data.world.cast]) {
    addAsset(item.visual.pose.spriteAssetId);
    addAsset(item.visual.expression.spriteAssetId);
    addMaterial(item.visual.pose.materialId);
    addMaterial(item.visual.expression.materialId);
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
  const shaderIds = new Set<string>();
  const assetIds = new Set<string>();
  const queue = [...materialIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const raw = parseMaterialData(project.materials[id]?.data);
    if (raw?.baseMaterialId && !materialIds.has(raw.baseMaterialId)) {
      materialIds.add(raw.baseMaterialId);
      queue.push(raw.baseMaterialId);
    }
    const resolved = resolveMaterialData(project, id).data ?? raw;
    if (!resolved) continue;
    if (resolved.shader) shaderIds.add(resolved.shader.$ref.id);
    for (const texture of resolved.textures)
      if ('$ref' in texture.source) assetIds.add(texture.source.$ref.id);
  }
  return { shaderIds, assetIds };
}

function layoutResourceIds(project: AuthoringProject, layouts: RoomPreviewDocumentV2['layouts']) {
  const assets = new Set<string>();
  const materials = new Set<string>();
  for (const layout of layouts) {
    if (!layout.layoutId) continue;
    const data = parseLayoutData(project.layouts[layout.layoutId]?.data);
    if (!data) continue;
    for (const family of ['images', 'fonts', 'stylesheets', 'scripts', 'templates'] as const)
      for (const ref of data.dependencies[family] ?? []) assets.add(ref.$ref.id);
    for (const ref of data.dependencies.materials) materials.add(ref.$ref.id);
    for (const source of [data.rml, data.rcss, data.lua])
      if (source.sourceMode === 'asset' && source.sourceAsset)
        assets.add(source.sourceAsset.$ref.id);
  }
  const defaultFont = project.settings.text.defaultFont?.$ref.id;
  if (defaultFont) assets.add(defaultFont);
  return { assets, materials };
}

function resourceManifest(
  project: AuthoringProject,
  assetIds: Set<string>,
  shaderIds: Set<string>,
  variant: ShaderVariant,
  diagnostics: Diagnostic[],
): PreviewResourceManifestEntry[] {
  const resources: PreviewResourceManifestEntry[] = [];
  for (const assetId of [...assetIds].sort()) {
    const data = parseAssetData(project.assets[assetId]?.data);
    if (!data?.contentHash || data.byteSize === undefined) {
      diagnostics.push(
        diagnostic(`/assets/${assetId}`, `Focused resource '${assetId}' lacks hash/byte metadata.`),
      );
      continue;
    }
    resources.push({
      resourceId: `asset:${assetId}`,
      sourceKind: 'authoring-asset',
      assetId,
      usageRoles: ['room-preview'],
      fetchProjectRelativePath: data.source.path,
      logicalPath: data.source.path,
      contentHash: data.contentHash as `sha256:${string}`,
      byteSize: data.byteSize,
      kind: data.kind,
      ...(data.sampling ? { sampling: data.sampling } : {}),
    });
  }
  for (const shaderId of [...shaderIds].sort()) {
    const shader = parseShaderData(project.shaders[shaderId]?.data);
    if (!shader) continue;
    for (const stage of shader.stages) {
      const output = stage.compiled[variant];
      if (!output || !hasCompleteShaderCompiledOutputMetadata(output)) {
        diagnostics.push(
          diagnostic(
            `/shaders/${shaderId}/data/stages`,
            `Shader '${shaderId}' has no complete '${variant}' ${stage.stage} output.`,
          ),
        );
        continue;
      }
      resources.push({
        resourceId: `shader:${shaderId}:${stage.stage}:${variant}`,
        sourceKind: 'shader-compiled-output',
        shaderId,
        shaderStage: stage.stage,
        shaderVariant: variant,
        usageRoles: ['room-preview'],
        fetchProjectRelativePath: output.path,
        logicalPath: output.path,
        contentHash: output.byteHash as `sha256:${string}`,
        byteSize: output.byteSize,
        kind: 'shader-binary',
      });
    }
  }
  return resources.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

export function buildFocusedRoomPreview(
  options: BuildFocusedRoomPreviewOptions,
): FocusedRoomPreviewBuildResult {
  const { project, roomId, graph, sourceAnalysis, activeShaderVariant } = options;
  const diagnostics: Diagnostic[] = [];
  const record = project.rooms[roomId];
  const room = parseRoomData(record?.data);
  if (!record || !room) throw new Error(`Room '${roomId}' is missing or invalid.`);
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

  const persistentCharacters = Object.entries(project.characters)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([characterId, characterRecord]) => {
      const data = parseCharacterData(characterRecord.data);
      const location = data?.initialWorldState.location;
      if (!data || location?.kind !== 'room-placement' || location.placement.room !== roomId)
        return [];
      return [
        {
          characterId,
          placementId: location.placement.placement,
          enabled: data.initialWorldState.enabled,
          visible: data.initialWorldState.visible,
          order: 0 as const,
          visual: characterVisual(
            data,
            null,
            null,
            null,
            `/characters/${characterId}/data`,
            diagnostics,
          ),
        },
      ];
    });
  const interactables = Object.entries(project.interactables)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([interactableId, interactableRecord], order) => {
      const data = parseInteractableData(interactableRecord.data);
      const location = data?.initialState.location;
      if (!data || location?.kind !== 'room-placement' || location.placement.room !== roomId)
        return [];
      return [
        {
          interactableId,
          placementId: location.placement.placement,
          spriteAssetId: data.presentation.sprite?.$ref.id ?? null,
          materialId: data.presentation.material?.$ref.id ?? null,
          enabled: data.initialState.enabled,
          visible: data.initialState.visible,
          order,
        },
      ];
    });
  const layouts = buildLayouts(project, room, relevantSourceAnalysis, diagnostics);
  const targets = admissionTargets(graph, closure, explicitTargetsForRoom(project, room));
  const { admission, state } = buildAdmissionAndState(
    project,
    targets,
    compositionDraftTargets(graph, roomId, room, relevantSourceAnalysis),
  );
  const profile = effectivePreviewDisplay(
    options.inputs.displayPreference,
    project.settings.display,
  );
  const data: RoomPreviewDocumentV2 = roomPreviewDocumentV2Schema.parse({
    schema: 'noveltea.room-preview',
    schemaVersion: 2,
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
      recordLabel: record.label,
      displayName: room.displayName,
      visit: { visitIndex: 1, sourceRoomId: null, entryExitId: null },
    },
    luaAdmission: admission,
    queryState: state,
    shaderMaterials: { schema: 'noveltea.shader-materials.v1', shaders: {}, materials: {} },
    world: {
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
          ? focusedText(project, placement.presentation.label)
          : null,
        layoutId: placement.presentation.layout?.$ref.id ?? null,
      })),
      persistentCharacters,
      cast: room.cast.flatMap((entry) => {
        const character = parseCharacterData(project.characters[entry.character.$ref.id]?.data);
        if (!character) {
          diagnostics.push(
            diagnostic(
              `/rooms/${roomId}/data/cast/${entry.id}`,
              `Character '${entry.character.$ref.id}' is invalid.`,
            ),
          );
          return [];
        }
        return [
          {
            entryId: entry.id,
            characterId: entry.character.$ref.id,
            condition: focusedCondition(entry.condition),
            placementId: entry.placementId,
            visible: entry.visible,
            order: entry.order,
            visual: characterVisual(
              character,
              entry.poseId,
              entry.expressionId,
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
    },
    layouts,
    ui: {
      description: focusedText(project, room.description),
      exits: room.exits.map((item) => ({
        exitId: item.id,
        label: item.label,
        direction: item.direction,
        targetRoomId: item.target.$ref.id,
        condition: focusedCondition(item.condition),
      })),
    },
    composition: room.compose
      ? (() => {
          const scriptId = room.compose.script.$ref.id;
          const source = parseScriptModuleData(project.scripts[scriptId]?.data)?.source;
          if (!source) {
            diagnostics.push(
              diagnostic(`/scripts/${scriptId}`, `Composition Script '${scriptId}' is invalid.`),
            );
            return null;
          }
          if (source.kind === 'inline-lua')
            return { scriptId, source: { kind: 'inline' as const, text: source.source } };
          const assetId = source.asset.$ref.id;
          const asset = parseAssetData(project.assets[assetId]?.data);
          return {
            scriptId,
            source: {
              kind: 'asset' as const,
              logicalPath: asset?.source.path ?? `missing:${assetId}`,
            },
          };
        })()
      : null,
  });

  const visual = collectVisualIds(data);
  for (const artifact of relevantSourceAnalysis)
    for (const assetId of artifact.sourceAssetIds) visual.assets.add(assetId);
  const layoutIds = layoutResourceIds(project, layouts);
  for (const id of layoutIds.assets) visual.assets.add(id);
  for (const id of layoutIds.materials) visual.materials.add(id);
  if (data.composition?.source.kind === 'asset') {
    const script = parseScriptModuleData(project.scripts[data.composition.scriptId]?.data);
    if (script?.source.kind === 'asset') visual.assets.add(script.source.asset.$ref.id);
  }
  const materialClosure = completeMaterialClosure(project, visual.materials);
  for (const id of materialClosure.assetIds) visual.assets.add(id);
  for (const materialId of [...visual.materials].sort()) {
    const built = buildMaterialDefinition(project, materialId);
    diagnostics.push(
      ...built.diagnostics.map((item) => ({
        severity: item.severity === 'info' ? ('warning' as const) : item.severity,
        path: item.path,
        message: item.message,
        code: 'focused-room.material',
      })),
    );
    if (built.value) data.shaderMaterials.materials[materialId] = built.value;
  }
  for (const shaderId of [...materialClosure.shaderIds].sort()) {
    const built = buildShaderDefinition(project, shaderId);
    diagnostics.push(
      ...built.diagnostics.map((item) => ({
        severity: item.severity === 'info' ? ('warning' as const) : item.severity,
        path: item.path,
        message: item.message,
        code: 'focused-room.shader',
      })),
    );
    if (built.value) data.shaderMaterials.shaders[shaderId] = built.value;
  }
  const resources = resourceManifest(
    project,
    visual.assets,
    materialClosure.shaderIds,
    activeShaderVariant,
    diagnostics,
  );
  return { data: roomPreviewDocumentV2Schema.parse(data), resources, diagnostics };
}
