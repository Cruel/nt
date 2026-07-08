import {
  buildAssetDetailTabForRecord,
  buildCharacterDetailTabForRecord,
  buildDialogueDetailTabForRecord,
  buildLayoutDetailTabForRecord,
  buildMaterialDetailTabForRecord,
  buildProjectSettingsTab,
  buildRoomDetailTabForRecord,
  buildSceneDetailTabForRecord,
  buildShaderDetailTabForRecord,
  buildTestDetailTabForRecord,
} from '@/workbench/editor-registry';
import type { WorkbenchNavigationRequest } from '@/workbench/workbench-navigation';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

function decodePointerSegment(segment: string) {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

export function parseJsonPointer(path: string | null | undefined): string[] {
  if (!path || path[0] !== '/') return [];
  return path.slice(1).split('/').map(decodePointerSegment);
}

function recordLabel(project: AuthoringProject, collection: keyof AuthoringProject, id: string) {
  const records = project[collection];
  if (typeof records !== 'object' || records === null || Array.isArray(records)) return id;
  const record = (records as Record<string, { label?: string }>)[id];
  return record?.label || id;
}

function target(tab: WorkbenchNavigationRequest['tab'], id: string): WorkbenchNavigationRequest {
  return { tab, target: { id, block: 'center', flash: true } };
}

export function resolveProjectDiagnosticTarget(project: AuthoringProject, path: string | null | undefined): WorkbenchNavigationRequest | null {
  const segments = parseJsonPointer(path);
  const [collection, id, scope, field] = segments;

  if (collection === 'entrypoint') {
    return target(buildProjectSettingsTab(), 'projectSettings.startup');
  }

  if (collection === 'settings') {
    if (id === 'ui' || id === 'text' || id === 'runtime') return target(buildProjectSettingsTab(), 'projectSettings.runtime');
    if (id === 'titleScreen') return target(buildProjectSettingsTab(), 'projectSettings.titleScreen');
    if (id === 'app') return target(buildProjectSettingsTab(), 'projectSettings.packageIdentity');
    return target(buildProjectSettingsTab(), 'projectSettings.diagnostics');
  }

  if (!collection || !id) return null;

  if (collection === 'characters' && project.characters[id]) {
    const anchor = scope === 'data'
      ? field === 'preview'
        ? 'character.preview'
        : field === 'poses'
          ? 'character.poses'
          : field === 'expressions'
            ? 'character.expressions'
            : field === 'defaults'
              ? 'character.defaults'
              : 'character.summary'
      : 'character.summary';
    return target(buildCharacterDetailTabForRecord(id, recordLabel(project, 'characters', id)), anchor);
  }

  if (collection === 'layouts' && project.layouts[id]) {
    const source = segments.slice(3).join('/');
    const anchor = source.includes('rml') ? 'layout.source.rml' : source.includes('rcss') ? 'layout.source.rcss' : source.includes('lua') ? 'layout.source.lua' : 'layout.diagnostics';
    return target(buildLayoutDetailTabForRecord(id, recordLabel(project, 'layouts', id)), anchor);
  }

  if (collection === 'rooms' && project.rooms[id]) {
    const anchor = scope === 'data'
      ? field === 'description'
        ? 'room.description'
        : field === 'background'
          ? 'room.background'
          : field === 'paths'
            ? 'room.paths'
            : field === 'hotspots'
              ? 'room.hotspots'
              : field === 'overlays'
                ? 'room.overlays'
                : field === 'scripts'
                  ? 'room.scripts'
                  : 'room.summary'
      : 'room.summary';
    return target(buildRoomDetailTabForRecord(id, recordLabel(project, 'rooms', id)), anchor);
  }

  if (collection === 'dialogues' && project.dialogues[id]) {
    return target(buildDialogueDetailTabForRecord(id, recordLabel(project, 'dialogues', id)), 'dialogue.summary');
  }
  if (collection === 'scenes' && project.scenes[id]) {
    return target(buildSceneDetailTabForRecord(id, recordLabel(project, 'scenes', id)), 'scene.summary');
  }
  if (collection === 'tests' && project.tests[id]) {
    return target(buildTestDetailTabForRecord(id, recordLabel(project, 'tests', id)), 'test.summary');
  }
  if (collection === 'assets' && project.assets[id]) {
    return target(buildAssetDetailTabForRecord(id, recordLabel(project, 'assets', id)), 'asset.summary');
  }
  if (collection === 'materials' && project.materials[id]) {
    return target(buildMaterialDetailTabForRecord(id, recordLabel(project, 'materials', id)), 'material.summary');
  }
  if (collection === 'shaders' && project.shaders[id]) {
    return target(buildShaderDetailTabForRecord(id, recordLabel(project, 'shaders', id)), 'shader.summary');
  }
  if (collection === 'variables' && project.variables[id]) {
    return null;
  }

  return null;
}
