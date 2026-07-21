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
  buildVariablesEditorTab,
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

function fieldTarget(
  tab: WorkbenchNavigationRequest['tab'],
  id: string,
): WorkbenchNavigationRequest {
  return { tab, target: { id, block: 'center', flash: true, focus: true } };
}

function rowTarget(
  tab: WorkbenchNavigationRequest['tab'],
  id: string,
  payload: Record<string, unknown>,
): WorkbenchNavigationRequest {
  return { tab, target: { id, block: 'center', flash: true, payload } };
}

function indexedSegment(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const index = Number.parseInt(value, 10);
  return Number.isSafeInteger(index) ? index : null;
}

function dataRecord(
  project: AuthoringProject,
  collection: keyof AuthoringProject,
  id: string,
): Record<string, unknown> | null {
  const records = project[collection];
  if (typeof records !== 'object' || records === null || Array.isArray(records)) return null;
  const record = (records as Record<string, { data?: unknown }>)[id];
  return typeof record?.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : null;
}

function arrayItemId(
  recordData: Record<string, unknown> | null,
  field: string,
  index: number | null,
): string | null {
  if (index === null || index < 0) return null;
  const items = recordData?.[field];
  if (!Array.isArray(items) || index >= items.length) return null;
  const item = items[index];
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : String(index);
}

export function resolveProjectDiagnosticTarget(
  project: AuthoringProject,
  path: string | null | undefined,
): WorkbenchNavigationRequest | null {
  const segments = parseJsonPointer(path);
  const [collection, id, scope, field] = segments;
  const settingsTab = buildProjectSettingsTab();

  if (collection === 'entrypoint') {
    return fieldTarget(settingsTab, 'projectSettings.field.entrypoint');
  }

  if (collection === 'project') {
    if (id === 'name') return fieldTarget(settingsTab, 'projectSettings.field.projectName');
    if (id === 'version') return fieldTarget(settingsTab, 'projectSettings.field.projectVersion');
    return target(settingsTab, 'projectSettings.metadata');
  }

  if (collection === 'settings') {
    if (id === 'startup') return target(settingsTab, 'projectSettings.startup');
    if (id === 'ui') {
      if (scope === 'systemLayouts' && field)
        return fieldTarget(settingsTab, `projectSettings.field.systemLayout.${field}`);
      return target(settingsTab, 'projectSettings.runtime');
    }
    if (id === 'text') {
      if (scope === 'defaultFont')
        return fieldTarget(settingsTab, 'projectSettings.field.defaultFont');
      return target(settingsTab, 'projectSettings.runtime');
    }
    if (id === 'runtime') return target(settingsTab, 'projectSettings.runtime');
    if (id === 'display') {
      if (scope === 'referenceResolution' && field === 'width')
        return fieldTarget(settingsTab, 'projectSettings.field.referenceResolutionWidth');
      if (scope === 'referenceResolution' && field === 'height')
        return fieldTarget(settingsTab, 'projectSettings.field.referenceResolutionHeight');
      if (scope === 'barColor')
        return fieldTarget(settingsTab, 'projectSettings.field.displayBarColor');
      if (scope === 'worldRasterPolicy')
        return fieldTarget(settingsTab, 'projectSettings.field.worldRasterPolicy');
      return target(settingsTab, 'projectSettings.display');
    }
    if (id === 'accessibility') {
      if ((scope === 'uiScale' || scope === 'textScale') && field) {
        const suffix = field.charAt(0).toUpperCase() + field.slice(1);
        return fieldTarget(settingsTab, `projectSettings.field.${scope}${suffix}`);
      }
      return target(settingsTab, 'projectSettings.display');
    }
    if (id === 'titleScreen') {
      if (scope === 'titleImage')
        return fieldTarget(settingsTab, 'projectSettings.field.titleImage');
      if (scope === 'startLabel')
        return fieldTarget(settingsTab, 'projectSettings.field.startLabel');
      return target(settingsTab, 'projectSettings.titleScreen');
    }
    if (id === 'app') {
      const appFieldTargets: Record<string, string> = {
        displayName: 'projectSettings.field.appDisplayName',
        shortName: 'projectSettings.field.appShortName',
        publisher: 'projectSettings.field.publisher',
        applicationId: 'projectSettings.field.applicationId',
        saveNamespace: 'projectSettings.field.saveNamespace',
        versionName: 'projectSettings.field.versionName',
        buildNumber: 'projectSettings.field.buildNumber',
        defaultLocale: 'projectSettings.field.defaultLocale',
        icon: 'projectSettings.field.projectIcon',
        launchImage: 'projectSettings.field.launchImage',
        themeColor: 'projectSettings.field.themeColor',
        accentColor: 'projectSettings.field.accentColor',
        launchBackgroundColor: 'projectSettings.field.launchBackgroundColor',
      };
      if (scope && appFieldTargets[scope]) return fieldTarget(settingsTab, appFieldTargets[scope]);
      if (scope === 'android' && field === 'applicationId')
        return fieldTarget(settingsTab, 'projectSettings.field.androidApplicationId');
      if (scope === 'desktop') {
        const desktopFieldTargets: Record<string, string> = {
          appleBundleId: 'projectSettings.field.appleBundleId',
          linuxDesktopId: 'projectSettings.field.linuxDesktopId',
          windowsIdentity: 'projectSettings.field.windowsIdentity',
        };
        if (field && desktopFieldTargets[field])
          return fieldTarget(settingsTab, desktopFieldTargets[field]);
      }
      return target(settingsTab, 'projectSettings.packageIdentity');
    }
    if (id === 'presentation' && scope === 'roomNavigationTransition') {
      if (field === 'kind') return fieldTarget(settingsTab, 'projectSettings.field.transitionKind');
      if (field === 'durationMs')
        return fieldTarget(settingsTab, 'projectSettings.field.transitionDuration');
      if (field === 'color')
        return fieldTarget(settingsTab, 'projectSettings.field.transitionColor');
      return target(settingsTab, 'projectSettings.roomNavigationTransition');
    }
    return target(settingsTab, 'projectSettings.diagnostics');
  }

  if (!collection || !id) return null;

  if (collection === 'characters' && project.characters[id]) {
    const tab = buildCharacterDetailTabForRecord(id, recordLabel(project, 'characters', id));
    const data = dataRecord(project, 'characters', id);
    if (scope === 'data' && field === 'poses') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'poses', index);
      if (rowId)
        return rowTarget(tab, `character.pose.${rowId}`, { kind: 'character-pose', index, rowId });
    }
    if (scope === 'data' && field === 'expressions') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'expressions', index);
      if (rowId)
        return rowTarget(tab, `character.expression.${rowId}`, {
          kind: 'character-expression',
          index,
          rowId,
        });
    }
    const anchor =
      scope === 'data'
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
    return target(tab, anchor);
  }

  if (collection === 'layouts' && project.layouts[id]) {
    const source = segments.slice(3).join('/');
    const anchor = source.includes('rml')
      ? 'layout.source.rml'
      : source.includes('rcss')
        ? 'layout.source.rcss'
        : source.includes('lua')
          ? 'layout.source.lua'
          : 'layout.diagnostics';
    return target(buildLayoutDetailTabForRecord(id, recordLabel(project, 'layouts', id)), anchor);
  }

  if (collection === 'rooms' && project.rooms[id]) {
    const tab = buildRoomDetailTabForRecord(id, recordLabel(project, 'rooms', id));
    const data = dataRecord(project, 'rooms', id);
    if (scope === 'data' && field === 'placements') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'placements', index);
      if (rowId)
        return rowTarget(tab, `room.placement.${rowId}`, { kind: 'room-placement', index, rowId });
    }
    if (scope === 'data' && field === 'exits') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'exits', index);
      if (rowId) return rowTarget(tab, `room.exit.${rowId}`, { kind: 'room-exit', index, rowId });
    }
    const anchor =
      scope === 'data'
        ? field === 'description'
          ? 'room.description'
          : field === 'background'
            ? 'room.background'
            : field === 'exits'
              ? 'room.exits'
              : field === 'placements'
                ? 'room.placements'
                : field === 'overlays'
                  ? 'room.overlays'
                  : field === 'lifecycle'
                    ? 'room.lifecycle'
                    : 'room.summary'
        : 'room.summary';
    return target(tab, anchor);
  }

  if (collection === 'dialogues' && project.dialogues[id]) {
    const tab = buildDialogueDetailTabForRecord(id, recordLabel(project, 'dialogues', id));
    const data = dataRecord(project, 'dialogues', id);
    if (scope === 'data' && field === 'blocks') {
      const blockIndex = indexedSegment(segments[4]);
      const blockId = arrayItemId(data, 'blocks', blockIndex);
      if (blockId && segments[5] === 'segments') {
        const blocks = data?.blocks;
        const block = Array.isArray(blocks) && blockIndex !== null ? blocks[blockIndex] : null;
        const segmentId =
          typeof block === 'object' && block !== null && !Array.isArray(block)
            ? arrayItemId(block as Record<string, unknown>, 'segments', indexedSegment(segments[6]))
            : null;
        if (segmentId)
          return rowTarget(tab, `dialogue.segment.${segmentId}`, {
            kind: 'dialogue-segment',
            blockIndex,
            blockId,
            segmentIndex: indexedSegment(segments[6]),
            segmentId,
          });
      }
      if (blockId)
        return rowTarget(tab, `dialogue.block.${blockId}`, {
          kind: 'dialogue-block',
          blockIndex,
          blockId,
        });
    }
    if (scope === 'data' && field === 'edges') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'edges', index);
      if (rowId)
        return rowTarget(tab, `dialogue.edge.${rowId}`, { kind: 'dialogue-edge', index, rowId });
    }
    return target(tab, 'dialogue.summary');
  }
  if (collection === 'scenes' && project.scenes[id]) {
    const tab = buildSceneDetailTabForRecord(id, recordLabel(project, 'scenes', id));
    const data = dataRecord(project, 'scenes', id);
    if (scope === 'data' && field === 'steps') {
      const index = indexedSegment(segments[4]);
      const rowId = arrayItemId(data, 'steps', index);
      if (rowId) return rowTarget(tab, `scene.step.${rowId}`, { kind: 'scene-step', index, rowId });
    }
    return target(tab, 'scene.summary');
  }
  if (collection === 'tests' && project.tests[id]) {
    const tab = buildTestDetailTabForRecord(id, recordLabel(project, 'tests', id));
    const data = dataRecord(project, 'tests', id);
    if (scope === 'data' && field === 'steps') {
      const stepIndex = indexedSegment(segments[4]);
      const stepId = arrayItemId(data, 'steps', stepIndex);
      if (stepId && segments[5] === 'assertions') {
        const steps = data?.steps;
        const step = Array.isArray(steps) && stepIndex !== null ? steps[stepIndex] : null;
        const assertionId =
          typeof step === 'object' && step !== null && !Array.isArray(step)
            ? arrayItemId(
                step as Record<string, unknown>,
                'assertions',
                indexedSegment(segments[6]),
              )
            : null;
        if (assertionId)
          return rowTarget(tab, `test.assertion.${assertionId}`, {
            kind: 'test-assertion',
            stepIndex,
            stepId,
            assertionIndex: indexedSegment(segments[6]),
            assertionId,
          });
      }
      if (stepId)
        return rowTarget(tab, `test.step.${stepId}`, { kind: 'test-step', stepIndex, stepId });
    }
    return target(tab, 'test.summary');
  }
  if (collection === 'assets' && project.assets[id]) {
    return target(
      buildAssetDetailTabForRecord(id, recordLabel(project, 'assets', id)),
      'asset.summary',
    );
  }
  if (collection === 'materials' && project.materials[id]) {
    return target(
      buildMaterialDetailTabForRecord(id, recordLabel(project, 'materials', id)),
      'material.summary',
    );
  }
  if (collection === 'shaders' && project.shaders[id]) {
    return target(
      buildShaderDetailTabForRecord(id, recordLabel(project, 'shaders', id)),
      'shader.summary',
    );
  }
  if (collection === 'variables' && project.variables[id]) {
    return rowTarget(buildVariablesEditorTab(), `variable.row.${id}`, {
      kind: 'variable',
      rowId: id,
    });
  }

  return null;
}
