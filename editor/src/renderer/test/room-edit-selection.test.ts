import { describe, expect, it } from 'vite-plus/test';
import {
  defaultRoomEditSelectionCandidate,
  hitTestRoomEditCandidates,
  marqueeRoomEditSelections,
  ordinaryRoomEditSelectionCandidate,
  roomEditSelectionCandidates,
  roomEditSelectionCapabilities,
  topmostRoomEditOccupantCandidate,
  type RoomEditSelectionCandidate,
} from '@/editors/rooms/room-edit-selection';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { resolveRoomEditProjection } from '@/editors/rooms/room-edit-projection';

describe('Room Edit semantic selection', () => {
  it('derives Character pick bounds only from drawable layers', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'hero-placement',
        bounds: { x: 0.2, y: 0.2, width: 0.2, height: 0.4 },
        presentation: { label: null, layout: null },
      },
    ];
    room.cast = [
      {
        id: 'hero-cast',
        character: { $ref: { collection: 'characters', id: 'hero' } },
        condition: { kind: 'always' },
        placementId: 'hero-placement',
        profileId: null,
        poseId: null,
        expressionId: null,
        appearanceId: null,
        idleId: null,
        visible: true,
        order: 0,
      },
    ];
    project.assets.hero = {
      id: 'hero',
      label: 'Hero',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/hero.png' },
        aliases: [],
        sampling: 'linear',
        byteSize: 1,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 100, height: 200, hasAlpha: true, orientation: 1 },
      },
    };
    const character = defaultCharacterData('Hero');
    character.initialWorldState = {
      location: { kind: 'room', room: { $ref: { collection: 'rooms', id: 'foyer' } } },
      enabled: true,
      visible: true,
    };
    const pose = character.profiles[0]!.poses[0]!;
    pose.layers[0] = {
      ...pose.layers[0]!,
      visual: { kind: 'image', image: { $ref: { collection: 'assets', id: 'hero' } } },
      scale: 0.5,
    };
    character.profiles[0]!.layers.push({
      id: 'empty-far-away',
      label: 'Empty far away',
      role: 'accessory',
    });
    pose.layers.push({
      layerId: 'empty-far-away',
      visual: null,
      materialApplication: null,
      visible: true,
      offset: { x: 5000, y: 5000 },
      scale: 1,
      anchor: { x: 0.5, y: 1 },
    });
    project.characters.hero = { id: 'hero', label: 'Hero', data: character };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    const projection = resolveRoomEditProjection({
      project,
      roomId: 'foyer',
      room,
      viewport: { width: 1000, height: 500 },
      backgroundImageSize: null,
    });
    const drawableLayer = projection.cast[0]?.layers.find((layer) => layer.layerId === 'body');
    const candidate = roomEditSelectionCandidates(
      project,
      room,
      projection,
      ((key: string) => key) as never,
    ).find((item) => item.selection.kind === 'cast');

    expect(drawableLayer).toBeDefined();
    expect(candidate?.projected.rect).toEqual(drawableLayer?.rect);
  });

  it('models move and resize capability independently for semantic selections', () => {
    expect(roomEditSelectionCapabilities({ kind: 'placement', id: 'desk' })).toEqual({
      move: true,
      resize: true,
    });
    expect(roomEditSelectionCapabilities({ kind: 'cast', id: 'hero' })).toEqual({
      move: true,
      resize: false,
    });
    expect(roomEditSelectionCapabilities({ kind: 'hotspot', id: 'door' })).toEqual({
      move: false,
      resize: false,
    });
  });

  it('retains the containing Placement when an occupant visual is hit outside Placement bounds', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'prop', id: 'lamp' },
        projected: {
          rect: { x: 80, y: 80, width: 200, height: 200 },
          rotationDegrees: 0,
        },
        label: 'Prop · lamp',
        category: 'occupant',
        placementId: 'desk',
      },
      {
        selection: { kind: 'placement', id: 'desk' },
        projected: {
          rect: { x: 120, y: 120, width: 80, height: 80 },
          rotationDegrees: 0,
        },
        label: 'Placement · desk',
        category: 'placement',
        placementId: 'desk',
      },
    ];

    const hits = hitTestRoomEditCandidates(
      candidates,
      { x: 90, y: 90 },
      { width: 500, height: 500 },
    );

    expect(hits.map((candidate) => candidate.selection)).toEqual([
      { kind: 'prop', id: 'lamp' },
      { kind: 'placement', id: 'desk' },
    ]);
    expect(defaultRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'desk',
    });
    expect(ordinaryRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'desk',
    });
    expect(topmostRoomEditOccupantCandidate(hits)?.selection).toEqual({ kind: 'prop', id: 'lamp' });
  });

  it('uses the same default resolver for ordinary click and context preview', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'hotspot', id: 'door' },
        projected: { rect: { x: 100, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Hotspot · door',
        category: 'hotspot',
        placementId: null,
      },
      {
        selection: { kind: 'environment', id: 'fog' },
        projected: { rect: { x: 0, y: 0, width: 500, height: 500 }, rotationDegrees: 0 },
        label: 'Environment · fog',
        category: 'independent',
        placementId: null,
      },
      {
        selection: { kind: 'placement', id: 'empty' },
        projected: { rect: { x: 100, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Placement · empty',
        category: 'placement',
        placementId: 'empty',
      },
    ];
    const hits = hitTestRoomEditCandidates(
      candidates,
      { x: 150, y: 150 },
      { width: 500, height: 500 },
    );
    expect(defaultRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'environment',
      id: 'fog',
    });
    expect(ordinaryRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'environment',
      id: 'fog',
    });
  });

  it('maps source-image Hotspots through the projected background while keeping ordinary clicks placement-oriented', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('Foyer');
    room.hotspots = [
      {
        id: 'door',
        label: 'Door',
        condition: { kind: 'always' },
        inputOrder: 4,
        highlight: { kind: 'default' },
        target: { kind: 'none' },
        shape: { kind: 'rect', bounds: { x: 0.3, y: 0.25, width: 0.2, height: 0.5 } },
      },
    ];
    const projection = {
      viewport: { width: 1000, height: 500 },
      camera: room.presentationSpace.defaultView,
      backgroundColor: {
        rect: { x: 0, y: 0, width: 1000, height: 500 },
        rotationDegrees: 0,
      },
      background: {
        assetId: null,
        fit: 'cover' as const,
        uv: { x: 0.25, y: 0, width: 0.5, height: 1 },
        color: '#000000',
        materialApplication: null,
        rect: { x: 0, y: 0, width: 1000, height: 500 },
        rotationDegrees: 0,
      },
      placements: [
        {
          id: 'door-placement',
          normalizedBounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
          rect: { x: 100, y: 50, width: 200, height: 100 },
          rotationDegrees: 0,
        },
      ],
      interactables: [],
      props: [],
      environments: [],
      cast: [],
      layoutPlaceholders: [],
      worldDraws: [],
    };
    room.placements = [
      {
        id: 'door-placement',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: { label: null, layout: null },
      },
    ];
    const t = ((key: string) => key) as never;
    const candidates = roomEditSelectionCandidates(project, room, projection, t);
    const hotspot = candidates.find((candidate) => candidate.selection.kind === 'hotspot');

    expect(hotspot?.projected.rect.x).toBeCloseTo(100);
    expect(hotspot?.projected.rect.y).toBeCloseTo(125);
    expect(hotspot?.projected.rect.width).toBeCloseTo(400);
    expect(hotspot?.projected.rect.height).toBeCloseTo(250);

    const hits = hitTestRoomEditCandidates(
      candidates,
      { x: 150, y: 125 },
      { width: 1000, height: 500 },
    );
    expect(hits.map((candidate) => candidate.selection)).toEqual(
      expect.arrayContaining([
        { kind: 'hotspot', id: 'door' },
        { kind: 'placement', id: 'door-placement' },
      ]),
    );
    expect(defaultRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'door-placement',
    });
    expect(ordinaryRoomEditSelectionCandidate(hits)?.selection).toEqual({
      kind: 'placement',
      id: 'door-placement',
    });
    expect(
      ordinaryRoomEditSelectionCandidate(
        hits.filter((candidate) => candidate.selection.kind !== 'hotspot'),
      )?.selection,
    ).toEqual({ kind: 'placement', id: 'door-placement' });
    expect(topmostRoomEditOccupantCandidate(hits)).toBeNull();
  });

  it('marquee-selects a Placement by the union of its box and visible occupant geometry', () => {
    const candidates: RoomEditSelectionCandidate[] = [
      {
        selection: { kind: 'prop', id: 'lamp' },
        projected: { rect: { x: 310, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Prop · lamp',
        category: 'occupant',
        placementId: 'desk',
      },
      {
        selection: { kind: 'placement', id: 'desk' },
        projected: { rect: { x: 100, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Placement · desk',
        category: 'placement',
        placementId: 'desk',
      },
      {
        selection: { kind: 'environment', id: 'fog' },
        projected: { rect: { x: 500, y: 100, width: 100, height: 100 }, rotationDegrees: 0 },
        label: 'Environment · fog',
        category: 'independent',
        placementId: null,
      },
    ];

    expect(
      marqueeRoomEditSelections(
        candidates,
        { x: 350, y: 120, width: 20, height: 20 },
        { width: 1000, height: 500 },
      ),
    ).toEqual([{ kind: 'placement', id: 'desk' }]);
    expect(
      marqueeRoomEditSelections(
        candidates,
        { x: 540, y: 120, width: 20, height: 20 },
        { width: 1000, height: 500 },
      ),
    ).toEqual([{ kind: 'environment', id: 'fog' }]);
  });

  it('orders realized WorldOverlay candidates and excludes non-realized Room overlays from picking', () => {
    const project = createAuthoringProject();
    project.layouts.placement = {
      id: 'placement',
      label: 'Placement layout',
      data: defaultLayoutData('Placement layout', 'document'),
    };
    project.layouts.overlay = {
      id: 'overlay',
      label: 'Room overlay',
      data: defaultLayoutData('Room overlay', 'document'),
    };
    const room = defaultRoomData('Foyer');
    room.placements = [
      {
        id: 'desk',
        bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        presentation: {
          label: null,
          layout: { $ref: { collection: 'layouts', id: 'placement' } },
          layoutOrder: 1024,
        },
      },
    ];
    room.overlays = [
      {
        id: 'hud',
        layout: { $ref: { collection: 'layouts', id: 'overlay' } },
        condition: { kind: 'not', condition: { kind: 'always' } },
        visible: true,
        order: 2048,
      },
    ];
    room.environments = [
      {
        id: 'rain',
        condition: { kind: 'always' },
        asset: null,
        materialApplication: emptyMaterialApplication('effect'),
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        plane: 'world-overlay',
        order: 3072,
        clock: 'gameplay',
        scrollPerSecond: { x: 0, y: 0 },
        opacity: 1,
        visible: true,
      },
    ];
    const projection = {
      viewport: { width: 1000, height: 500 },
      camera: room.presentationSpace.defaultView,
      backgroundColor: {
        rect: { x: 0, y: 0, width: 1000, height: 500 },
        rotationDegrees: 0,
      },
      background: {
        assetId: null,
        fit: 'cover' as const,
        uv: { x: 0, y: 0, width: 1, height: 1 },
        color: '#000000',
        materialApplication: null,
        rect: { x: 0, y: 0, width: 1000, height: 500 },
        rotationDegrees: 0,
      },
      placements: [
        {
          id: 'desk',
          normalizedBounds: room.placements[0]!.bounds,
          rect: { x: 100, y: 50, width: 200, height: 100 },
          rotationDegrees: 0,
        },
      ],
      interactables: [],
      props: [],
      environments: [],
      cast: [],
      layoutPlaceholders: [
        {
          placementId: 'desk',
          layoutId: 'placement',
          label: 'Placement layout',
          plane: 'world-overlay' as const,
          order: 1024,
          hasRenderedOccupants: false,
          rect: { x: 100, y: 50, width: 200, height: 100 },
          rotationDegrees: 0,
        },
      ],
      worldDraws: [
        {
          kind: 'environment' as const,
          occurrenceId: 'rain',
          normalizedBounds: room.environments[0]!.bounds,
          plane: 'world-overlay' as const,
          order: 3072,
          assetId: null,
          materialApplication: room.environments[0]!.materialApplication,
          opacity: 1,
          clock: 'gameplay' as const,
          scrollPerSecond: { x: 0, y: 0 },
          rect: { x: 0, y: 0, width: 1000, height: 500 },
          rotationDegrees: 0,
        },
      ],
    };
    const t = ((key: string) => key) as never;

    const candidates = roomEditSelectionCandidates(project, room, projection, t);

    expect(candidates.slice(0, 2).map((candidate) => candidate.selection)).toEqual([
      { kind: 'environment', id: 'rain' },
      { kind: 'placement-layout', id: 'desk' },
    ]);
    expect(candidates.some((candidate) => candidate.selection.kind === 'overlay')).toBe(false);
  });
});
