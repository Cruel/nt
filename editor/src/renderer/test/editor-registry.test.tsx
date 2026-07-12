import { describe, expect, it } from 'vitest';
import { buildAssetsEditorTab, buildComfyUiWorkflowsTab, buildDefaultRecordTab, buildFullGamePreviewTab, buildPlatformExportProfilesTab, buildPlatformExportTab, buildTestsEditorTab, buildVariablesEditorTab, resolveEditorPolicies, type WorkbenchEditorRegistration } from '@/workbench/editor-registry';
import { defaultEditorRegistry } from '@/workbench/default-editors';
import type { AssetNode } from '@/stores/workspace-store';

describe('editor registry', () => {
  it('resolves default editor registrations', () => {
    expect(defaultEditorRegistry.resolve('engine-preview')?.label).toBe('Engine Preview');
    expect(defaultEditorRegistry.resolve('full-game-preview')?.label).toBe('Play');
    expect(defaultEditorRegistry.resolve('comfyui-workflows')?.label).toBe('ComfyUI Workflows');
    expect(defaultEditorRegistry.resolve('platform-export')?.label).toBe('Export');
    expect(defaultEditorRegistry.resolve('placeholder-entity')?.label).toBe('Placeholder Entity');
    expect(defaultEditorRegistry.resolve('raw-json')).toBeNull();
  });

  it('defaults missing editor policies to active-only with no preview host', () => {
    const registration: WorkbenchEditorRegistration = {
      type: 'test-editor',
      label: 'Test Editor',
      component: () => null,
    };

    expect(resolveEditorPolicies(registration)).toEqual({
      mountPolicy: 'active-only',
      previewHostPolicy: 'none',
      previewPersistence: undefined,
    });
  });

  it('resolves default preview editor policies', () => {
    const enginePreviewRegistration = defaultEditorRegistry.resolve('engine-preview');
    const playRegistration = defaultEditorRegistry.resolve('full-game-preview');

    expect(enginePreviewRegistration).not.toBeNull();
    expect(playRegistration).not.toBeNull();
    expect(resolveEditorPolicies(enginePreviewRegistration!)).toEqual({
      mountPolicy: 'active-only',
      previewHostPolicy: 'none',
      previewPersistence: undefined,
    });
    expect(resolveEditorPolicies(playRegistration!)).toEqual({
      mountPolicy: 'keep-mounted-while-open',
      previewHostPolicy: 'dedicated-while-open',
      previewPersistence: 'stateful',
    });
  });

  it('marks derived embedded preview editors as pooled per tab group', () => {
    const pooledDerivedEditorTypes = [
      'shader-detail',
      'material-detail',
      'layout-detail',
      'character-detail',
      'room-detail',
      'dialogue-detail',
      'scene-detail',
    ];

    for (const editorType of pooledDerivedEditorTypes) {
      const registration = defaultEditorRegistry.resolve(editorType);
      expect(registration).not.toBeNull();
      expect(resolveEditorPolicies(registration!)).toEqual({
        mountPolicy: 'active-only',
        previewHostPolicy: 'pooled-per-tab-group',
        previewPersistence: 'derived',
      });
    }
  });

  it('builds a stable full-game preview tab descriptor', () => {
    expect(buildFullGamePreviewTab()).toMatchObject({
      id: 'tab:full-game-preview',
      title: 'Play',
      editorType: 'full-game-preview',
      resource: { stableId: 'preview:full-game' },
    });
  });

  it('builds platform export as a stable project-scoped workbench tab', () => {
    expect(buildPlatformExportTab()).toEqual({
      id: 'tab:platform-export',
      title: 'Export',
      editorType: 'platform-export',
      resource: { kind: 'project', stableId: 'project:platform-export' },
    });
  });

  it('builds export profile management as a separate project-scoped tab', () => {
    expect(buildPlatformExportProfilesTab()).toEqual({
      id: 'tab:platform-export-profiles',
      title: 'Export Profiles',
      editorType: 'platform-export-profiles',
      resource: { kind: 'project', stableId: 'project:platform-export-profiles' },
    });
    expect(defaultEditorRegistry.resolve('platform-export-profiles')?.label).toBe('Export Profiles');
  });

  it('builds the global ComfyUI workflows tab descriptor', () => {
    expect(buildComfyUiWorkflowsTab()).toEqual({
      id: 'tab:comfyui-workflows',
      title: 'ComfyUI Workflows',
      editorType: 'comfyui-workflows',
      resource: { kind: 'tool', stableId: 'utility:comfyui-workflows' },
    });
  });

  it('builds collective tabs as project-scoped tabs', () => {
    expect(buildAssetsEditorTab()).toMatchObject({ editorType: 'asset-library', resource: { kind: 'project', stableId: 'assets' } });
    expect(buildAssetsEditorTab('logo')).toMatchObject({ editorType: 'asset-library', resource: { kind: 'project', stableId: 'assets', entityId: 'logo' } });
    expect(buildTestsEditorTab()).toMatchObject({ editorType: 'test-suite', resource: { kind: 'project', stableId: 'tests' } });
    expect(buildTestsEditorTab('smoke')).toMatchObject({ editorType: 'test-suite', resource: { kind: 'project', stableId: 'tests', entityId: 'smoke' } });
    expect(buildVariablesEditorTab()).toMatchObject({ editorType: 'variables', resource: { kind: 'project', stableId: 'variables' } });
    expect(buildVariablesEditorTab('score')).toMatchObject({ editorType: 'variables', resource: { kind: 'project', stableId: 'variables', entityId: 'score' } });
  });

  it('routes room records to the typed room editor', () => {
    const node: AssetNode = {
      id: 'rooms:foyer',
      label: 'Foyer',
      type: 'room',
      collection: 'rooms',
      entityId: 'foyer',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:room-detail:rooms:foyer',
      title: 'Foyer',
      editorType: 'room-detail',
      resource: { collection: 'rooms', entityId: 'foyer' },
    });
  });

  it('routes dialogue records to the typed dialogue editor', () => {
    const node: AssetNode = {
      id: 'dialogues:intro',
      label: 'Intro',
      type: 'dialogue',
      collection: 'dialogues',
      entityId: 'intro',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:dialogue-detail:dialogues:intro',
      title: 'Intro',
      editorType: 'dialogue-detail',
      resource: { collection: 'dialogues', entityId: 'intro' },
    });
  });

  it('routes scene records to the typed scene editor', () => {
    const node: AssetNode = {
      id: 'scenes:opening',
      label: 'Opening',
      type: 'scene',
      collection: 'scenes',
      entityId: 'opening',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:scene-detail:scenes:opening',
      title: 'Opening',
      editorType: 'scene-detail',
      resource: { collection: 'scenes', entityId: 'opening' },
    });
  });

  it('routes test records to the typed test editor', () => {
    const node: AssetNode = {
      id: 'tests:smoke',
      label: 'Smoke',
      type: 'test',
      collection: 'tests',
      entityId: 'smoke',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:test-detail:tests:smoke',
      title: 'Smoke',
      editorType: 'test-detail',
      resource: { collection: 'tests', entityId: 'smoke' },
    });
  });

  it('routes layout records to the typed layout editor', () => {
    const node: AssetNode = {
      id: 'layouts:main',
      label: 'Main UI',
      type: 'layout',
      collection: 'layouts',
      entityId: 'main',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:layout-detail:layouts:main',
      title: 'Main UI',
      editorType: 'layout-detail',
      resource: { collection: 'layouts', entityId: 'main' },
    });
  });

  it('routes character records to the typed character editor', () => {
    const node: AssetNode = {
      id: 'characters:iris',
      label: 'Iris',
      type: 'character',
      collection: 'characters',
      entityId: 'iris',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:character-detail:characters:iris',
      title: 'Iris',
      editorType: 'character-detail',
      resource: { collection: 'characters', entityId: 'iris' },
    });
  });

  it('routes schema-pending records to the placeholder editor', () => {
    const node: AssetNode = {
      id: 'interactables:key',
      label: 'Key',
      type: 'interactable',
      collection: 'interactables',
      entityId: 'key',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:placeholder:interactables:key',
      title: 'Key',
      editorType: 'placeholder-entity',
      resource: { collection: 'interactables', entityId: 'key' },
    });
  });
});
