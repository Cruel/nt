import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { workspaceManifestSchema } from '../../shared/project-workspace/workspace-manifest-schema';
import { decodeStructuredYaml } from '../../shared/project-workspace/structured-yaml-source';
import { projectWorkspaceSourceSchemas } from '../../shared/project-workspace/project-workspace-service';

const executable = process.env.NOVELTEA_PROJECT_SESSION_CERTIFY;
const fixture = resolve(process.cwd(), '../tests/projects/feature-lab');
const manifest = readFileSync(resolve(fixture, 'project.yaml'), 'utf8');
const traits = readFileSync(resolve(fixture, 'traits.yaml'), 'utf8');
const editor = readFileSync(resolve(fixture, 'editor.yaml'), 'utf8');

function nativeValidate(source: string, flag = '--validate') {
  const result = spawnSync(executable!, [flag], { input: source, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    valid: boolean;
    nativeNormalized?: unknown;
    diagnostics: { path: string; code: string }[];
  };
}

describe.skipIf(!executable)('native Project workspace manifest / Zod parity', () => {
  it.each([
    ['canonical', (source: string) => source],
    [
      'defaulted title screen setting',
      (source: string) => source.replace(/^    showAuthor: false\n/mu, ''),
    ],
    [
      'absent nullable entrypoint',
      (source: string) =>
        source.replace(/^entrypoint:\n  kind: room\n  id: feature-lab-home\n/mu, ''),
    ],
    [
      'Scene entrypoint reference',
      (source: string) =>
        source.replace(
          'entrypoint:\n  kind: room\n  id: feature-lab-home',
          'entrypoint:\n  kind: scene\n  id: background-clock-a',
        ),
    ],
    [
      'invalid bootstrap reference',
      (source: string) =>
        source.replace(
          'collection: scripts\n    id: feature-lab-bootstrap',
          'collection: rooms\n    id: feature-lab-bootstrap',
        ),
    ],
    [
      'unsupported version',
      (source: string) => source.replace('schemaVersion: 1', 'schemaVersion: 2'),
    ],
    [
      'unsupported field',
      (source: string) => source.replace('schemaVersion: 1', 'schemaVersion: 1\nlegacy: true'),
    ],
    [
      'noncanonical inventory',
      (source: string) => source.replace('  - id: inventory', '  - id: noncanonical'),
    ],
    [
      'incorrect export locale',
      (source: string) => source.replace('defaultLocale: en', 'defaultLocale: de'),
    ],
    ['invalid Android ABI', (source: string) => source.replace('abi: arm64-v8a', 'abi: x86_64')],
    [
      'invalid app identifier',
      (source: string) =>
        source.replace('applicationId: org.noveltea.featurelab', 'applicationId: Invalid ID'),
    ],
    [
      'invalid distribution notice',
      (source: string) =>
        source.replace(
          'distributionNotices: []',
          'distributionNotices:\n    - path: ../outside.md',
        ),
    ],
    [
      'valid distribution notice',
      (source: string) =>
        source.replace(
          'distributionNotices: []',
          'distributionNotices:\n    - path: notes/LICENSE.md',
        ),
    ],
    [
      'valid notice within a nested .gitignore directory',
      (source: string) =>
        source.replace(
          'distributionNotices: []',
          'distributionNotices:\n    - path: docs/.gitignore/NOTICE.md',
        ),
    ],
    [
      'invalid root reserved notice',
      (source: string) =>
        source.replace('distributionNotices: []', 'distributionNotices:\n    - path: project.yaml'),
    ],
  ] as const)('matches the Zod manifest for %s', (_name, edit) => {
    const source = edit(manifest);
    if (_name !== 'canonical') expect(source).not.toBe(manifest);
    const decoded = workspaceManifestSchema.safeParse(decodeStructuredYaml(source));
    const native = nativeValidate(source);
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(decoded.success);
    if (decoded.success) expect(native.nativeNormalized).toEqual(decoded.data);
  });

  it('reopens a generic Project Settings / export Save with exact normalized values', () => {
    const result = spawnSync(executable!, ['--roundtrip', fixture], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const roundtrip = JSON.parse(result.stdout) as {
      beforeSource: string;
      savedSource: string;
      workingValue: unknown;
      nativeNormalized: unknown;
      nativeValid: boolean;
      revision: number;
      affectedRecords: string[];
    };
    expect(roundtrip.nativeValid).toBe(true);
    expect(roundtrip.revision).toBe(3);
    expect(roundtrip.affectedRecords).toEqual(['project']);
    expect(roundtrip.savedSource).toContain('# name note');
    expect(roundtrip.savedSource).toContain('# project note');
    expect(roundtrip.beforeSource).not.toBe(roundtrip.savedSource);
    expect(roundtrip.workingValue).toEqual(decodeStructuredYaml(roundtrip.savedSource));
    expect(roundtrip.nativeNormalized).toEqual(
      workspaceManifestSchema.parse(decodeStructuredYaml(roundtrip.savedSource)),
    );
  }, 30_000);
});

describe.skipIf(!executable)('native Traits and tracked editor source / Zod parity', () => {
  it.each([
    ['canonical', (source: string) => source],
    ['omitted description', (source: string) => source.replace(/^  description:.*\n/mu, '')],
    [
      'duplicate owner kind',
      (source: string) =>
        source.replace('    - interactable\n', '    - interactable\n    - interactable\n'),
    ],
    ['mismatched Trait ID', (source: string) => source.replace('id: lab-layered', 'id: different')],
    [
      'incompatible Property default',
      (source: string) => source.replace('defaultValue: trait-default', 'defaultValue: 12'),
    ],
    [
      'duplicate Property ID',
      (source: string) =>
        source.replace(
          '      defaultValue: trait-default\n',
          '      defaultValue: trait-default\n    - id: layered\n      type: string\n      nullable: true\n',
        ),
    ],
    [
      'enum missing choices',
      (source: string) => source.replace('      type: string\n', '      type: enum\n'),
    ],
    [
      'unsupported field',
      (source: string) => source.replace('  ownerKinds:\n', '  legacy: true\n  ownerKinds:\n'),
    ],
  ] as const)('matches the Zod Traits declarations for %s', (name, mutate) => {
    const source = mutate(traits);
    if (name !== 'canonical') expect(source).not.toBe(traits);
    const expected = projectWorkspaceSourceSchemas.WorkspaceTraitDeclarations.safeParse(
      decodeStructuredYaml(source),
    );
    const native = nativeValidate(source, '--validate-traits');
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(expected.success);
    if (expected.success) expect(native.nativeNormalized).toEqual(expected.data);
    else expect(native.diagnostics.length).toBeGreaterThan(0);
  });

  it.each([
    ['canonical', (source: string) => source],
    ['implicit chapter assignments', (source: string) => source.replace('  assignments: {}\n', '')],
    [
      'implicit tag records',
      (source: string) => source.replace('tags:\n  records: {}\n', 'tags: {}\n'),
    ],
    [
      'record metadata with implicit tags',
      (source: string) =>
        source.replace(
          'recordMetadata: {}\n',
          'recordMetadata:\n  rooms:\n    room-lifecycle-roundtrip: {}\n',
        ),
    ],
    [
      'tagged organization',
      (source: string) =>
        source.replace(
          'tags:\n  records: {}\n',
          'tags:\n  records:\n    review:\n      name: Review\n      color: "#00aacc"\n',
        ),
    ],
    ['local recovery field', (source: string) => `${source}recovery: {}\n`],
    [
      'invalid tag record',
      (source: string) =>
        source.replace(
          'tags:\n  records: {}\n',
          'tags:\n  records:\n    review:\n      name: Review\n      color: ""\n',
        ),
    ],
  ] as const)('matches the Zod tracked editor organization for %s', (name, mutate) => {
    const source = mutate(editor);
    if (name !== 'canonical') expect(source).not.toBe(editor);
    const expected = projectWorkspaceSourceSchemas.WorkspaceTrackedEditor.safeParse(
      decodeStructuredYaml(source),
    );
    const native = nativeValidate(source, '--validate-editor');
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(expected.success);
    if (expected.success) expect(native.nativeNormalized).toEqual(expected.data);
    else expect(native.diagnostics.length).toBeGreaterThan(0);
  });
});
