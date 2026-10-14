import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';

describe('staged sparse Dialogue and Scene YAML', () => {
  it('round-trips every Feature Lab authored record without changing event order or semantics', () => {
    for (const family of ['dialogues', 'scenes'] as const) {
      const directory = resolve(process.cwd(), `../tests/projects/feature-lab/records/${family}`);
      const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const record = authoringRecordSchemas[family].parse(
          JSON.parse(readFileSync(resolve(directory, name), 'utf8')),
        );
        const codec = projectWorkspaceSourceCodec(`records/${family}/${name.slice(0, -5)}.yaml`);
        const text = codec.encode(record);
        expect(codec.decode(text), name).toEqual(record);
        expect(text, name).not.toMatch(/^  kind: (dialogue|scene)$/mu);
      }
    }
  }, 20_000);

  it('preserves nested source notes and explicit nondefault choices when saving', () => {
    for (const [family, data] of [
      ['dialogues', defaultDialogueData()],
      ['scenes', defaultSceneData()],
    ] as const) {
      const codec = projectWorkspaceSourceCodec(`records/${family}/example.yaml`);
      const record = { id: 'example', label: 'Example', data };
      const initial = codec.encode(record);
      const commented = initial.replace(/(    - id: )/u, '    # Nested authored note\n$1');
      const updated = codec.encode(record, undefined, commented);
      expect(codec.decode(updated)).toEqual(record);
      if (commented !== initial) expect(updated).toContain('# Nested authored note');
    }
  });

  it('opens, writes and reopens staged YAML owners with nested notes', async () => {
    const project = createAuthoringProject({ id: 'dialogue-scene-yaml', name: 'YAML' });
    project.dialogues.conversation = {
      id: 'conversation',
      label: 'Conversation',
      data: defaultDialogueData(),
    };
    project.scenes.intro = { id: 'intro', label: 'Intro', data: defaultSceneData() };
    const dialoguePath = 'records/dialogues/conversation.yaml';
    const scenePath = 'records/scenes/intro.yaml';
    const files = projectWorkspaceFiles(
      project,
      project.editor,
      {},
      new Set([dialoguePath, scenePath]),
    );
    const root = '/dialogue-scene';
    const physical = Object.fromEntries(
      Object.entries(files).map(([path, value]) => [`${root}/${path}`, value]),
    );
    physical[`${root}/${dialoguePath}`] = physical[`${root}/${dialoguePath}`]!.replace(
      /^([ \t]*)- id: line-1/mu,
      '$1# Dialogue segment note\n$1- id: line-1',
    );
    physical[`${root}/${scenePath}`] = physical[`${root}/${scenePath}`]!.replace(
      /^([ \t]*)- id:/mu,
      '$1# Scene event note\n$1- id:',
    );
    expect(
      projectWorkspaceSourceCodec(dialoguePath).decode(physical[`${root}/${dialoguePath}`]!),
    ).toEqual(project.dialogues.conversation);
    const fs = new InMemoryProjectWorkspaceFileSystem(physical);
    const service = new ProjectWorkspaceService(fs);
    const opened = await service.open(root);
    expect(opened.ok ? '' : JSON.stringify(opened.diagnostics)).toBe('');
    if (!opened.ok) return;
    const edited = cloneAuthoringProject(opened.snapshot.project);
    edited.dialogues.conversation!.data.displayName = 'Updated dialogue';
    edited.scenes.intro!.data.displayName = 'Updated scene';
    await service.write(
      root,
      opened.snapshot.workspaceRevision,
      edited,
      edited.editor,
      {},
      {
        affectedPaths: [
          '/dialogues/conversation/data/displayName',
          '/scenes/intro/data/displayName',
        ],
      },
    );
    expect(await fs.readText(`${root}/${dialoguePath}`)).toContain('# Dialogue segment note');
    expect(await fs.readText(`${root}/${scenePath}`)).toContain('# Scene event note');
    const reopened = await service.open(root);
    expect(reopened.ok).toBe(true);
    if (reopened.ok) {
      expect(reopened.snapshot.project.dialogues.conversation!.data.displayName).toBe(
        'Updated dialogue',
      );
      expect(reopened.snapshot.project.scenes.intro!.data.displayName).toBe('Updated scene');
    }
  });
});
