import { describe, expect, it } from 'vitest';
import { buildDefaultRecordTab, buildPrimaryPreviewTab } from '@/workbench/editor-registry';
import { defaultEditorRegistry } from '@/workbench/default-editors';
import type { AssetNode } from '@/stores/workspace-store';

describe('editor registry', () => {
  it('resolves default editor registrations', () => {
    expect(defaultEditorRegistry.resolve('engine-preview')?.label).toBe('Engine Preview');
    expect(defaultEditorRegistry.resolve('raw-json')).toBeNull();
  });

  it('builds a stable primary preview tab descriptor', () => {
    expect(buildPrimaryPreviewTab()).toMatchObject({
      id: 'tab:primary-preview',
      editorType: 'engine-preview',
      resource: { stableId: 'preview:primary' },
    });
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
});
