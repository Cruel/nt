import { parseAssetData, type AssetKind } from './authoring-assets';
import type { AuthoringProject, ReferenceTarget } from './authoring-project';
import type { ExportProfileData, ExportShaderVariant } from './authoring-export';
import {
  parseDialogueData,
  type DialogueBlockData,
  type DialogueData,
  type DialogueSegmentData,
} from './authoring-dialogues';
import { parseRoomData } from './authoring-rooms';
import { parseSceneData, type SceneData, type SceneStepData } from './authoring-scenes';
import { getSystemLayoutSetting, parseLayoutData, type SystemLayoutRole } from './authoring-layouts';
import { parseVariableData } from './authoring-variables';
import { buildShaderMaterialProject } from './shader-material-project';
import type { PackageExportOptions, ToolDiagnostic } from '../editor-tooling';

export interface ExportFileEntry {
  source: string;
  packagePath: string;
  assetId?: string;
  kind?: AssetKind;
}

export type PackageFileEntry = ExportFileEntry;

export interface ExportManifestPreview {
  projectName: string;
  projectVersion: string;
  entryCount: number;
  assetCount: number;
  shaderVariants: string[];
  requiredShaderBinaryPaths: string[];
}

export interface AuthoringRuntimeExportBuildOptions {
  projectRoot?: string | null;
  profile: ExportProfileData;
}

export interface AuthoringRuntimeExportBuildResult {
  ok: boolean;
  runtimeProject?: unknown;
  shaderMaterialMetadata?: unknown;
  requiredShaderBinaryPaths: string[];
  fileEntries: ExportFileEntry[];
  manifestPreview: ExportManifestPreview;
  packageOptions: PackageExportOptions;
  diagnostics: ToolDiagnostic[];
}

const ENTITY_TYPE = {
  cutscene: 1,
  action: 2,
  room: 3,
  object: 4,
  dialogue: 5,
  script: 6,
  verb: 7,
  map: 8,
} as const;

function diagnostic(pathValue: string, message: string, severity: ToolDiagnostic['severity'] = 'error', category = 'authoring-export'): ToolDiagnostic {
  return { severity, path: pathValue, message, category };
}

function runtimeRef(type: number, id: string): [number, string] {
  return [type, id];
}

function mapReferenceToRuntime(ref: ReferenceTarget | null | undefined): [number, string] | null {
  if (!ref) return null;
  switch (ref.collection) {
    case 'rooms': return runtimeRef(ENTITY_TYPE.room, ref.id);
    case 'objects': return runtimeRef(ENTITY_TYPE.object, ref.id);
    case 'verbs': return runtimeRef(ENTITY_TYPE.verb, ref.id);
    case 'actions': return runtimeRef(ENTITY_TYPE.action, ref.id);
    case 'dialogues': return runtimeRef(ENTITY_TYPE.dialogue, ref.id);
    case 'scripts': return runtimeRef(ENTITY_TYPE.script, ref.id);
    case 'scenes': return runtimeRef(ENTITY_TYPE.cutscene, ref.id);
    case 'maps': return runtimeRef(ENTITY_TYPE.map, ref.id);
    default: return null;
  }
}

function nextTargetToRuntime(ref: { $ref: { collection: string; id: string } } | null | undefined): [number, string] {
  if (!ref) return runtimeRef(ENTITY_TYPE.room, '');
  switch (ref.$ref.collection) {
    case 'rooms': return runtimeRef(ENTITY_TYPE.room, ref.$ref.id);
    case 'dialogues': return runtimeRef(ENTITY_TYPE.dialogue, ref.$ref.id);
    case 'scenes': return runtimeRef(ENTITY_TYPE.cutscene, ref.$ref.id);
    default: return runtimeRef(ENTITY_TYPE.room, '');
  }
}

function packagePrefixForAsset(kind: AssetKind) {
  switch (kind) {
    case 'image': return 'textures';
    case 'font': return 'fonts';
    case 'audio': return 'audio';
    case 'script': return 'scripts';
    case 'text': return 'text';
    case 'data': return 'data';
    case 'shader-source': return 'resources/shaders';
    case 'binary': return 'resources';
  }
}

function safeBasename(sourcePath: string, fallback: string) {
  const name = sourcePath.split(/[\\/]/).pop() || fallback;
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function assetPackagePath(assetId: string, kind: AssetKind, sourcePath: string) {
  return `${packagePrefixForAsset(kind)}/${safeBasename(sourcePath, assetId)}`;
}

function absoluteSourcePath(projectRoot: string | null | undefined, sourcePath: string) {
  if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(sourcePath)) return sourcePath;
  const cleanSource = sourcePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  if (!projectRoot) return cleanSource;
  return `${projectRoot.replace(/[\\/]+$/, '')}/${cleanSource}`;
}

function addAsset(project: AuthoringProject, assetIds: Set<string>, assetId: string | null | undefined, diagnostics: ToolDiagnostic[], sourcePath: string) {
  if (!assetId) return;
  const record = project.assets[assetId];
  if (!record) {
    diagnostics.push(diagnostic(sourcePath, `Missing referenced asset '${assetId}'.`, 'error', 'asset'));
    return;
  }
  if (!parseAssetData(record.data)) {
    diagnostics.push(diagnostic(`/assets/${assetId}/data`, `Asset '${assetId}' has invalid asset data.`, 'error', 'asset'));
    return;
  }
  assetIds.add(assetId);
}

function collectReferencedAssetIds(project: AuthoringProject, profile: ExportProfileData, diagnostics: ToolDiagnostic[]) {
  const assetIds = new Set<string>();
  if (profile.includeAllProjectAssets) {
    for (const assetId of Object.keys(project.assets)) assetIds.add(assetId);
    return assetIds;
  }

  for (const [roomId, record] of Object.entries(project.rooms)) {
    const data = parseRoomData(record.data);
    if (!data) continue;
    addAsset(project, assetIds, data.background.asset?.$ref.id, diagnostics, `/rooms/${roomId}/data/background/asset/$ref`);
  }

  for (const [materialId, record] of Object.entries(project.materials)) {
    const data = record.data && typeof record.data === 'object' ? record.data as { textures?: unknown } : null;
    const textures = Array.isArray(data?.textures) ? data.textures : [];
    textures.forEach((texture, index) => {
      const source = texture && typeof texture === 'object' ? (texture as { source?: unknown }).source : null;
      if (source && typeof source === 'object' && '$ref' in source) {
        const ref = (source as { $ref?: { collection?: string; id?: string } }).$ref;
        if (ref?.collection === 'assets') addAsset(project, assetIds, ref.id, diagnostics, `/materials/${materialId}/data/textures/${index}/source/$ref`);
      }
    });
  }

  return assetIds;
}

function buildFileEntries(project: AuthoringProject, options: AuthoringRuntimeExportBuildOptions, diagnostics: ToolDiagnostic[]) {
  const assetIds = collectReferencedAssetIds(project, options.profile, diagnostics);
  const entries: ExportFileEntry[] = [];
  for (const assetId of [...assetIds].sort()) {
    const data = parseAssetData(project.assets[assetId]?.data);
    if (!data) continue;
    if (options.profile.kind === 'runtime' && data.kind === 'shader-source') continue;
    entries.push({
      source: absoluteSourcePath(options.projectRoot, data.source.path),
      packagePath: assetPackagePath(assetId, data.kind, data.source.path),
      assetId,
      kind: data.kind,
    });
  }
  return entries;
}

function buildRooms(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const rooms: Record<string, unknown> = {};
  for (const [roomId, record] of Object.entries(project.rooms)) {
    const data = parseRoomData(record.data);
    if (!data) {
      diagnostics.push(diagnostic(`/rooms/${roomId}/data`, `Room '${roomId}' has invalid room data.`));
      continue;
    }
    const objects = data.hotspots
      .filter((hotspot) => hotspot.placeInRoom && hotspot.object?.$ref.id)
      .map((hotspot) => [hotspot.object!.$ref.id, true]);
    const paths = data.paths
      .filter((roomPath) => roomPath.target?.$ref.id)
      .sort((left, right) => left.order - right.order)
      .map((roomPath) => [roomPath.enabled, runtimeRef(ENTITY_TYPE.room, roomPath.target!.$ref.id)]);
    rooms[roomId] = [
      roomId,
      '',
      {},
      data.description.source,
      data.scripts.beforeEnter,
      data.scripts.afterEnter,
      data.scripts.beforeLeave,
      data.scripts.afterLeave,
      objects,
      paths,
      data.displayName || record.label,
    ];
  }
  return rooms;
}

function buildScripts(project: AuthoringProject) {
  const scripts: Record<string, unknown> = {};
  for (const [scriptId, record] of Object.entries(project.scripts)) {
    const data = record.data && typeof record.data === 'object'
      ? record.data as { source?: unknown; autorun?: unknown; enabled?: unknown }
      : {};
    scripts[scriptId] = [
      scriptId,
      '',
      {},
      typeof data.autorun === 'boolean'
        ? data.autorun
        : typeof data.enabled === 'boolean'
          ? data.enabled
          : false,
      typeof data.source === 'string' ? data.source : '',
    ];
  }
  return scripts;
}

function runtimeDialogueSegment(
  type: number,
  text: string,
  children: number[] = [],
  options: Partial<{
    conditionalEnabled: boolean;
    scriptedText: boolean;
    scriptEnabled: boolean;
    autosave: boolean;
    showOnce: boolean;
    logged: boolean;
    conditionScript: string;
    script: string;
  }> = {},
) {
  return [
    type,
    -1,
    options.conditionalEnabled ?? false,
    options.scriptedText ?? false,
    options.scriptEnabled ?? false,
    options.autosave ?? false,
    options.showOnce ?? false,
    options.logged ?? true,
    options.conditionScript ?? '',
    options.script ?? '',
    text,
    children,
  ];
}

function dialogueSpeakerName(project: AuthoringProject, ref: { $ref: { id: string } } | null | undefined) {
  if (!ref?.$ref.id) return '';
  return project.characters[ref.$ref.id]?.label || ref.$ref.id;
}

function dialogueLineText(project: AuthoringProject, data: DialogueData, block: DialogueBlockData, segment: DialogueSegmentData) {
  const speaker = dialogueSpeakerName(project, segment.speaker)
    || dialogueSpeakerName(project, block.defaultSpeaker)
    || dialogueSpeakerName(project, data.defaultSpeaker);
  const source = segment.text.source;
  return speaker ? `[${speaker}]${source}` : source;
}

function addDialogueCompatibilityDiagnostics(
  dialogueId: string,
  data: DialogueData,
  diagnostics: ToolDiagnostic[],
) {
  data.blocks.forEach((block, blockIndex) => {
    if (block.type === 'comment') {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/data/blocks/${blockIndex}`, `Comment block '${block.id}' is not exported to runtime dialogue.`, 'warning'));
    } else if (block.type === 'link') {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/data/blocks/${blockIndex}`, `Link block '${block.id}' is flattened during runtime export.`, 'warning'));
    } else if (block.type === 'branch') {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/data/blocks/${blockIndex}`, `Branch block '${block.id}' is exported as runtime choices.`, 'warning'));
    }
    block.segments.forEach((segment, segmentIndex) => {
      const path = `/dialogues/${dialogueId}/data/blocks/${blockIndex}/segments/${segmentIndex}`;
      if (segment.type === 'comment') {
        diagnostics.push(diagnostic(path, `Comment segment '${segment.id}' is not exported to runtime dialogue.`, 'warning'));
      }
      if (segment.type === 'script') {
        diagnostics.push(diagnostic(path, `Script segment '${segment.id}' is exported as a deferred Lua hook without dialogue text.`, 'warning'));
      }
      if (segment.text.mode === 'lua') {
        diagnostics.push(diagnostic(`${path}/text/mode`, `Lua dialogue text for segment '${segment.id}' is exported as raw source in this slice.`, 'warning'));
      } else if (segment.text.mode === 'active-text') {
        diagnostics.push(diagnostic(`${path}/text/mode`, `Active-text dialogue segment '${segment.id}' is exported as runtime rich text.`, 'warning'));
      }
      if (segment.condition.enabled) {
        diagnostics.push(diagnostic(`${path}/condition`, `Dialogue segment condition '${segment.id}' is deferred to Lua and currently assumed true by the runtime controller.`, 'warning'));
      }
    });
  });
  data.edges.forEach((edge, edgeIndex) => {
    const path = `/dialogues/${dialogueId}/data/edges/${edgeIndex}`;
    if (edge.kind === 'link') {
      diagnostics.push(diagnostic(path, `Link edge '${edge.id}' is exported as a linear runtime transition.`, 'warning'));
    }
    if (edge.condition.enabled) {
      diagnostics.push(diagnostic(`${path}/condition`, `Dialogue edge condition '${edge.id}' is deferred to Lua and currently assumed true by the runtime controller.`, 'warning'));
    }
  });
}

function buildDialogues(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const dialogues: Record<string, unknown> = {};
  const fallbackNextRoomId = Object.keys(project.rooms).sort()[0] ?? '';
  if (!fallbackNextRoomId && Object.keys(project.dialogues).length > 0) {
    diagnostics.push(diagnostic('/dialogues', 'Runtime dialogue export requires at least one Room as the completion target.', 'warning'));
  }
  for (const [dialogueId, record] of Object.entries(project.dialogues)) {
    const data = parseDialogueData(record.data);
    if (!data) {
      diagnostics.push(diagnostic(`/dialogues/${dialogueId}/data`, `Dialogue '${dialogueId}' has invalid dialogue data.`));
      continue;
    }

    addDialogueCompatibilityDiagnostics(dialogueId, data, diagnostics);

    const segments: unknown[][] = [];
    const blockRootIndices = new Map<string, number>();
    const blockTailIndices = new Map<string, number>();
    const blockById = new Map(data.blocks.map((block) => [block.id, block]));

    for (const block of data.blocks) {
      const rootIndex = segments.length;
      segments.push(runtimeDialogueSegment(0, ''));
      blockRootIndices.set(block.id, rootIndex);
      blockTailIndices.set(block.id, rootIndex);
    }

    for (const block of data.blocks) {
      let tail = blockRootIndices.get(block.id)!;
      if (block.type === 'comment') {
        continue;
      }
      for (const segment of block.segments) {
        if (segment.type === 'comment') {
          continue;
        }
        const segmentIndex = segments.length;
        const isScriptOnly = segment.type === 'script';
        segments.push(runtimeDialogueSegment(
          isScriptOnly ? 0 : 1,
          isScriptOnly ? '' : dialogueLineText(project, data, block, segment),
          [],
          {
            conditionalEnabled: segment.condition.enabled,
            scriptedText: segment.text.mode === 'lua',
            scriptEnabled: segment.script.enabled || isScriptOnly,
            autosave: segment.flags.autosave,
            showOnce: segment.flags.showOnce,
            logged: segment.flags.logged,
            conditionScript: segment.condition.source,
            script: isScriptOnly ? segment.script.source || segment.text.source : segment.script.source,
          },
        ));
        (segments[tail][11] as number[]).push(segmentIndex);
        tail = segmentIndex;
      }
      if (block.link.targetBlockId && blockRootIndices.has(block.link.targetBlockId)) {
        (segments[tail][11] as number[]).push(blockRootIndices.get(block.link.targetBlockId)!);
      }
      blockTailIndices.set(block.id, tail);
    }

    const sortedEdges = [...data.edges].sort((left, right) => left.order - right.order);
    for (const edge of sortedEdges) {
      const fromTail = blockTailIndices.get(edge.fromBlockId);
      const toRoot = blockRootIndices.get(edge.toBlockId);
      if (fromTail === undefined || toRoot === undefined || !blockById.has(edge.toBlockId)) {
        continue;
      }
      if (edge.kind === 'choice') {
        const optionIndex = segments.length;
        segments.push(runtimeDialogueSegment(2, edge.label || blockById.get(edge.toBlockId)!.label, [toRoot], {
          conditionalEnabled: edge.condition.enabled,
          scriptEnabled: edge.script.enabled,
          conditionScript: edge.condition.source,
          script: edge.script.source,
        }));
        (segments[fromTail][11] as number[]).push(optionIndex);
      } else {
        (segments[fromTail][11] as number[]).push(toRoot);
      }
    }

    dialogues[dialogueId] = [
      dialogueId,
      '',
      {},
      dialogueSpeakerName(project, data.defaultSpeaker) || data.displayName || record.label,
      runtimeRef(ENTITY_TYPE.room, fallbackNextRoomId),
      blockRootIndices.get(data.entryBlockId) ?? 0,
      data.settings.allowDisabledChoiceSelection,
      data.settings.showDisabledChoices,
      data.settings.logMode === 'nothing' ? 0 : 1,
      segments,
    ];
  }
  return dialogues;
}

function sceneTextSegment(text: string, waitForInput = true, condition = '') {
  return [0, text, waitForInput, true, 0, 1000, 0, 0, 0, true, condition];
}

function scenePageBreakSegment(condition = '') {
  return [1, 1, 0, 0, true, false, condition];
}

function sceneScriptSegment(source: string, autosaveBefore = false, autosaveAfter = false, waitForInput = false, condition = '') {
  return [3, source, autosaveBefore, autosaveAfter, waitForInput, false, condition];
}

function addSceneCompatibilityDiagnostics(sceneId: string, data: SceneData, diagnostics: ToolDiagnostic[]) {
  data.steps.forEach((step, index) => {
    const path = `/scenes/${sceneId}/data/steps/${index}`;
    if (step.condition.enabled) {
      diagnostics.push(diagnostic(`${path}/condition`, `Scene step condition '${step.id}' is deferred to Lua and currently assumed true by the runtime controller.`, 'warning'));
    }
    if (step.type === 'background') {
      diagnostics.push(diagnostic(path, `Background step '${step.id}' is exported as descriptive scene text; visual background changes are not wired in Scene V0.`, 'warning'));
    } else if (step.type === 'dialogue') {
      diagnostics.push(diagnostic(path, `Dialogue step '${step.id}' is exported as a dispatcher-backed Lua hook; nested dialogue handoff is V0 behavior.`, 'warning'));
    } else if (step.type === 'layout') {
      diagnostics.push(diagnostic(path, `Layout step '${step.id}' is exported as a dispatcher-backed Lua hook without transition animation.`, 'warning'));
    } else if (['character', 'audio', 'variable', 'branch', 'transition'].includes(step.type)) {
      diagnostics.push(diagnostic(path, `Scene step type '${step.type}' is not supported by Scene runtime V0 and is skipped.`, 'warning'));
    }
  });
}

function sceneStepToCutsceneSegments(project: AuthoringProject, sceneId: string, step: SceneStepData, index: number, diagnostics: ToolDiagnostic[]) {
  if (!step.enabled) return [];
  const condition = step.condition.enabled ? step.condition.source : '';
  const waitForInput = step.timing.waitForInput || step.type === 'wait' || step.type === 'comment' || step.type === 'background';
  switch (step.type) {
    case 'comment': {
      const text = step.comment.source.trim() || step.label;
      return text ? [sceneTextSegment(text, waitForInput, condition)] : [];
    }
    case 'background': {
      const assetId = step.background.asset?.$ref.id;
      const text = step.label || (assetId ? `Background: ${project.assets[assetId]?.label ?? assetId}` : 'Background');
      return [sceneTextSegment(text, true, condition)];
    }
    case 'wait':
      return step.wait.mode === 'input' || step.timing.waitForInput
        ? [scenePageBreakSegment(condition)]
        : [sceneScriptSegment('', step.autosave.before, step.autosave.after, false, condition)];
    case 'script':
      return step.script.source.trim()
        ? [sceneScriptSegment(step.script.source, step.autosave.before, step.autosave.after, step.timing.waitForInput, condition)]
        : [];
    case 'dialogue': {
      const dialogueId = step.dialogue.dialogue?.$ref.id;
      if (!dialogueId) {
        diagnostics.push(diagnostic(`/scenes/${sceneId}/data/steps/${index}/dialogue/dialogue`, `Dialogue step '${step.id}' has no dialogue target and is skipped.`, 'warning'));
        return [];
      }
      return [sceneScriptSegment(`Game.start_dialogue("${dialogueId}")`, step.autosave.before, step.autosave.after, true, condition)];
    }
    case 'layout': {
      const layoutId = step.layout.layout?.$ref.id;
      if (!layoutId) {
        diagnostics.push(diagnostic(`/scenes/${sceneId}/data/steps/${index}/layout/layout`, `Layout step '${step.id}' has no layout target and is skipped.`, 'warning'));
        return [];
      }
      if (step.layout.action === 'show') {
        return [sceneScriptSegment(`Game.add_layer("${layoutId}")`, step.autosave.before, step.autosave.after, step.timing.waitForInput, condition)];
      }
      diagnostics.push(diagnostic(`/scenes/${sceneId}/data/steps/${index}/layout/action`, `Layout action '${step.layout.action}' is not supported by Scene runtime V0.`, 'warning'));
      return [];
    }
    default:
      return [];
  }
}

function buildScenes(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const cutscenes: Record<string, unknown> = {};
  const fallbackNextRoomId = Object.keys(project.rooms).sort()[0] ?? '';
  for (const [sceneId, record] of Object.entries(project.scenes)) {
    const data = parseSceneData(record.data);
    if (!data) {
      diagnostics.push(diagnostic(`/scenes/${sceneId}/data`, `Scene '${sceneId}' has invalid scene data.`));
      continue;
    }
    addSceneCompatibilityDiagnostics(sceneId, data, diagnostics);
    const segments = data.steps.flatMap((step, index) => sceneStepToCutsceneSegments(project, sceneId, step, index, diagnostics));
    if (segments.length === 0) {
      diagnostics.push(diagnostic(`/scenes/${sceneId}/data/steps`, `Scene '${sceneId}' has no runtime-supported steps.`, 'warning'));
      segments.push(sceneTextSegment(data.displayName || record.label || sceneId, true));
    }
    let next = nextTargetToRuntime(data.settings.next);
    if (!next[1]) next = runtimeRef(ENTITY_TYPE.room, fallbackNextRoomId);
    cutscenes[sceneId] = [
      sceneId,
      '',
      {},
      data.settings.fullScreen,
      data.settings.canFastForward,
      data.settings.speedFactor,
      next,
      segments,
    ];
  }
  return cutscenes;
}

function requiredShaderBinaryPaths(shaderMaterialMetadata: unknown, variants: readonly ExportShaderVariant[]) {
  const required = new Set<string>();
  const root = shaderMaterialMetadata && typeof shaderMaterialMetadata === 'object'
    ? shaderMaterialMetadata as { shaders?: Record<string, unknown> }
    : {};
  for (const shader of Object.values(root.shaders ?? {})) {
    const stages = shader && typeof shader === 'object' ? (shader as { stages?: Record<string, unknown> }).stages : null;
    for (const stage of Object.values(stages ?? {})) {
      const compiled = stage && typeof stage === 'object' ? (stage as { compiled?: Record<string, unknown> }).compiled : null;
      for (const variant of variants) {
        const runtimePath = compiled?.[variant];
        if (typeof runtimePath === 'string' && runtimePath.startsWith('project:/')) required.add(runtimePath.slice('project:/'.length));
      }
    }
  }
  return [...required].sort();
}

function buildVariableDefaults(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const properties: Record<string, unknown> = {};
  for (const [variableId, record] of Object.entries(project.variables)) {
    const data = parseVariableData(record.data);
    if (!data) {
      diagnostics.push(diagnostic(`/variables/${variableId}/data`, `Variable '${variableId}' has invalid variable data.`, 'warning'));
      continue;
    }
    const runtimeId = data.runtimeName?.trim() || variableId;
    properties[runtimeId] = data.defaultValue;
  }
  return properties;
}

function systemLayoutDocumentId(role: SystemLayoutRole) {
  if (role === 'title') return 'runtime_title';
  if (role === 'game-hud') return 'runtime_game';
  if (role === 'pause-menu') return 'runtime_pause_menu';
  return `runtime_${role.replace(/-/g, '_')}`;
}

function systemLayoutAssetBase(layoutId: string) {
  return `project:/layouts/${layoutId.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
}

function buildRuntimeLayoutRml(layoutId: string, data: NonNullable<ReturnType<typeof parseLayoutData>>) {
  const base = systemLayoutAssetBase(layoutId);
  const stylesheet = `<link type="text/rcss" href="${base}.rcss" />`;
  const source = data.rml.sourceText.trim() || '<div></div>';
  if (data.layoutKind === 'document') {
    return source.includes('</head>')
      ? source.replace('</head>', `${stylesheet}\n</head>`)
      : source.replace('<body>', `<head>${stylesheet}</head>\n<body>`);
  }
  return `<rml>\n<head>\n<title>${layoutId}</title>\n${stylesheet}\n</head>\n<body>\n${source}\n</body>\n</rml>\n`;
}

function buildRuntimeUiPlaybackLayouts(project: AuthoringProject, diagnostics: ToolDiagnostic[]) {
  const layouts: Record<string, unknown> = {};
  for (const role of ['title', 'game-hud', 'pause-menu'] as const) {
    const ref = getSystemLayoutSetting(project, role);
    if (!ref) continue;
    const layoutId = ref.$ref.id;
    const record = project.layouts[layoutId];
    const data = parseLayoutData(record?.data);
    if (!data) {
      diagnostics.push(diagnostic(`/settings/ui/systemLayouts/${role}/$ref`, `System layout '${layoutId}' has invalid layout data.`, 'warning'));
      continue;
    }
    if (data.rml.sourceMode !== 'inline' || data.rcss.sourceMode !== 'inline' || data.lua.sourceMode !== 'inline') {
      diagnostics.push(diagnostic(`/settings/ui/systemLayouts/${role}/$ref`, `System layout '${layoutId}' uses asset-mode sources that are not embedded for UI playback yet.`, 'warning'));
      continue;
    }
    layouts[role] = {
      id: layoutId,
      documentId: systemLayoutDocumentId(role),
      assetPath: `${systemLayoutAssetBase(layoutId)}.rml`,
      stylesheetPath: `${systemLayoutAssetBase(layoutId)}.rcss`,
      scriptPath: `${systemLayoutAssetBase(layoutId)}.lua`,
      rml: buildRuntimeLayoutRml(layoutId, data),
      rcss: data.rcss.sourceText,
      lua: data.script.enabled ? data.lua.sourceText : '',
    };
  }
  return layouts;
}

export function hasAuthoringShadersOrMaterials(project: AuthoringProject) {
  return Object.keys(project.shaders).length > 0 || Object.keys(project.materials).length > 0;
}

export function buildAuthoringRuntimeExport(
  project: AuthoringProject,
  options: AuthoringRuntimeExportBuildOptions,
): AuthoringRuntimeExportBuildResult {
  const diagnostics: ToolDiagnostic[] = [];
  const runtimeProject: Record<string, unknown> = {
    engine: 1,
    name: project.project.name,
    version: project.project.version,
    author: project.project.author,
    object: {},
    verb: {},
    action: {},
    room: buildRooms(project, diagnostics),
    map: {},
    dialogue: buildDialogues(project, diagnostics),
    cutscene: buildScenes(project, diagnostics),
    script: buildScripts(project),
    properties: buildVariableDefaults(project, diagnostics),
    startInv: [],
  };

  const runtimeUiPlaybackLayouts = buildRuntimeUiPlaybackLayouts(project, diagnostics);
  if (Object.keys(runtimeUiPlaybackLayouts).length > 0) {
    runtimeProject.__editor_ui_playback = { systemLayouts: runtimeUiPlaybackLayouts };
  }

  const runtimeEntrypoint = mapReferenceToRuntime(project.entrypoint);
  if (!project.entrypoint) {
    diagnostics.push(diagnostic('/entrypoint', 'Project entrypoint is required for runtime export.'));
  } else if (!runtimeEntrypoint || (project.entrypoint.collection !== 'rooms' && project.entrypoint.collection !== 'scripts' && project.entrypoint.collection !== 'dialogues' && project.entrypoint.collection !== 'scenes')) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint collection '${project.entrypoint.collection}' is not runtime-exportable yet.`));
  } else if (project.entrypoint.collection === 'rooms' && !project.rooms[project.entrypoint.id]) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint room '${project.entrypoint.id}' does not exist.`));
  } else if (project.entrypoint.collection === 'scripts' && !project.scripts[project.entrypoint.id]) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint script '${project.entrypoint.id}' does not exist.`));
  } else if (project.entrypoint.collection === 'dialogues' && !project.dialogues[project.entrypoint.id]) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint dialogue '${project.entrypoint.id}' does not exist.`));
  } else if (project.entrypoint.collection === 'scenes' && !project.scenes[project.entrypoint.id]) {
    diagnostics.push(diagnostic('/entrypoint', `Entrypoint scene '${project.entrypoint.id}' does not exist.`));
  } else {
    runtimeProject.entrypoint = runtimeEntrypoint;
  }

  const shaderBuild = buildShaderMaterialProject(project);
  diagnostics.push(...shaderBuild.diagnostics.map((item) => ({ ...item, category: item.category ?? 'shader' })));
  const hasShaderMetadata = Object.keys(shaderBuild.project.shaders).length > 0 || Object.keys(shaderBuild.project.materials).length > 0;
  const shaderMaterialMetadata = hasShaderMetadata ? shaderBuild.project : undefined;
  const shaderVariants = shaderMaterialMetadata ? options.profile.shaderVariants : [];
  const requiredShaderBinaryPaths = shaderMaterialMetadata ? requiredShaderBinaryPathsFromMetadata(shaderMaterialMetadata, shaderVariants as ExportShaderVariant[]) : [];
  const fileEntries = buildFileEntries(project, options, diagnostics);
  const manifestPreview: ExportManifestPreview = {
    projectName: project.project.name,
    projectVersion: project.project.version,
    entryCount: 1 + fileEntries.length + requiredShaderBinaryPaths.length + (shaderMaterialMetadata ? 1 : 0),
    assetCount: fileEntries.length,
    shaderVariants,
    requiredShaderBinaryPaths,
  };
  const packageOptions: PackageExportOptions = {
    kind: options.profile.kind,
    projectName: project.project.name,
    projectVersion: project.project.version,
    createdBy: 'noveltea-editor',
    includeChecksums: options.profile.includeChecksums,
    stripShaderSources: options.profile.stripShaderSources,
    shaderVariants,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths,
    fileEntries: fileEntries.map((entry) => ({ source: entry.source, packagePath: entry.packagePath })),
  };

  return {
    ok: !diagnostics.some((item) => item.severity === 'error'),
    runtimeProject,
    shaderMaterialMetadata,
    requiredShaderBinaryPaths,
    fileEntries,
    manifestPreview,
    packageOptions,
    diagnostics,
  };
}

function requiredShaderBinaryPathsFromMetadata(shaderMaterialMetadata: unknown, variants: readonly ExportShaderVariant[]) {
  return requiredShaderBinaryPaths(shaderMaterialMetadata, variants);
}
