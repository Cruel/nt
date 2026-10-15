import { describe, expect, it } from 'vite-plus/test';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultRoomData, roomRoomRef } from '../../shared/project-schema/authoring-rooms';
import { defaultMapData } from '../../shared/project-schema/authoring-maps';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import {
  featureLabYamlFiles,
  featureLabYamlRecord,
  featureLabYamlSource,
} from './feature-lab-yaml-fixtures';

const root = '/project';

function fixture() {
  const project = createAuthoringProject({ id: 'source', name: 'Source' });
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.rooms.hall = { id: 'hall', label: 'Hall', data: defaultRoomData('Hall') };
  project.rooms.foyer.data.exits.push({
    id: 'north',
    label: 'North',
    direction: 'north',
    target: roomRoomRef('hall'),
    condition: { kind: 'always' },
    onRejected: [],
  });
  project.maps.world = { id: 'world', label: 'World', data: defaultMapData() };
  project.maps.world.data.locations.push({
    id: 'foyer-location',
    room: roomRoomRef('foyer'),
    regions: [],
    label: null,
    icon: null,
    style: null,
    labelAnchor: null,
    connectionAnchor: null,
    visibility: { kind: 'always' },
    pickOrder: 0,
    logicalOrder: 0,
  });
  project.maps.world.data.connections.push({
    id: 'north-route',
    exits: [{ room: 'foyer', exit: 'north' }],
    label: null,
    icon: null,
    style: null,
    visibility: { kind: 'always' },
    logicalOrder: 0,
    path: [],
    hitRegions: [],
  });
  return project;
}

function yamlFiles(project: ReturnType<typeof fixture>) {
  // #453 is the family-level source cutover; #467 changes the project-wide
  // default and removes JSON. A staged YAML owner selects YAML for its family.
  return projectWorkspaceFiles(
    project,
    project.editor,
    {},
    new Set(['records/rooms/foyer.yaml', 'records/maps/world.yaml']),
  );
}

describe('Room and Map restricted sparse YAML workspace', () => {
  it('preserves a real Feature Lab note through editor saves and reopens', async () => {
    const roomPath = 'records/rooms/rooms-interactions-workshop.yaml';
    const source = featureLabYamlSource('rooms', 'rooms-interactions-workshop.yaml');
    const codec = projectWorkspaceSourceCodec(roomPath);
    const record = authoringRecordSchemas.rooms.parse(codec.decode(source));
    const note =
      '# The catalog launches this Room by ID; its display label may change independently.';
    expect(source).toContain(note);
    const project = createAuthoringProject({ id: 'feature-lab-notes', name: 'Notes' });
    project.rooms[record.id] = record;
    const files = {
      ...projectWorkspaceFiles(project, project.editor, {}, new Set([roomPath])),
      [roomPath]: source,
    };
    const root = '/feature-lab-notes';
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text])),
    );
    const service = new ProjectWorkspaceService(fs);
    const opened = await service.open(root);
    expect(opened.ok ? '' : JSON.stringify(opened.diagnostics)).toBe('');
    if (!opened.ok) return;

    const relabeled = cloneAuthoringProject(opened.snapshot.project);
    relabeled.rooms[record.id]!.label = 'Workshop (edited)';
    await service.write(
      root,
      opened.snapshot.workspaceRevision,
      relabeled,
      relabeled.editor,
      {},
      { affectedPaths: [`/rooms/${record.id}/label`] },
    );
    const changed = await fs.readText(`${root}/${roomPath}`);
    expect(changed).toContain(note);
    expect(codec.decode(changed)).toEqual(relabeled.rooms[record.id]);

    const reopened = await service.open(root);
    expect(reopened.ok ? '' : JSON.stringify(reopened.diagnostics)).toBe('');
    if (!reopened.ok) return;
    const editedDescription = cloneAuthoringProject(reopened.snapshot.project);
    editedDescription.rooms[record.id]!.data.description.source = {
      kind: 'inline',
      text: 'Updated introduction',
    };
    await service.write(
      root,
      reopened.snapshot.workspaceRevision,
      editedDescription,
      editedDescription.editor,
      {},
      { affectedPaths: [`/rooms/${record.id}/data/description/source/text`] },
    );
    const unchanged = await fs.readText(`${root}/${roomPath}`);
    expect(unchanged).toContain(note);
    expect(codec.decode(unchanged)).toEqual(editedDescription.rooms[record.id]);

    const finalOpen = await service.open(root);
    expect(finalOpen.ok ? '' : JSON.stringify(finalOpen.diagnostics)).toBe('');
    if (finalOpen.ok)
      expect(finalOpen.snapshot.project.rooms[record.id]).toEqual(
        editedDescription.rooms[record.id],
      );
  }, 30_000);

  it('preserves all existing Feature Lab Room semantics when projected into canonical YAML', () => {
    const names = featureLabYamlFiles('rooms');
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const original = featureLabYamlRecord('rooms', name);
      const normalized = authoringRecordSchemas.rooms.parse(original);
      const codec = projectWorkspaceSourceCodec(`records/rooms/${name.slice(0, -5)}.yaml`);
      const source = codec.encode(normalized);
      expect(codec.decode(source), name).toEqual(normalized);
      expect(source, name).not.toMatch(/^  kind: room$/mu);
    }
  });

  it('emits short Room and Map source with exact strict normalized round-trips', () => {
    const project = fixture();
    const files = { ...yamlFiles(project) };
    expect(files['records/rooms/foyer.json']).toBeUndefined();
    expect(files['records/maps/world.json']).toBeUndefined();
    const roomText = files['records/rooms/foyer.yaml']!;
    const mapText = files['records/maps/world.yaml']!;
    expect(roomText).not.toContain('kind: room');
    expect(roomText).not.toContain('lifecycle:');
    expect(roomText).not.toContain('background:');
    expect(roomText).toContain('target: hall');
    expect(mapText).toContain('room: foyer');
    expect(mapText).not.toContain('kind: map');
    expect(mapText).not.toContain('visibility:');
    expect(mapText).not.toContain('$ref:');
    expect(projectWorkspaceSourceCodec('records/rooms/foyer.yaml').decode(roomText)).toEqual(
      project.rooms.foyer,
    );
    expect(projectWorkspaceSourceCodec('records/maps/world.yaml').decode(mapText)).toEqual(
      project.maps.world,
    );
  });

  it('opens, edits, transactionally saves, and reopens commented Rooms and Maps', async () => {
    const project = fixture();
    const files = { ...yamlFiles(project) };
    files['records/rooms/foyer.yaml'] = files['records/rooms/foyer.yaml']!.replace(
      'label: Foyer',
      'label: Foyer # record annotation',
    ).replace('displayName: Foyer', 'displayName: Foyer # descriptive name');
    files['records/maps/world.yaml'] = files['records/maps/world.yaml']!.replace(
      'label: World',
      'label: World # map annotation',
    );
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(files).map(([path, text]) => [`${root}/${path}`, text])),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.rooms.foyer!.data.displayName = 'Foyer updated';
    next.maps.world!.data.presentation.initialMode = 'minimap';
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: [
          '/rooms/foyer/data/displayName',
          '/maps/world/data/presentation/initialMode',
        ],
      },
    );
    const savedRoom = await fs.readText(`${root}/records/rooms/foyer.yaml`);
    const savedMap = await fs.readText(`${root}/records/maps/world.yaml`);
    expect(savedRoom).toContain('displayName: Foyer updated # descriptive name');
    expect(savedRoom).toContain('# record annotation');
    expect(savedMap).toContain('# map annotation');
    expect(savedMap).toContain('initialMode: minimap');
    const reopened = await workspace.open(root);
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!reopened.ok) return;
    expect(reopened.snapshot.project.rooms.foyer!.data.displayName).toBe('Foyer updated');
    expect(reopened.snapshot.project.maps.world!.data.presentation.initialMode).toBe('minimap');
  });

  it('fills nested lifecycle defaults but preserves non-default choices and explicit defaults', () => {
    const codec = projectWorkspaceSourceCodec('records/rooms/sample.yaml');
    const record = { id: 'sample', label: 'Sample', data: defaultRoomData('Sample') };
    record.data.lifecycle.canEnter = { kind: 'always' };
    record.data.background.fit = 'contain';
    const source = codec.encode(record);
    const custom = source.replace('fit: contain', 'fit: contain');
    expect(custom).toContain('fit: contain');
    const restored = codec.decode(custom) as typeof record;
    expect(restored).toEqual(record);
    const explicit = custom.replace('fit: contain', 'fit: contain\n    asset: null');
    const updated = structuredClone(record);
    updated.data.displayName = 'New name';
    const saved = codec.encode(updated, undefined, explicit);
    expect(saved).toContain('asset: null');
    expect(codec.decode(saved)).toEqual(updated);
  });

  it('rejects old typed ref wrappers and both duplicate and lone JSON physical owners', async () => {
    const project = fixture();
    const files = yamlFiles(project);
    const mapPath = 'records/maps/world.yaml';
    const malformed = files[mapPath]!.replace(
      'room: foyer',
      'room:\n        $ref:\n          collection: rooms\n          id: foyer',
    );
    expect(() => projectWorkspaceSourceCodec(mapPath).decode(malformed)).toThrow();
    const legacy = { ...files };
    legacy['records/rooms/foyer.json'] = JSON.stringify(project.rooms.foyer);
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(legacy).map(([file, text]) => [`${root}/${file}`, text])),
    );
    expect((await new ProjectWorkspaceService(fs).open(root)).ok).toBe(false);
    // Retired JSON is never accepted, even when no matching YAML owner exists.
    delete legacy['records/rooms/foyer.yaml'];
    const obsolete = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(Object.entries(legacy).map(([file, text]) => [`${root}/${file}`, text])),
    );
    expect((await new ProjectWorkspaceService(obsolete).open(root)).ok).toBe(false);
  });
});
