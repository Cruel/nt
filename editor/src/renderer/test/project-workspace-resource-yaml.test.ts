import { describe, expect, it } from 'vite-plus/test';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';
import { featureLabYamlFiles, featureLabYamlRecord } from './feature-lab-yaml-fixtures';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';

describe('Asset, Animation and Material YAML source profiles', () => {
  it('round-trips resource records without dropping provenance, hashes or settings', () => {
    for (const family of ['assets', 'animations', 'materials'] as const) {
      const names = featureLabYamlFiles(family);
      expect(names.length, family).toBeGreaterThan(0);
      for (const name of names) {
        const record = authoringRecordSchemas[family].parse(featureLabYamlRecord(family, name));
        const codec = projectWorkspaceSourceCodec(`records/${family}/${name.slice(0, -5)}.yaml`);
        const source = codec.encode(record);
        expect(codec.decode(source), `${family}/${name}`).toEqual(record);
        if (family === 'assets') expect(source).toMatch(/\n  kind: /u);
        else expect(source).not.toMatch(/\n  kind: (?:animation|material)\n/u);
        expect(codec.encode(codec.decode(source), undefined, source)).toBe(source);
      }
    }
  });

  it('keeps comments and explicit metadata while updating other resource fields', () => {
    const family = 'assets';
    const name = featureLabYamlFiles('assets')[0]!;
    const record = authoringRecordSchemas.assets.parse(featureLabYamlRecord('assets', name));
    const codec = projectWorkspaceSourceCodec(`records/${family}/${name.slice(0, -5)}.yaml`);
    const source = codec.encode(record).replace('label:', '# author note\nlabel:');
    const updated = { ...record, label: `${record.label} updated` };
    const next = codec.encode(updated, undefined, source);
    expect(next).toContain('# author note');
    expect(codec.decode(next)).toEqual(updated);
  });

  it('opens, edits and reopens YAML Asset metadata through the workspace service', async () => {
    const name = featureLabYamlFiles('assets')[0]!;
    const asset = authoringRecordSchemas.assets.parse(featureLabYamlRecord('assets', name));
    const project = createAuthoringProject({ id: 'resources', name: 'Resources' });
    project.assets[asset.id] = asset;
    project.animations.idle = {
      id: 'idle',
      label: 'Idle',
      data: {
        kind: 'animation',
        canvas: { width: 64, height: 64 },
        defaultMotionId: 'still',
        motions: [{ id: 'still', kind: 'sprite-sequence', frames: [], markers: [] }],
      },
    };
    project.materials.flat = { id: 'flat', label: 'Flat', data: defaultMaterialData('Flat') };
    const path = `records/assets/${asset.id}.yaml`;
    const animationPath = 'records/animations/idle.yaml';
    const materialPath = 'records/materials/flat.yaml';
    const projected = projectWorkspaceFiles(
      project,
      project.editor,
      {},
      new Set([path, animationPath, materialPath]),
    );
    const original = projected[path]!.replace('label:', '# ownership note\nlabel:');
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries({ ...projected, [path]: original }).map(([file, value]) => [
          `/resources/${file}`,
          value,
        ]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open('/resources');
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    const updated = cloneAuthoringProject(opened.snapshot.project);
    updated.assets[asset.id]!.label = 'Updated resource';
    updated.animations.idle!.label = 'Updated animation';
    updated.materials.flat!.label = 'Updated material';
    try {
      await workspace.write(
        '/resources',
        opened.snapshot.workspaceRevision,
        updated,
        opened.editorState,
        {},
        {
          affectedPaths: [
            `/assets/${asset.id}/label`,
            '/animations/idle/label',
            '/materials/flat/label',
          ],
        },
      );
    } catch (error) {
      const failed = await workspace.open('/resources');
      throw new Error(
        `${String(error)}: ${failed.ok ? 'opened' : JSON.stringify(failed.diagnostics)}`,
      );
    }
    const saved = await fs.readText(`/resources/${path}`);
    expect(saved).toContain('# ownership note');
    expect(saved).toContain('label: Updated resource');
    expect(await fs.readText(`/resources/${animationPath}`)).toContain('label: Updated animation');
    expect(await fs.readText(`/resources/${materialPath}`)).toContain('label: Updated material');
    expect(await fs.inspect(`/resources/records/assets/${asset.id}.json`)).toBe('missing');
    expect(await fs.inspect('/resources/records/animations/idle.json')).toBe('missing');
    expect(await fs.inspect('/resources/records/materials/flat.json')).toBe('missing');
    const reopened = await workspace.open('/resources');
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok) {
      expect(reopened.snapshot.project.assets[asset.id]!.label).toBe('Updated resource');
      expect(reopened.snapshot.project.animations.idle!.label).toBe('Updated animation');
      expect(reopened.snapshot.project.materials.flat!.label).toBe('Updated material');
    }
  });
});
