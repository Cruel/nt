import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
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

const root = '/localization';

describe('tracked localization YAML ownership', () => {
  it('preserves Feature Lab messages, provenance, source tracking and every locale fragment', () => {
    const root = resolve(process.cwd(), '../tests/projects/feature-lab/i18n');
    for (const name of ['project', 'messages', 'usage-notes', 'tracking', 'orphans']) {
      const original = JSON.parse(readFileSync(resolve(root, `${name}.json`), 'utf8'));
      const codec = projectWorkspaceSourceCodec(`i18n/${name}.yaml`);
      const source = codec.encode(original);
      expect(codec.decode(source), name).toEqual(original);
      expect(codec.encode(codec.decode(source), undefined, source)).toBe(source);
    }
    for (const category of ['locales', 'assets']) {
      for (const filename of readdirSync(resolve(root, category)).filter((name) =>
        name.endsWith('.json'),
      )) {
        const original = JSON.parse(readFileSync(resolve(root, category, filename), 'utf8'));
        const codec = projectWorkspaceSourceCodec(
          `i18n/${category}/${filename.replace(/\.json$/u, '.yaml')}`,
        );
        expect(codec.decode(codec.encode(original)), `${category}/${filename}`).toEqual(original);
      }
    }
  });
  it('round-trips exact punctuation-heavy keys and ambiguous values', () => {
    const codec = projectWorkspaceSourceCodec('i18n/locales/es.yaml');
    const source = {
      'path/to.message:1': { text: 'yes' },
      '0123': { text: '0123' },
    };
    const yaml = codec.encode(source);
    expect(codec.decode(yaml)).toEqual(source);
    expect(yaml).toMatch(/["']0123["']/u);
  });

  it('creates new locale chunks as YAML when that locale family is already YAML', () => {
    const project = createAuthoringProject({ id: 'localized', name: 'Localized' });
    const translation = {
      text: 'Bonjour',
      sourceFingerprint: 'fnv1a:example',
      origin: 'human' as const,
      review: 'reviewed' as const,
    };
    const id = '25700000-0000-4000-8000-000000000001';
    project.localization.translations.fr = { [id]: translation };
    project.localization.translations['fr-CA'] = { [id]: { ...translation, text: 'Salut' } };
    const files = projectWorkspaceFiles(
      project,
      project.editor,
      {},
      new Set(['i18n/locales/fr.yaml']),
    );
    expect(files['i18n/locales/fr.yaml']).toBeDefined();
    expect(files['i18n/locales/fr-CA.yaml']).toBeDefined();
    expect(files['i18n/locales/fr-CA.json']).toBeUndefined();
  });

  it('opens YAML fragments, preserves their comments and saves only YAML owners', async () => {
    const project = createAuthoringProject({ id: 'localized', name: 'Localized' });
    const jsonFiles = projectWorkspaceFiles(project, project.editor);
    const yamlPaths = Object.keys(jsonFiles)
      .filter((path) => path.startsWith('i18n/'))
      .map((path) => path.replace(/\.json$/u, '.yaml'));
    const sources = Object.fromEntries(
      Object.entries(jsonFiles).map(([path, source]) => {
        if (!path.startsWith('i18n/')) return [path, source];
        const yamlPath = path.replace(/\.json$/u, '.yaml');
        const value = projectWorkspaceSourceCodec(path).decode(source);
        return [
          yamlPath,
          `# localization note\n${projectWorkspaceSourceCodec(yamlPath).encode(value)}`,
        ];
      }),
    );
    const fs = new InMemoryProjectWorkspaceFileSystem(
      Object.fromEntries(
        Object.entries(sources).map(([path, source]) => [`${root}/${path}`, source]),
      ),
    );
    const workspace = new ProjectWorkspaceService(fs);
    const opened = await workspace.open(root);
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    expect(opened.snapshot.project.localization).toEqual(project.localization);
    const updated = cloneAuthoringProject(opened.snapshot.project);
    updated.localization.usageNotes['path/to.flag:0123'] = 'yes';
    const changed = await workspace.write(
      root,
      opened.snapshot.workspaceRevision,
      updated,
      updated.editor,
      {},
      {
        affectedPaths: ['/localization/usageNotes'],
      },
    );
    expect(changed.snapshot.project.localization).toEqual(updated.localization);
    expect(await fs.readText(`${root}/i18n/usage-notes.yaml`)).toContain('path/to.flag:0123');
    for (const path of yamlPaths) {
      expect(await fs.readText(`${root}/${path}`)).toContain('# localization note');
      expect(await fs.inspect(`${root}/${path.replace(/\.yaml$/u, '.json')}`)).toBe('missing');
    }
    const reopened = await workspace.open(root);
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!reopened.ok) return;
    const path = `${root}/i18n/usage-notes.yaml`;
    await fs.writeTextAtomic(path, `${await fs.readText(path)}# external note\n`);
    const next = cloneAuthoringProject(reopened.snapshot.project);
    next.localization.usageNotes['path/to.flag:0123'] = 'changed';
    await expect(
      workspace.write(
        root,
        reopened.snapshot.workspaceRevision,
        next,
        next.editor,
        {},
        {
          affectedPaths: ['/localization/usageNotes'],
        },
      ),
    ).rejects.toThrow();
  });
});
