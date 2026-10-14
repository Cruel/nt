import { describe, expect, it } from 'vite-plus/test';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultInteractableData } from '../../shared/project-schema/authoring-interactables';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { featureLabYamlFiles, featureLabYamlRecord } from './feature-lab-yaml-fixtures';

const root = '/project';
const characterPath = 'records/characters/guide.yaml';
const interactablePath = 'records/interactables/key.yaml';

function sample() {
  const project = createAuthoringProject({ id: 'sparse-project', name: 'Sparse' });
  project.characters.guide = {
    id: 'guide',
    label: 'Guide',
    localProperties: [{ id: 'mood', type: 'string', nullable: false, value: 'yes' }],
    data: defaultCharacterData('Guide'),
  };
  project.characters.guide.data.profiles[0]!.poses.push({
    id: 'wave',
    label: 'Wave',
    layers: [
      {
        layerId: 'body',
        visual: null,
        materialApplication: null,
        offset: { x: 0, y: 0 },
        scale: 1,
        anchor: { x: 0.5, y: 1 },
        visible: true,
      },
    ],
  });
  project.characters.guide.data.appearances.push({
    id: 'raincoat',
    label: 'Raincoat',
    profiles: [{ profileId: 'stage', layers: [] }],
  });
  project.interactables.key = {
    id: 'key',
    label: 'Key',
    traits: ['rare'],
    defaultProperties: [{ id: 'durability', type: 'integer', nullable: false, defaultValue: 5 }],
    data: defaultInteractableData('Key'),
  };
  project.interactables.key.data.features.push({
    id: 'teeth',
    label: 'Teeth',
    traits: [],
    localProperties: [],
    defaultProperties: [{ id: 'sharp', type: 'boolean', nullable: false, defaultValue: true }],
    inventories: [],
  });
  return project;
}

function stagedSources(project = sample()) {
  const projected = projectWorkspaceFiles(
    project,
    project.editor,
    {},
    new Set([characterPath, interactablePath]),
  );
  return Object.fromEntries(
    Object.entries(projected).map(([file, text]) => [`${root}/${file}`, text]),
  );
}

describe('staged sparse Character and Interactable YAML', () => {
  it('round-trips existing Feature Lab Characters and Interactables through the admitted schemas', () => {
    for (const collection of ['characters', 'interactables'] as const) {
      const names = featureLabYamlFiles(collection);
      expect(names.length).toBeGreaterThan(4);
      for (const name of names) {
        const original = featureLabYamlRecord(collection, name);
        const normalized = authoringRecordSchemas[collection].parse(original);
        const codec = projectWorkspaceSourceCodec(
          `records/${collection}/${name.slice(0, -5)}.yaml`,
        );
        const source = codec.encode(normalized);
        expect(source, name).not.toMatch(/^  kind: (character|interactable)$/mu);
        expect(codec.decode(source), name).toEqual(normalized);
      }
    }
  });

  it('omits only semantic defaults while preserving identities and local/default Property ownership', () => {
    const project = sample();
    const sources = stagedSources(project);
    const character = sources[`${root}/${characterPath}`]!;
    const interactable = sources[`${root}/${interactablePath}`]!;
    expect(character).toContain('id: wave');
    expect(character).toContain('id: raincoat');
    expect(character).toContain('layerId: body');
    expect(character).not.toContain('offset:');
    expect(character).not.toContain('scale: 1');
    expect(character).toMatch(/value: ["']yes["']/u);
    expect(character).toContain('localProperties:');
    expect(character).not.toContain('defaultProperties:');
    expect(interactable).toContain('stackable: false');
    expect(interactable).toContain('stackLimit: null');
    expect(interactable).toContain('defaultProperties:');
    expect(interactable).not.toContain('localProperties: []');
    expect(interactable).toContain('id: teeth');
    expect(projectWorkspaceSourceCodec(characterPath).decode(character)).toEqual(
      project.characters.guide,
    );
    expect(projectWorkspaceSourceCodec(interactablePath).decode(interactable)).toEqual(
      project.interactables.key,
    );
  });

  it('keeps polymorphic Feature ownership explicit while shortening only statically typed references', () => {
    const project = sample();
    project.characters.guide!.data.initialWorldState.location = {
      kind: 'room',
      room: { $ref: { collection: 'rooms', id: 'hall' } },
    };
    const hotspot = {
      id: 'feature-spot',
      label: 'Feature',
      condition: { kind: 'always' } as const,
      inputOrder: 0,
      highlight: { kind: 'default' } as const,
      shape: { kind: 'rect' as const, bounds: { x: 0, y: 0, width: 0.25, height: 0.25 } },
      target: {
        kind: 'subject' as const,
        subject: {
          kind: 'feature' as const,
          feature: {
            ownerKind: 'room' as const,
            room: { $ref: { collection: 'rooms' as const, id: 'hall' } },
            featureId: 'switch',
          },
        },
      },
    };
    project.interactables.key!.data.presentation.hotspots = { kind: 'custom', hotspots: [hotspot] };
    const sources = stagedSources(project);
    expect(sources[`${root}/${characterPath}`]).toMatch(/location:\n\s+kind: room\n\s+room: hall/u);
    expect(sources[`${root}/${interactablePath}`]).toMatch(/ownerKind: room\n\s+room: hall/u);
    expect(sources[`${root}/${interactablePath}`]).toContain('featureId: switch');
    expect(
      projectWorkspaceSourceCodec(characterPath).decode(sources[`${root}/${characterPath}`]!),
    ).toEqual(project.characters.guide);
    expect(
      projectWorkspaceSourceCodec(interactablePath).decode(sources[`${root}/${interactablePath}`]!),
    ).toEqual(project.interactables.key);
  });

  it('opens, saves new nested items sparsely, and retains annotations on existing array elements', async () => {
    const sources = stagedSources();
    sources[`${root}/${characterPath}`] = sources[`${root}/${characterPath}`]!.replace(
      'label: Guide',
      'label: Guide # character note',
    )
      .replace('displayName: Guide', 'displayName: Guide # name note')
      .replace('label: Wave', 'label: Wave # stable pose note');
    sources[`${root}/${interactablePath}`] = sources[`${root}/${interactablePath}`]!.replace(
      'label: Key',
      'label: Key # interactable note',
    ).replace('stackable: false', 'stackable: false # explicit rule');
    const fs = new InMemoryProjectWorkspaceFileSystem(sources);
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    const next = cloneAuthoringProject(opened.snapshot.project);
    next.characters.guide!.data.displayName = 'Updated Guide';
    next.interactables.key!.data.displayName = 'Updated Key';
    next.characters.guide!.data.profiles[0]!.poses.push({
      id: 'nod',
      label: 'Nod',
      layers: structuredClone(next.characters.guide!.data.profiles[0]!.poses[0]!.layers),
    });
    next.interactables.key!.data.features.push({
      id: 'lock',
      label: 'Lock',
      traits: [],
      localProperties: [],
      defaultProperties: [],
      inventories: [],
    });
    await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      next,
      next.editor,
      {},
      {
        affectedPaths: [
          '/characters/guide/data/displayName',
          '/characters/guide/data/profiles',
          '/interactables/key/data/displayName',
          '/interactables/key/data/features',
        ],
      },
    );
    expect(await fs.readText(`${root}/${characterPath}`)).toContain(
      'displayName: Updated Guide # name note',
    );
    expect(await fs.readText(`${root}/${characterPath}`)).toContain('# character note');
    expect(await fs.readText(`${root}/${characterPath}`)).toContain(
      'label: Wave # stable pose note',
    );
    expect(await fs.readText(`${root}/${characterPath}`)).toContain('id: nod');
    expect(await fs.readText(`${root}/${interactablePath}`)).toContain('# interactable note');
    expect(await fs.readText(`${root}/${interactablePath}`)).toContain('id: lock');
    expect(await fs.readText(`${root}/${interactablePath}`)).toContain(
      'stackable: false # explicit rule',
    );
    const reopened = await workspace.open(root);
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok) {
      expect(reopened.snapshot.project.characters.guide!.data.displayName).toBe('Updated Guide');
      expect(reopened.snapshot.project.characters.guide!.data.profiles[0]!.poses.at(-1)?.id).toBe(
        'nod',
      );
      expect(reopened.snapshot.project.interactables.key!.data.displayName).toBe('Updated Key');
      expect(reopened.snapshot.project.interactables.key!.data.features.at(-1)?.id).toBe('lock');
    }
  });

  it('rejects wrong bare references, redundant kinds, and simultaneous JSON/YAML owners', async () => {
    const sources = stagedSources();
    const charSource = sources[`${root}/${characterPath}`]!;
    expect(() =>
      projectWorkspaceSourceCodec(characterPath).decode(
        charSource.replace('displayName: Guide', 'kind: character\n  displayName: Guide'),
      ),
    ).toThrow();
    const fs = new InMemoryProjectWorkspaceFileSystem({
      ...sources,
      [`${root}/records/characters/guide.json`]: JSON.stringify(sample().characters.guide),
    });
    expect((await new ProjectWorkspaceService(fs).open(root)).ok).toBe(false);
  });
});
