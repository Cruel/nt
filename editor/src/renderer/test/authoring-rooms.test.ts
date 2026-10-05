import { describe, expect, it } from 'vite-plus/test';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultRoomData,
  parseRoomData,
  roomAssetRef,
  roomInteractableRef,
  roomRoomRef,
  validateRoomData,
} from '../../shared/project-schema/authoring-rooms';

describe('authoring rooms schema', () => {
  it('rejects the retired same-version Room shape without camera fields', () => {
    const current = defaultRoomData('Foyer');
    const { presentationSpace: _presentationSpace, anchors: _anchors, ...retired } = current;
    expect(parseRoomData(retired)).toBeNull();
  });

  it('provides typed room defaults', () => {
    expect(defaultRoomData('Foyer')).toMatchObject({
      kind: 'room',
      displayName: 'Foyer',
      background: { asset: null, materialApplication: null, fit: 'cover' },
      description: { markup: 'active-text', source: { kind: 'inline', text: '' } },
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
      },
      exits: [],
      placements: [],
    });
  });

  it.each(['beforeEnter', 'beforeLeave'] as const)(
    'rejects Flow-capable commands recursively in %s, regardless of Lua source',
    (stage) => {
      const project = createAuthoringProject();
      const data = defaultRoomData('Foyer');
      project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };
      data.lifecycle[stage] = [
        {
          id: 'branch',
          kind: 'if',
          condition: { kind: 'always' },
          // oxlint-disable-next-line unicorn/no-thenable -- canonical authored Gameplay Command field.
          then: [{ id: 'fault', kind: 'run-lua', source: "error('intentional')" }],
          else: [{ id: 'notify', kind: 'notify', message: data.description }],
        },
      ];
      const errors = validateAuthoringProject(project).filter(
        (item) => item.code === 'room.lifecycle.non-immediate-command',
      );
      expect(errors.map((item) => item.path)).toEqual([
        `/rooms/foyer/data/lifecycle/${stage}/0/else/0`,
        `/rooms/foyer/data/lifecycle/${stage}/0/then/0`,
      ]);
      data.lifecycle.afterEnter = data.lifecycle[stage];
      data.lifecycle[stage] = [];
      expect(
        validateAuthoringProject(project).filter(
          (item) => item.code === 'room.lifecycle.non-immediate-command',
        ),
      ).toEqual([]);
    },
  );

  it('checks unused Room Archetype pre-commit programs and permits immediate branches', () => {
    const project = createAuthoringProject();
    project.archetypes.shared = {
      id: 'shared',
      label: 'Shared',
      data: {
        kind: 'archetype',
        instanceKind: 'room',
        base: null,
        overrides: {
          '/data/lifecycle/beforeEnter': [
            {
              id: 'call',
              kind: 'call-scene',
              scene: { $ref: { collection: 'scenes', id: 'scene' } },
            },
          ],
          '/data/lifecycle/beforeLeave': [
            {
              id: 'call',
              kind: 'call-dialogue',
              dialogue: { $ref: { collection: 'dialogues', id: 'dialogue' } },
            },
          ],
        },
      },
    };
    expect(
      validateAuthoringProject(project)
        .filter((item) => item.code === 'room.lifecycle.non-immediate-command')
        .map((item) => item.path),
    ).toEqual([
      '/archetypes/shared/data/effectiveConfiguration/data/lifecycle/beforeEnter/0',
      '/archetypes/shared/data/effectiveConfiguration/data/lifecycle/beforeLeave/0',
    ]);
    const data = defaultRoomData('Foyer');
    data.lifecycle.beforeEnter = [
      // oxlint-disable-next-line unicorn/no-thenable -- canonical authored Gameplay Command field.
      { id: 'immediate', kind: 'if', condition: { kind: 'always' }, then: [], else: [] },
    ];
    expect(
      validateRoomData(project, 'foyer', { id: 'foyer', label: 'Foyer', data }).filter(
        (item) => item.code === 'room.lifecycle.non-immediate-command',
      ),
    ).toEqual([]);
  });

  it('authors Room Interactable occurrences against exact declared Instance identities', () => {
    const data = defaultRoomData('Foyer');
    data.placements = [
      {
        id: 'key-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    data.interactables = [
      {
        id: 'key-occurrence',
        interactable: roomInteractableRef('key-instance'),
        condition: { kind: 'always' },
        placementId: 'key-placement',
        visible: true,
        order: 0,
      },
    ];

    expect(parseRoomData(data)?.interactables[0]?.interactable).toEqual({
      $ref: { registry: 'interactableInstances', id: 'key-instance' },
    });
  });

  it('validates room dependencies and subrecord IDs', () => {
    const project = createAuthoringProject();
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
    const data = defaultRoomData('Foyer');
    data.background.asset = roomAssetRef('missing-bg');
    data.exits = [
      {
        id: 'exit',
        label: 'Exit',
        direction: 'north',
        target: roomRoomRef('missing-room'),
        condition: { kind: 'always' },
        onRejected: [],
      },
      {
        id: 'exit',
        label: 'Duplicate',
        direction: 'north',
        target: roomRoomRef('missing-room'),
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    data.placements = [
      {
        id: 'lamp',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
      {
        id: 'lamp',
        bounds: { x: 0, y: 0, width: 0.1, height: 0.1 },
        presentation: { label: null, layout: null },
      },
    ];
    project.rooms.foyer.data = data;

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/foyer/data/background/asset/$ref',
          severity: 'error',
        }),
        expect.objectContaining({ path: '/rooms/foyer/data/exits/1/id', severity: 'error' }),
        expect.objectContaining({
          path: '/rooms/foyer/data/exits/1/direction',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/rooms/foyer/data/exits/0/target/$ref',
          severity: 'error',
        }),
        expect.objectContaining({ path: '/rooms/foyer/data/placements/1/id', severity: 'error' }),
      ]),
    );
  });

  it('accepts same-Room exits as real self-loop navigation', () => {
    const project = createAuthoringProject();
    const data = defaultRoomData('Foyer');
    data.exits = [
      {
        id: 'self-loop',
        label: 'Re-enter Foyer',
        direction: 'north',
        target: roomRoomRef('foyer'),
        condition: { kind: 'always' },
        onRejected: [],
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(
      validateRoomData(project, 'foyer', project.rooms.foyer).filter(
        (diagnostic) => diagnostic.path === '/rooms/foyer/data/exits/0/target/$ref',
      ),
    ).toEqual([]);
  });

  it('warns for non-image background assets and empty descriptions through project validation', () => {
    const project = createAuthoringProject();
    project.assets.theme = {
      id: 'theme',
      label: 'Theme',
      data: assetDataFromImportMetadata({
        kind: 'audio',
        projectRelativePath: 'assets/audio/theme.mp3',
        extension: '.mp3',
        byteSize: 10,
        contentHash: 'hash-audio',
        importedAt: '2026-01-01T00:00:00.000Z',
        originalName: 'theme.mp3',
        originalPath: '/tmp/theme.mp3',
        imageMetadata: null,
      }),
    };
    const data = defaultRoomData('Foyer');
    data.background.asset = roomAssetRef('theme');
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'Rooms',
          path: '/rooms/foyer/data/background/asset/$ref',
          severity: 'warning',
        }),
        expect.objectContaining({
          category: 'Rooms',
          path: '/rooms/foyer/data/description',
          severity: 'warning',
        }),
      ]),
    );
  });

  it('validates Camera Views, presentation bounds, and Anchor identities', () => {
    const project = createAuthoringProject();
    const data = defaultRoomData('Foyer');
    data.presentationSpace.bounds = { x: 100, y: 100, width: 1000, height: 700 };
    data.presentationSpace.defaultView.center = { x: 50, y: 50 };
    data.presentationSpace.views = [
      {
        id: 'close-up',
        view: { center: { x: 400, y: 300 }, zoom: 2, rotationDegrees: 0 },
      },
      {
        id: 'close-up',
        view: { center: { x: 1200, y: 300 }, zoom: 1, rotationDegrees: 0 },
      },
    ];
    data.anchors = [
      { id: 'desk', bounds: { x: 0.2, y: 0.4, width: 0.2, height: 0.2 } },
      { id: 'desk', bounds: { x: 0.5, y: 0.4, width: 0.2, height: 0.2 } },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/foyer/data/presentationSpace/views/1/id',
          severity: 'error',
        }),
        expect.objectContaining({ path: '/rooms/foyer/data/anchors/1/id', severity: 'error' }),
        expect.objectContaining({
          path: '/rooms/foyer/data/presentationSpace/defaultView/center',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/rooms/foyer/data/presentationSpace/views/1/view/center',
          severity: 'error',
        }),
      ]),
    );
  });

  it('validates Room cast pose/expression and Hook Registry resources', () => {
    const project = createAuthoringProject();
    project.characters.guard = { id: 'guard', label: 'Guard', data: defaultCharacterData('Guard') };
    const data = defaultRoomData('Foyer');
    data.placements = [
      {
        id: 'doorway',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    data.cast = [
      {
        id: 'guard',
        character: { $ref: { collection: 'characters', id: 'guard' } },
        condition: { kind: 'always' },
        placementId: 'doorway',
        poseId: 'missing-pose',
        expressionId: 'missing-expression',
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    data.scriptHooks = [
      {
        hook: 'compose',
        handler: {
          module: { $ref: { collection: 'scripts', id: 'missing-compose' } },
          export: 'compose',
        },
      },
    ];
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data };

    expect(validateRoomData(project, 'foyer', project.rooms.foyer)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/rooms/foyer/data/cast/0/poseId', severity: 'error' }),
        expect.objectContaining({
          path: '/rooms/foyer/data/cast/0/expressionId',
          severity: 'error',
        }),
        expect.objectContaining({
          path: '/rooms/foyer/data/scriptHooks/0/handler/module/$ref',
          severity: 'error',
        }),
      ]),
    );
  });
});
