import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData, validateRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultMapData, validateMapData } from '../../shared/project-schema/authoring-maps';
import { mapRecordSchema } from '../../shared/project-schema/authoring-records';
import {
  decodeSparseRecordYaml,
  encodeSparseRecordYaml,
} from '../../shared/project-workspace/sparse-record-yaml-source';
import { validateRoomHotspotAuthoringSemantics } from '../../shared/project-schema/authoring-hotspot-validation';
import { validateInteractableRecordHotspotAuthoringSemantics } from '../../shared/project-schema/authoring-hotspot-validation';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { defaultHotspotBehavior } from '../../shared/project-schema/authoring-hotspots';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import {
  defaultVariableData,
  validateVariableData,
} from '../../shared/project-schema/authoring-variables';

const executable = process.env.NOVELTEA_ROOM_MAP_CERTIFY;
type NativeResult = {
  valid: boolean;
  nativeNormalized?: unknown;
  diagnostics: { path: string; code: string; severity: string; message: string }[];
};
const call = (mode: string, source: string): NativeResult => {
  const result = spawnSync(executable!, [mode], { input: source, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NativeResult;
};

const fixture = () => {
  const project = createAuthoringProject();
  for (const id of ['foyer', 'hall', 'attic']) {
    project.rooms[id] = {
      id,
      label: id,
      traits: [],
      data: defaultRoomData(id),
    };
  }
  project.rooms.foyer!.data.exits.push({
    id: 'to-hall',
    label: 'Hall',
    direction: 'east',
    target: { $ref: { collection: 'rooms', id: 'hall' } },
    condition: { kind: 'always' },
    onRejected: [],
  });
  project.rooms.hall!.data.exits.push({
    id: 'to-foyer',
    label: 'Foyer',
    direction: 'west',
    target: { $ref: { collection: 'rooms', id: 'foyer' } },
    condition: { kind: 'always' },
    onRejected: [],
  });
  const map = defaultMapData();
  for (const [id, room] of [
    ['foyer', 'foyer'],
    ['hall', 'hall'],
  ] as const)
    map.locations.push({
      id,
      room: { $ref: { collection: 'rooms', id: room } },
      regions: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 0.4, y: 0 },
            { x: 0.4, y: 0.4 },
          ],
        },
      ],
      label: null,
      icon: null,
      style: null,
      labelAnchor: null,
      connectionAnchor: null,
      visibility: { kind: 'always' },
      pickOrder: 0,
      logicalOrder: 0,
    });
  map.connections.push({
    id: 'foyer-hall',
    exits: [
      { room: 'foyer', exit: 'to-hall' },
      { room: 'hall', exit: 'to-foyer' },
    ],
    label: null,
    icon: null,
    style: null,
    visibility: { kind: 'always' },
    logicalOrder: 0,
    path: [],
    hitRegions: [],
  });
  project.maps.world = { id: 'world', label: 'World', data: map };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  return project;
};

describe.skipIf(!executable)('native Room/Map/Hotspot semantic differential', () => {
  it('reproduces sparse Map normalization, nullable choices, and geometry errors', () => {
    const project = fixture();
    const yaml = encodeSparseRecordYaml('maps', project.maps.world);
    const valid = call('--map', yaml);
    const reference = mapRecordSchema.safeParse(decodeSparseRecordYaml('maps', yaml));
    expect(reference.success).toBe(true);
    expect(valid.valid, JSON.stringify(valid.diagnostics)).toBe(true);
    if (reference.success) expect(valid.nativeNormalized).toEqual(reference.data);

    project.maps.world!.data.locations[0]!.regions[0]!.points[0]!.x = 1.5;
    const badYaml = yaml.replace('x: 0', 'x: 1.5');
    const bad = call('--map', badYaml);
    expect(bad.valid).toBe(false);
    expect(bad.diagnostics.map((d) => d.path)).toContain('/data/locations/0/regions/0/points/0/x');
    expect(mapRecordSchema.safeParse(decodeSparseRecordYaml('maps', badYaml)).success).toBe(false);
  });

  it('matches key Room, Map, and Hotspot effective semantic outcomes', () => {
    const project = fixture();
    const baseline = call('--project', JSON.stringify(project));
    expect(baseline.valid, JSON.stringify(baseline.diagnostics)).toBe(true);
    expect(validateMapData(project, 'world', project.maps.world!)).toEqual([]);
    expect(
      validateRoomData(project, 'foyer', project.rooms.foyer!).filter(
        (d) => d.severity === 'error',
      ),
    ).toEqual([]);

    project.rooms.foyer!.data.exits[0]!.target.$ref.id = 'attic';
    project.maps.world!.data.locations[1]!.room.$ref.id = 'foyer';
    project.rooms.foyer!.data.presentationSpace.defaultView.center.x = -1;
    const ts = [
      ...validateMapData(project, 'world', project.maps.world!),
      ...validateRoomData(project, 'foyer', project.rooms.foyer!),
      ...validateRoomHotspotAuthoringSemantics(project, 'foyer'),
    ].filter((d) => d.severity === 'error');
    const native = call('--project', JSON.stringify(project));
    expect(native.valid).toBe(false);
    for (const path of [
      '/maps/world/data/locations/1/room/$ref',
      '/maps/world/data/connections/0/exits',
      '/rooms/foyer/data/presentationSpace/defaultView/center',
    ]) {
      expect(ts.map((d) => d.path)).toContain(path);
      expect(native.diagnostics.map((d) => d.path)).toContain(path);
    }
  });

  it('rejects duplicate Room exit directions and invalid hotspot-owned targets', () => {
    const project = fixture();
    project.rooms.foyer!.data.exits.push({
      ...structuredClone(project.rooms.foyer!.data.exits[0]!),
      id: 'other',
      target: { $ref: { collection: 'rooms', id: 'attic' } },
    });
    const native = call('--project', JSON.stringify(project));
    const ts = validateRoomData(project, 'foyer', project.rooms.foyer!);
    const path = '/rooms/foyer/data/exits/1/direction';
    expect(ts.map((d) => d.path)).toContain(path);
    expect(native.diagnostics.map((d) => d.path)).toContain(path);
  });

  it('agrees with TypeScript on cast selector fallback and invalid presentation references', () => {
    const project = fixture();
    project.characters.guard = {
      id: 'guard',
      label: 'Guard',
      data: defaultCharacterData('Guard'),
    };
    const room = project.rooms.foyer!.data;
    room.placements.push({
      id: 'doorway',
      bounds: { x: 0, y: 0, width: 0.5, height: 0.5 },
      presentation: { label: null, layout: null },
    });
    room.cast.push({
      id: 'guard',
      character: { $ref: { collection: 'characters', id: 'guard' } },
      condition: { kind: 'always' },
      placementId: 'doorway',
      profileId: null,
      poseId: null,
      expressionId: 'neutral',
      appearanceId: null,
      idleId: null,
      visible: true,
      order: 1,
    });
    const baseline = call('--project', JSON.stringify(project));
    expect(baseline.valid, JSON.stringify(baseline.diagnostics)).toBe(true);
    expect(
      validateRoomData(project, 'foyer', project.rooms.foyer!).filter(
        (d) => d.severity === 'error',
      ),
    ).toEqual([]);
    for (const selector of [
      'profileId',
      'poseId',
      'expressionId',
      'appearanceId',
      'idleId',
    ] as const) {
      room.cast[0]![selector] = 'not-in-character';
      const target = `/rooms/foyer/data/cast/0/${selector}`;
      const ts = validateRoomData(project, 'foyer', project.rooms.foyer!);
      const native = call('--project', JSON.stringify(project));
      expect(
        ts.map((d) => d.path),
        selector,
      ).toContain(target);
      expect(
        native.diagnostics.map((d) => d.path),
        selector,
      ).toContain(target);
      expect(native.valid, selector).toBe(false);
      room.cast[0]![selector] = null;
    }
    // The default profile's default pose is used only if not explicitly overridden.
    room.cast[0]!.poseId = 'default';
    expect(call('--project', JSON.stringify(project)).valid).toBe(true);
  });

  it('matches missing environment Animation motions without rejecting null selection', () => {
    const project = fixture();
    project.materials.world = {
      id: 'world',
      label: 'World',
      data: defaultMaterialData('World', 'engine-2d'),
    };
    project.animations.loop = {
      id: 'loop',
      label: 'Loop',
      data: {
        kind: 'animation',
        canvas: { width: 100, height: 100 },
        defaultMotionId: 'idle',
        motions: [{ id: 'idle', kind: 'sprite-sequence', frames: [], markers: [] }],
      },
    };
    project.rooms.foyer!.data.environments.push({
      id: 'rain',
      condition: { kind: 'always' },
      visual: {
        kind: 'animation',
        animation: { $ref: { collection: 'animations', id: 'loop' } },
        motionId: null,
        playback: null,
      },
      materialApplication: emptyMaterialApplication('world'),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      plane: 'world-background',
      order: 0,
      clock: 'gameplay',
      scrollPerSecond: { x: 0, y: 0 },
      opacity: 1,
      visible: true,
    });
    expect(call('--project', JSON.stringify(project)).valid).toBe(true);
    project.rooms.foyer!.data.environments[0]!.visual = {
      kind: 'animation',
      animation: { $ref: { collection: 'animations', id: 'loop' } },
      motionId: 'unknown-motion',
      playback: null,
    };
    const path = '/rooms/foyer/data/environments/0/visual/motionId';
    expect(validateRoomData(project, 'foyer', project.rooms.foyer!).map((d) => d.path)).toContain(
      path,
    );
    const native = call('--project', JSON.stringify(project));
    expect(native.valid).toBe(false);
    expect(native.diagnostics.map((d) => d.path)).toContain(path);
  });

  it('matches Variable comparison types across Room lifecycle and Map visibility Conditions', () => {
    const project = fixture();
    const values = [
      { type: 'boolean', value: 'true', validValue: true },
      { type: 'integer', value: 3.5, validValue: 3 },
      { type: 'number', value: '3', validValue: 3 },
      { type: 'string', value: false, validValue: 'text' },
      { type: 'enum', value: 'forbidden', validValue: 'default' },
      { type: 'message', value: 'text', validValue: null },
    ] as const;
    for (const { type, value, validValue } of values) {
      project.variables.choice = {
        id: 'choice',
        label: 'Choice',
        data: defaultVariableData(type),
      };
      const invalid = {
        kind: 'variable-comparison' as const,
        variable: { $ref: { collection: 'variables' as const, id: 'choice' } },
        operator: 'equal' as const,
        value,
      };
      project.rooms.foyer!.data.lifecycle.canEnter = invalid;
      project.maps.world!.data.locations[0]!.visibility = invalid;
      const roomPath = '/rooms/foyer/data/lifecycle/canEnter/value';
      const mapPath = '/maps/world/data/locations/0/visibility/value';
      expect(
        validateRoomData(project, 'foyer', project.rooms.foyer!).map((d) => d.path),
        type,
      ).toContain(roomPath);
      expect(
        validateMapData(project, 'world', project.maps.world!).map((d) => d.path),
        type,
      ).toContain(mapPath);
      const native = call('--project', JSON.stringify(project));
      expect(native.valid, type).toBe(false);
      for (const path of [roomPath, mapPath])
        expect(native.diagnostics, type).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path,
              code: 'authoring.condition.variable-type-mismatch',
            }),
          ]),
        );
      project.rooms.foyer!.data.lifecycle.canEnter = { ...invalid, value: validValue };
      project.maps.world!.data.locations[0]!.visibility = {
        ...invalid,
        value: validValue,
      };
      expect(
        call('--project', JSON.stringify(project)).diagnostics.filter(
          (d) => d.code === 'authoring.condition.variable-type-mismatch',
        ),
        type,
      ).toEqual([]);
    }
    project.variables.choice!.data = { ...defaultVariableData('boolean'), nullable: true };
    project.rooms.foyer!.data.lifecycle.canEnter = {
      kind: 'variable-comparison',
      variable: { $ref: { collection: 'variables', id: 'choice' } },
      operator: 'equal',
      value: null,
    };
    expect(
      call('--project', JSON.stringify(project)).diagnostics.filter(
        (d) => d.path === '/rooms/foyer/data/lifecycle/canEnter/value',
      ),
    ).toEqual([]);
    project.variables.choice!.data.nullable = false;
    const nonnullable = call('--project', JSON.stringify(project));
    expect(nonnullable.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/rooms/foyer/data/lifecycle/canEnter/value',
          code: 'authoring.condition.variable-type-mismatch',
        }),
      ]),
    );
  }, 30_000);

  it('uses ECMAScript whitespace trimming for enum comparisons in Rooms and Maps', () => {
    const project = fixture();
    const padded = '\u00a0\u2003\u2028\ufeffdefault\u2029\u202f\u1680\u3000';
    project.variables.choice = {
      id: 'choice',
      label: 'Choice',
      data: { ...defaultVariableData('enum'), enumValues: [padded] },
    };
    const condition = {
      kind: 'variable-comparison' as const,
      variable: { $ref: { collection: 'variables' as const, id: 'choice' } },
      operator: 'equal' as const,
      value: 'default',
    };
    project.rooms.foyer!.data.lifecycle.canEnter = condition;
    project.maps.world!.data.locations[0]!.visibility = condition;

    expect(padded.trim()).toBe('default');
    expect(validateVariableData(project, 'choice', project.variables.choice!)).toEqual([]);
    expect(
      validateRoomData(project, 'foyer', project.rooms.foyer!).filter(
        (d) => d.severity === 'error',
      ),
    ).toEqual([]);
    expect(
      validateMapData(project, 'world', project.maps.world!).filter((d) => d.severity === 'error'),
    ).toEqual([]);
    const native = call('--project', JSON.stringify(project));
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(true);

    // Trimming removes only boundary whitespace, not whitespace inside Enum values.
    project.variables.choice!.data.enumValues = ['def\u00a0ault'];
    project.variables.choice!.data.value = 'def\u00a0ault';
    expect(validateVariableData(project, 'choice', project.variables.choice!)).toEqual([]);
    const roomPath = '/rooms/foyer/data/lifecycle/canEnter/value';
    const mapPath = '/maps/world/data/locations/0/visibility/value';
    expect(validateRoomData(project, 'foyer', project.rooms.foyer!).map((d) => d.path)).toContain(
      roomPath,
    );
    expect(validateMapData(project, 'world', project.maps.world!).map((d) => d.path)).toContain(
      mapPath,
    );
    const invalidNative = call('--project', JSON.stringify(project));
    expect(invalidNative.valid).toBe(false);
    expect(invalidNative.diagnostics.map((d) => d.path)).toEqual(
      expect.arrayContaining([roomPath, mapPath]),
    );
  });

  it('matches Room and Interactable Hotspot target, image, and informational diagnostics', () => {
    const project = fixture();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/image.png' },
        aliases: [],
        imageMetadata: {
          width: 640,
          height: 480,
          orientation: 1,
          hasAlpha: false,
        },
      },
    };
    const room = project.rooms.foyer!.data;
    room.background.asset = { $ref: { collection: 'assets', id: 'image' } };
    room.hotspots.push({
      id: 'exit-hotspot',
      label: 'Exit',
      condition: { kind: 'always' },
      inputOrder: 0,
      highlight: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 0.2, height: 0.2 } },
      target: { kind: 'exit', exitId: 'unknown' },
    });
    const interactable = defaultInteractableData('Coin');
    interactable.presentation.visual = {
      kind: 'image',
      image: { $ref: { collection: 'assets', id: 'image' } },
    };
    interactable.presentation.hotspots = {
      kind: 'visual-alpha',
      hotspot: {
        ...defaultHotspotBehavior('Coin'),
        target: { kind: 'owner-feature', featureId: 'unknown' },
      },
    };
    project.interactables.coin = { id: 'coin', label: 'Coin', data: interactable };
    const ts = [
      ...validateRoomHotspotAuthoringSemantics(project, 'foyer'),
      ...validateInteractableRecordHotspotAuthoringSemantics(project, 'coin'),
    ];
    const native = call('--project', JSON.stringify(project));
    for (const code of [
      'hotspot.authoring.exit.foreign',
      'hotspot.authoring.target.feature-missing',
      'hotspot.authoring.alpha.opaque-image',
    ]) {
      expect(ts.map((d) => d.code)).toContain(code);
      expect(native.diagnostics.map((d) => d.code)).toContain(code);
    }
    expect(
      native.diagnostics.find((d) => d.code === 'hotspot.authoring.alpha.opaque-image')?.severity,
    ).toBe('warning');
    expect(native.valid).toBe(false);
  });

  it('compares resolved Material preset roles and hotspot sampler interfaces', () => {
    const project = fixture();
    project.assets.image = {
      id: 'image',
      label: 'Image',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/image.png' },
        aliases: [],
        imageMetadata: { width: 640, height: 480, hasAlpha: true, orientation: 1 },
      },
    };
    project.rooms.foyer!.data.background.asset = {
      $ref: { collection: 'assets', id: 'image' },
    };
    project.rooms.foyer!.data.hotspots.push({
      ...defaultHotspotBehavior('Focus'),
      id: 'focus',
      target: { kind: 'none' },
      shape: { kind: 'rect', bounds: { x: 0, y: 0, width: 1, height: 1 } },
      highlight: { kind: 'material', materialApplication: emptyMaterialApplication('hotspot') },
    });
    project.materials.hotspot = {
      id: 'hotspot',
      label: 'Hotspot',
      data: defaultMaterialData('Hotspot', 'hotspot-overlay-custom'),
    };
    const validNative = call('--project', JSON.stringify(project));
    expect(validNative.diagnostics.map((d) => d.code)).not.toContain(
      'hotspot.authoring.highlight.sampler-interface',
    );
    expect(
      validateRoomHotspotAuthoringSemantics(project, 'foyer').map((d) => d.code),
    ).not.toContain('hotspot.authoring.highlight.sampler-interface');
    project.materials.hotspot!.data = defaultMaterialData('Hotspot', 'hotspot-overlay-alpha');
    const invalidNative = call('--project', JSON.stringify(project));
    expect(invalidNative.diagnostics.map((d) => d.code)).toContain(
      'hotspot.authoring.highlight.sampler-interface',
    );
    expect(validateRoomHotspotAuthoringSemantics(project, 'foyer').map((d) => d.code)).toContain(
      'hotspot.authoring.highlight.sampler-interface',
    );
    project.materials.hotspot!.data = defaultMaterialData('Hotspot', 'engine-2d');
    expect(call('--project', JSON.stringify(project)).diagnostics.map((d) => d.code)).toContain(
      'hotspot.authoring.highlight.material-role',
    );
  });

  it('persists ID-keyed nested Map edits while retaining YAML comments and compiled inputs', () => {
    const project = fixture();
    const original = '# World map notes\n' + encodeSparseRecordYaml('maps', project.maps.world);
    const result = spawnSync(executable!, ['--map-roundtrip'], {
      input: original,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const changed = JSON.parse(result.stdout) as {
      savedSource: string;
      nativeNormalized: unknown;
      affectedRecords: string[];
    };
    expect(changed.affectedRecords).toEqual(['maps/world']);
    expect(changed.savedSource).toContain('# World map notes');
    const normalized = mapRecordSchema.parse(decodeSparseRecordYaml('maps', changed.savedSource));
    expect(changed.nativeNormalized).toEqual(normalized);
    expect(normalized.label).toBe('New Map');
    expect(normalized.data.locations[0]!.pickOrder).toBe(7);
    expect(normalized.data.locations[0]!.room.$ref.id).toBe('foyer');
    expect(normalized.data.connections).toEqual(project.maps.world!.data.connections);
    const reopenedProject = structuredClone(project);
    reopenedProject.maps.world = normalized;
    const beforeCompiled = compileAuthoringProject(project);
    const afterCompiled = compileAuthoringProject(reopenedProject);
    expect(beforeCompiled.ok, JSON.stringify(beforeCompiled.diagnostics)).toBe(true);
    expect(afterCompiled.ok, JSON.stringify(afterCompiled.diagnostics)).toBe(true);
    if (beforeCompiled.ok && afterCompiled.ok) {
      expect(afterCompiled.project.definitions.maps[0]!.connections).toEqual(
        beforeCompiled.project.definitions.maps[0]!.connections,
      );
      expect(afterCompiled.project.definitions.rooms).toEqual(
        beforeCompiled.project.definitions.rooms,
      );
      expect(afterCompiled.project.definitions.maps[0]!.locations[0]!.pickOrder).toBe(7);
    }
  });
});
