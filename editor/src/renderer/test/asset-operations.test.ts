import { describe, expect, it } from 'vite-plus/test';
import { executeCommand, createInitialCommandBusState, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import type { ImportedAssetMetadata } from '../../shared/asset-import';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import {
  validateVisualData,
  validateAnimationData,
} from '../../shared/project-schema/authoring-animations';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { lowerSharedAuthoringProject } from '../../shared/authoring-compiler-shared-lowering';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

function importProject() {
  const project = createAuthoringProject();
  project.rooms.room = { id: 'room', label: 'Room', data: defaultRoomData('Room') };
  project.entrypoint = { kind: 'room', id: 'room' };
  return project;
}

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
    imageMetadata: null,
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
      imageMetadata: null,
    },
  };
  return project;
}

describe('asset operations', () => {
  it('creates an empty manual Animation without emitting an invalid compiled resource', () => {
    const state = createInitialCommandBusState(toJsonValue(importProject()));
    const result = executeCommand(state, {
      type: 'entity.createRecord',
      payload: { collection: 'animations', entityId: 'manual', label: 'Manual' },
    });
    expect(result.ok).toBe(true);
    const project = result.state.document as unknown as ReturnType<typeof createAuthoringProject>;
    expect(project.animations.manual?.data).toMatchObject({
      kind: 'animation',
      motions: [{ id: 'default', frames: [] }],
    });
    expect(lowerSharedAuthoringProject(project).draft!.resources.animations).toEqual([]);
    expect(validateAnimationData(project, 'manual', project.animations.manual!.data)).toMatchObject(
      [{ severity: 'warning', code: 'animation.empty' }],
    );
    expect(
      validateVisualData(
        project,
        {
          kind: 'animation',
          animation: { $ref: { collection: 'animations', id: 'manual' } },
          motionId: null,
          playback: null,
        },
        '/visual',
      ),
    ).toMatchObject([{ severity: 'error' }]);
  });
  it('imports an Animation and its frame Assets atomically with provenance outside runtime data', () => {
    const image: ImportedAssetMetadata = {
      ...metadata('pulse-frame.png'),
      kind: 'image',
      extension: '.png',
      projectRelativePath: 'assets/images/pulse-frame.png',
      imageMetadata: { width: 2, height: 1, hasAlpha: true, orientation: 1 },
    };
    const source: ImportedAssetMetadata = {
      ...metadata('pulse.gif'),
      kind: 'binary',
      imageMetadata: null,
      extension: '.gif',
      projectRelativePath: 'assets/binary/pulse.gif',
    };
    const state = createInitialCommandBusState(toJsonValue(importProject()));
    const result = executeCommand(state, {
      type: 'asset.importFiles',
      payload: {
        assets: [image, source],
        fileOrigin: 'copied-by-import',
        animation: {
          label: 'Pulse',
          format: 'gif',
          canvas: { width: 2, height: 1 },
          frameDurationMs: 100,
          frames: [{ assetIndex: 0, durationMs: 40 }],
          sourceAssetIndices: [1],
        },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      animations: {
        pulse: {
          import: {
            format: 'gif',
            sources: [{ path: 'assets/binary/pulse.gif', originalName: 'pulse.gif' }],
          },
          data: {
            kind: 'animation',
            defaultMotionId: 'default',
            motions: [
              {
                id: 'default',
                kind: 'sprite-sequence',
                frames: [
                  { image: { $ref: { collection: 'assets', id: 'pulse-frame' } }, durationMs: 40 },
                ],
                markers: [],
              },
            ],
          },
        },
      },
    });
    const imported = result.state.document as unknown as ReturnType<typeof createAuthoringProject>;
    const manual = structuredClone(imported);
    manual.animations.pulse = {
      id: 'pulse',
      label: 'Pulse',
      data: {
        kind: 'animation',
        canvas: { width: 2, height: 1 },
        defaultMotionId: 'default',
        motions: [
          {
            id: 'default',
            kind: 'sprite-sequence',
            markers: [],
            frames: [
              { image: { $ref: { collection: 'assets', id: 'pulse-frame' } }, durationMs: 40 },
            ],
          },
        ],
      },
    };
    expect(lowerSharedAuthoringProject(imported).draft!.resources.animations).toEqual(
      lowerSharedAuthoringProject(manual).draft!.resources.animations,
    );
    expect(undoCommand(result.state).state.document).toMatchObject({ assets: {}, animations: {} });
  });
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

  it('advances only the reimported Asset association revisions', () => {
    const project = projectWithAsset();
    const source = `sha256:${'a'.repeat(64)}`;
    const nextSource = `sha256:${'b'.repeat(64)}`;
    const originalAsset = `sha256:${'c'.repeat(64)}`;
    project.assets.click.data.attachments = [
      {
        path: 'support/sources/click.wav',
        purpose: 'authoring-source',
        sourceBaselineHash: source,
        assetBaselineHash: originalAsset,
      },
    ];
    const reimported = { ...metadata('click-new.mp3'), contentHash: `sha256:${'d'.repeat(64)}` };
    const result = executeCommand(createInitialCommandBusState(toJsonValue(project)), {
      type: 'asset.reimportFile',
      payload: {
        assetId: 'click',
        asset: reimported,
        sourceRevisions: { 'support/sources/click.wav': nextSource },
      },
    });
    expect(result.ok).toBe(true);
    const data = parseAssetData((result.state.document as typeof project).assets.click.data);
    expect(data?.attachments).toEqual([
      expect.objectContaining({
        sourceBaselineHash: nextSource,
        assetBaselineHash: reimported.contentHash,
      }),
    ]);
  });

  it('repairs nullable referenced asset fields and preserves Force Delete', () => {
    const project = projectWithAsset();
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      data: {
        kind: 'room',
        displayName: 'Foyer',
        background: {
          asset: { $ref: { collection: 'assets', id: 'click' } },
          materialApplication: null,
          fit: 'cover',
          color: null,
        },
        description: { source: { kind: 'inline', text: '' }, markup: 'plain' },
        presentationSpace: {
          size: { width: 1920, height: 1080 },
          bounds: null,
          edgePolicy: 'contain',
          defaultView: { center: { x: 960, y: 540 }, zoom: 1, rotationDegrees: 0 },
          views: [],
        },
        anchors: [],
        lifecycle: {
          canEnter: { kind: 'always' },
          canLeave: { kind: 'always' },
          beforeEnter: [],
          afterEnter: [],
          beforeLeave: [],
          afterLeave: [],
          onEnterRejected: [],
          onLeaveRejected: [],
        },
        exits: [],
        placements: [],
        fallbackInteractablePlacementId: null,
        overlays: [],
        cast: [],
        props: [],
        interactables: [],
        environments: [],
        scriptHooks: [],
        features: [],
        hotspots: [],
      },
    };
    const state = createInitialCommandBusState(toJsonValue(project));
    const repaired = executeCommand(state, {
      type: 'asset.deleteAsset',
      payload: { assetId: 'click' },
    });
    expect(repaired.ok).toBe(true);
    expect(
      (repaired.state.document as ReturnType<typeof projectWithAsset>).rooms.foyer.data.background
        .asset,
    ).toBeNull();
    expect(
      (repaired.state.document as ReturnType<typeof projectWithAsset>).assets.click,
    ).toBeUndefined();
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
