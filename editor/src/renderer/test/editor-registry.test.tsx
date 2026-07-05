import { describe, expect, it } from 'vitest';
import { buildAssetsEditorTab, buildDefaultRecordTab, buildPrimaryPreviewTab, buildTestsEditorTab, buildVariablesEditorTab } from '@/workbench/editor-registry';
import { defaultEditorRegistry } from '@/workbench/default-editors';
import type { AssetNode } from '@/stores/workspace-store';

describe('editor registry', () => {
  it('resolves default editor registrations', () => {
    expect(defaultEditorRegistry.resolve('engine-preview')?.label).toBe('Engine Preview');
    expect(defaultEditorRegistry.resolve('placeholder-entity')?.label).toBe('Placeholder Entity');
    expect(defaultEditorRegistry.resolve('raw-json')).toBeNull();
  });

  it('builds a stable primary preview tab descriptor', () => {
    expect(buildPrimaryPreviewTab()).toMatchObject({
      id: 'tab:primary-preview',
      editorType: 'engine-preview',
      resource: { stableId: 'preview:primary' },
    });
  });

  it('builds collective tabs as project-scoped tabs', () => {
    expect(buildAssetsEditorTab()).toMatchObject({ editorType: 'asset-library', resource: { kind: 'project', stableId: 'assets' } });
    expect(buildTestsEditorTab()).toMatchObject({ editorType: 'test-suite', resource: { kind: 'project', stableId: 'tests' } });
    expect(buildVariablesEditorTab()).toMatchObject({ editorType: 'variables', resource: { kind: 'project', stableId: 'variables' } });
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
      editorType: 'character-detail',
      resource: { collection: 'characters', entityId: 'iris' },
    });
  });

  it('routes schema-pending records to the placeholder editor', () => {
    const node: AssetNode = {
      id: 'objects:key',
      label: 'Key',
      type: 'object',
      collection: 'objects',
      entityId: 'key',
    };
    expect(buildDefaultRecordTab(node)).toMatchObject({
      id: 'tab:placeholder:objects:key',
      editorType: 'placeholder-entity',
      resource: { collection: 'objects', entityId: 'key' },
    });
  });
});
