import { describe, expect, it } from 'vite-plus/test';
import { executeCommand, createInitialCommandBusState, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

function metadata(name = 'click.mp3'): ImportedAssetMetadata {
  return {
    originalPath: `/tmp/${name}`,
    originalName: name,
    projectRelativePath: `assets/audio/${name}`,
    kind: 'audio',
    extension: '.mp3',
    mimeType: 'audio/mpeg',
    byteSize: 10,
    contentHash: `sha256:${name}`,
    importedAt: '2026-06-29T00:00:00.000Z',
  };
}

function projectWithAsset() {
  const project = createAuthoringProject();
  project.assets.click = {
    id: 'click',
    label: 'Click',
    data: {
      kind: 'audio',
      source: { type: 'project-file', path: 'assets/audio/click.mp3' },
      aliases: ['ui.click'],
      contentHash: 'sha256:old',
    },
  };
  return project;
}

describe('asset operations', () => {
  it('imports assets as undoable authoring records', () => {
    const state = createInitialCommandBusState(toJsonValue(createAuthoringProject()));
    const result = executeCommand(state, {
      type: 'asset.importFiles',
      payload: { assets: [metadata()] },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      assets: {
        click: { id: 'click', data: { kind: 'audio', source: { path: 'assets/audio/click.mp3' } } },
      },
    });
    const undone = undoCommand(result.state);
    expect(undone.state.document).toMatchObject({ assets: {} });
  });

  it('assigns, removes, and rejects conflicting aliases', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithAsset()));
    const assigned = executeCommand(state, {
      type: 'asset.assignAlias',
      payload: { assetId: 'click', alias: 'ui.confirm' },
    });
    expect(assigned.ok).toBe(true);
    state = assigned.state;
    expect(
      (state.document as ReturnType<typeof projectWithAsset>).assets.click.data.aliases,
    ).toContain('ui.confirm');

    const removed = executeCommand(state, {
      type: 'asset.removeAlias',
      payload: { assetId: 'click', alias: 'ui.confirm' },
    });
    expect(removed.ok).toBe(true);
    expect(
      (removed.state.document as ReturnType<typeof projectWithAsset>).assets.click.data.aliases,
    ).not.toContain('ui.confirm');
  });

  it('reimports asset metadata without changing aliases', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithAsset()));
    const result = executeCommand(state, {
      type: 'asset.reimportFile',
      payload: { assetId: 'click', asset: metadata('click-new.mp3') },
    });
    expect(result.ok).toBe(true);
    const data = parseAssetData(
      (result.state.document as ReturnType<typeof projectWithAsset>).assets.click.data,
    );
    expect(data?.source.path).toBe('assets/audio/click-new.mp3');
    expect(data?.aliases).toEqual(['ui.click']);
  });

  it('blocks referenced asset deletes unless forced', () => {
    const project = projectWithAsset();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: {
        kind: 'room',
        displayName: 'Foyer',
        background: {
          asset: { $ref: { collection: 'assets', id: 'click' } },
          material: null,
          fit: 'cover',
          color: null,
        },
        description: { source: { kind: 'inline', text: '' }, markup: 'plain' },
        lifecycle: {
          canEnter: { kind: 'always' },
          canLeave: { kind: 'always' },
          beforeEnter: [],
          afterEnter: [],
          beforeLeave: [],
          afterLeave: [],
        },
        exits: [],
        placements: [],
        overlays: [],
        cast: [],
        props: [],
        environments: [],
        compose: null,
      },
    };
    const state = createInitialCommandBusState(toJsonValue(project));
    const blocked = executeCommand(state, {
      type: 'asset.deleteAsset',
      payload: { assetId: 'click' },
    });
    expect(blocked.ok).toBe(false);
    const forced = executeCommand(state, {
      type: 'asset.deleteAsset',
      payload: { assetId: 'click', force: true },
    });
    expect(forced.ok).toBe(true);
    expect(
      (forced.state.document as ReturnType<typeof projectWithAsset>).assets.click,
    ).toBeUndefined();
  });
});
