import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import {
  createAuthoringProject,
  cloneAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultTestData } from '../../shared/project-schema/authoring-tests';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';

const path = 'records/tests/example.yaml';
const codec = projectWorkspaceSourceCodec(path);

describe('sparse authored Test YAML', () => {
  it('round-trips Feature Lab semantic and UI Test inputs and expectations', () => {
    const directory = resolve(process.cwd(), '../tests/projects/feature-lab/records/tests');
    const files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(5);
    for (const name of files) {
      const record = authoringRecordSchemas.tests.parse(
        JSON.parse(readFileSync(resolve(directory, name), 'utf8')),
      );
      const source = codec.encode(record);
      expect(codec.decode(source), name).toEqual(record);
      expect(source, name).not.toMatch(/^  kind: test$/mu);
    }
  }, 30_000);

  it('preserves comments with reordered steps and expectation nodes over workspace writes', async () => {
    const project = createAuthoringProject({ id: 'test-yaml', name: 'YAML' });
    const data = defaultTestData('Test');
    data.steps.push({ ...structuredClone(data.steps[0]!), id: 'second', label: 'Second' });
    project.tests.example = { id: 'example', label: 'Example', data };
    const files = projectWorkspaceFiles(project, project.editor, {}, new Set([path]));
    const root = '/test-yaml';
    const physical = Object.fromEntries(
      Object.entries(files).map(([file, value]) => [`${root}/${file}`, value]),
    );
    physical[`${root}/${path}`] = physical[`${root}/${path}`]!.replace(
      /^(\s*)- id: second/mu,
      '$1# second step note\n$1- id: second',
    );
    const fs = new InMemoryProjectWorkspaceFileSystem(physical);
    const service = new ProjectWorkspaceService(fs);
    const opened = await service.open(root);
    expect(opened.ok ? '' : JSON.stringify(opened.diagnostics)).toBe('');
    if (!opened.ok) return;
    const updated = cloneAuthoringProject(opened.snapshot.project);
    updated.tests.example!.data.steps.reverse();
    updated.tests.example!.data.steps[0]!.label = 'Changed';
    await service.write(
      root,
      opened.snapshot.workspaceRevision,
      updated,
      updated.editor,
      {},
      { affectedPaths: ['/tests/example/data/steps'] },
    );
    const saved = await fs.readText(`${root}/${path}`);
    expect(saved).toContain('# second step note');
    expect(saved.indexOf('id: second')).toBeLessThan(saved.indexOf('id: start'));
    const reopened = await service.open(root);
    expect(reopened.ok).toBe(true);
    if (reopened.ok)
      expect(reopened.snapshot.project.tests.example!.data.steps.map((step) => step.id)).toEqual([
        'second',
        'start',
      ]);
  });
});
