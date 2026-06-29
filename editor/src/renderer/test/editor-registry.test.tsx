import { describe, expect, it } from 'vitest';
import { buildPrimaryPreviewTab, buildRawJsonTab } from '@/workbench/editor-registry';
import { defaultEditorRegistry } from '@/workbench/default-editors';
import type { AssetNode } from '@/stores/workspace-store';

describe('editor registry', () => {
  it('resolves default editor registrations', () => {
    expect(defaultEditorRegistry.resolve('engine-preview')?.label).toBe('Engine Preview');
    expect(defaultEditorRegistry.resolve('raw-json')?.label).toBe('Raw JSON');
  });

  it('builds a stable primary preview tab descriptor', () => {
    expect(buildPrimaryPreviewTab()).toMatchObject({
      id: 'tab:primary-preview',
      editorType: 'engine-preview',
      resource: { stableId: 'preview:primary' },
    });
  });

  it('builds raw JSON tab descriptors for project records', () => {
    const node: AssetNode = {
      id: 'room:foyer',
      label: 'foyer',
      type: 'room',
      collection: 'room',
      entityId: 'foyer',
    };
    expect(buildRawJsonTab(node)).toMatchObject({
      id: 'tab:raw-json:record:room:foyer',
      title: 'foyer',
      editorType: 'raw-json',
      resource: {
        kind: 'record',
        stableId: 'record:room:foyer',
        collection: 'room',
        entityId: 'foyer',
      },
    });
  });

  it('does not build a raw JSON tab for non-record folders', () => {
    expect(buildRawJsonTab({ id: 'room', label: 'Rooms', type: 'folder' })).toBeNull();
  });
});
