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
