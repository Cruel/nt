import { describe, expect, it } from 'vite-plus/test';
import {
  MUTATION_SURFACE_ATTRIBUTIONS,
  PROJECT_SETTINGS_OWNED_PATHS,
  resolveSaveUnitForResource,
  resolveSaveUnitForTab,
} from '@/project/save-unit-registry';
import type { WorkbenchResource, WorkbenchTab } from '@/workbench/workbench-types';
import { defaultEditorRegistrations } from '@/workbench/default-editors';

const project = {};

function recordResource(collection: string, entityId: string): WorkbenchResource {
  return {
    kind: 'record',
    stableId: `record:${collection}:${entityId}`,
    collection,
    entityId,
  };
}

const representativeResources: Record<string, WorkbenchResource> = {
  'engine-preview': { kind: 'preview', stableId: 'preview:engine' },
  'full-game-preview': { kind: 'preview', stableId: 'preview:full-game' },
  'asset-library': { kind: 'project', stableId: 'assets' },
  'asset-detail': recordResource('assets', 'logo'),
  'image-generation': { kind: 'tool', stableId: 'utility:image-generation' },
  'comfyui-workflows': { kind: 'tool', stableId: 'utility:comfyui-workflows' },
  'shader-detail': recordResource('shaders', 'basic'),
  'material-detail': recordResource('materials', 'panel'),
  'layout-detail': recordResource('layouts', 'hud'),
  'character-detail': recordResource('characters', 'hero'),
  'room-detail': recordResource('rooms', 'foyer'),
  'interactable-detail': recordResource('interactables', 'door'),
  'dialogue-detail': recordResource('dialogues', 'intro'),
  'scene-detail': recordResource('scenes', 'opening'),
  'test-suite': { kind: 'project', stableId: 'tests' },
  'test-detail': recordResource('tests', 'smoke'),
  'placeholder-entity': recordResource('rooms', 'placeholder'),
  'verb-detail': recordResource('verbs', 'examine'),
  'interaction-detail': recordResource('interactions', 'use-key'),
  'map-detail': recordResource('maps', 'world'),
  'script-module-detail': recordResource('scripts', 'startup'),
  variables: { kind: 'project', stableId: 'variables' },
  components: { kind: 'tool', stableId: 'utility:components' },
  settings: { kind: 'tool', stableId: 'utility:settings' },
  'project-settings': { kind: 'project', stableId: 'project:settings' },
  'platform-export': { kind: 'project', stableId: 'project:platform-export' },
  'platform-export-profiles': {
    kind: 'project',
    stableId: 'project:platform-export-profiles',
  },
  'project-chapters': { kind: 'project', stableId: 'project:chapters' },
  'project-tags': { kind: 'project', stableId: 'project:tags' },
};

describe('save-unit registry', () => {
  it('maps every registered editor type to a savable or explicit non-content descriptor', () => {
    expect(Object.keys(representativeResources).sort()).toEqual(
      defaultEditorRegistrations.map((registration) => registration.type).sort(),
    );
    for (const registration of defaultEditorRegistrations) {
      const resolution = resolveSaveUnitForResource(
        representativeResources[registration.type],
        registration.type,
        project,
      );
      expect(resolution.status, registration.type).not.toBe('unsupported');
    }
  });

  it('uses one stable record save-unit identity across duplicate tab views', () => {
    const resource = recordResource('rooms', 'foyer');
    const first: WorkbenchTab = {
      id: 'tab:room:first',
      title: 'Foyer',
      editorType: 'room-detail',
      resource,
    };
    const second: WorkbenchTab = { ...first, id: 'tab:room:second' };
    const firstResolution = resolveSaveUnitForTab(first, project);
    const secondResolution = resolveSaveUnitForTab(second, project);
    expect(firstResolution.status).toBe('savable');
    expect(secondResolution.status).toBe('savable');
    if (firstResolution.status !== 'savable' || secondResolution.status !== 'savable') return;
    expect(firstResolution.descriptor.id).toBe('record:rooms:foyer');
    expect(secondResolution.descriptor.id).toBe(firstResolution.descriptor.id);
    expect(firstResolution.descriptor.ownedPaths).toEqual(['/rooms/foyer']);
  });

  it('owns only the explicit Project Settings paths and never the document root', () => {
    const resolution = resolveSaveUnitForResource(
      representativeResources['project-settings'],
      'project-settings',
      project,
    );
    expect(resolution.status).toBe('savable');
    if (resolution.status !== 'savable') return;
    expect(resolution.descriptor.id).toBe('project:settings');
    expect(resolution.descriptor.ownedPaths).toEqual([...PROJECT_SETTINGS_OWNED_PATHS].sort());
    expect(resolution.descriptor.ownedPaths).not.toContain('');
  });

  it('distinguishes collection-wide editors, non-content tools, and unsupported editors', () => {
    const variables = resolveSaveUnitForResource(
      representativeResources.variables,
      'variables',
      project,
    );
    expect(variables).toMatchObject({
      status: 'savable',
      descriptor: { id: 'collection:variables', ownedPaths: ['/variables'] },
    });

    expect(
      resolveSaveUnitForResource(
        representativeResources['full-game-preview'],
        'full-game-preview',
        project,
      ),
    ).toMatchObject({ status: 'non-content', descriptor: { ownedPaths: [] } });

    expect(
      resolveSaveUnitForResource(
        { kind: 'tool', stableId: 'utility:unknown' },
        'unknown-editor',
        project,
      ),
    ).toMatchObject({ status: 'unsupported', editorType: 'unknown-editor' });
  });

  it('accounts for every current non-tab and cross-unit mutation surface', () => {
    expect(MUTATION_SURFACE_ATTRIBUTIONS).toEqual({
      explorerStructuralChanges: {
        originSaveUnitId: 'structure:<collection>',
        persistencePolicy: 'auto-commit',
      },
      explorerOptionsAndVisibility: {
        originSaveUnitId: 'project:explorer-options',
        persistencePolicy: 'auto-commit',
      },
      assetImport: {
        originSaveUnitId: 'workflow:asset-import',
        persistencePolicy: 'auto-commit',
      },
      imageGenerationAssets: {
        originSaveUnitId: 'workflow:image-generation-assets',
        persistencePolicy: 'auto-commit',
      },
      exportProfileEditing: {
        originSaveUnitId: 'project:platform-export-profiles',
        persistencePolicy: 'manual-save',
      },
      shaderCompiledOutputs: {
        originSaveUnitId: 'workflow:shader-compiled-output',
        persistencePolicy: 'manual-save',
      },
      successfulExportIdentity: {
        originSaveUnitId: 'workflow:successful-export-identity',
        persistencePolicy: 'auto-commit',
      },
      playRecorderTests: {
        originSaveUnitId: 'workflow:play-recorder',
        persistencePolicy: 'manual-save',
      },
      newEntity: {
        originSaveUnitId: 'workflow:new-entity',
        persistencePolicy: 'auto-commit',
      },
      discardDirtyUnits: {
        originSaveUnitId: 'workflow:discard-dirty-units',
        persistencePolicy: 'manual-save',
      },
      layoutSystemRole: {
        originSaveUnitId: 'project:settings',
        persistencePolicy: 'manual-save',
      },
    });
  });
});
