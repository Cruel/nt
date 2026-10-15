import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { roomRecordSchema } from '../../shared/project-schema/authoring-records';
import { decodeSparseRecordYaml } from '../../shared/project-workspace/sparse-record-yaml-source';
import { decodeStructuredYaml } from '../../shared/project-workspace/structured-yaml-source';

const executable = process.env.NOVELTEA_ROOM_SESSION_CERTIFY;
const fixture = resolve(
  process.cwd(),
  '../tests/projects/feature-lab/records/rooms/room-lifecycle-roundtrip.yaml',
);

describe.skipIf(!executable)('native Room session / Zod effective Project differential', () => {
  const validate = (source: string) => {
    const result = spawnSync(executable!, ['--validate'], { input: source, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      valid: boolean;
      nativeNormalized?: unknown;
      diagnostics: { path: string; code: string }[];
    };
  };

  it.each([
    'room-lifecycle-roundtrip',
    'feature-lab-home',
    'active-text',
    'rooms-interactions-policy-target',
    'script-and-data',
  ])('matches native/TypeScript effective values for real Room %s', (id) => {
    const source = readFileSync(
      resolve(process.cwd(), `../tests/projects/feature-lab/records/rooms/${id}.yaml`),
      'utf8',
    );
    const reference = roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', source));
    const result = validate(source);
    expect(result.valid, JSON.stringify(result.diagnostics)).toBe(reference.success);
    if (reference.success) expect(result.nativeNormalized).toEqual(reference.data);
  });

  it('reports precise semantic Room errors without treating an invalid source as valid', () => {
    const original = readFileSync(fixture, 'utf8');
    const source = original.replace(
      '  presentationSpace:',
      '  presentationSpace:\n    edgePolicy: unsupported',
    );
    expect(roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', source)).success).toBe(false);
    const native = validate(source);
    expect(native.valid).toBe(false);
    expect(native.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      '/data/presentationSpace/edgePolicy',
    );
  });

  it('matches native validation of Room-owned Property declarations and errors', () => {
    const original = readFileSync(fixture, 'utf8');
    const property = `localProperties:
  - id: health
    type: integer
    nullable: false
    value: 12`;
    const valid = original.replace('localProperties: []', property);
    const reference = roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', valid));
    expect(reference.success).toBe(true);
    const native = validate(valid);
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(true);
    if (reference.success) expect(native.nativeNormalized).toEqual(reference.data);

    const invalid = valid.replace('value: 12', 'value: incorrect');
    expect(roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', invalid)).success).toBe(
      false,
    );
    const broken = validate(invalid);
    expect(broken.valid).toBe(false);
    expect(broken.diagnostics.map((diagnostic) => diagnostic.path)).toContain(
      '/localProperties/0/value',
    );

    const duplicate = valid.replace(
      '    value: 12',
      '    value: 12\n  - id: health\n    type: integer\n    nullable: false\n    value: 14',
    );
    expect(roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', duplicate)).success).toBe(
      false,
    );
    expect(validate(duplicate).diagnostics.map(({ path }) => path)).toContain(
      '/localProperties/1/id',
    );
  });

  it('expands the scalar always Condition shorthand identically to TypeScript', () => {
    const original = readFileSync(fixture, 'utf8');
    const source = original.replace(
      '    - id: return-start',
      '    - id: return-start\n      condition: always',
    );
    const reference = roomRecordSchema.safeParse(decodeSparseRecordYaml('rooms', source));
    expect(reference.success).toBe(true);
    const native = validate(source);
    expect(native.valid, JSON.stringify(native.diagnostics)).toBe(true);
    if (reference.success) expect(native.nativeNormalized).toEqual(reference.data);
  });

  it('reopens a native multi-field scoped Save with the same normalized Room as the editor', () => {
    const result = spawnSync(executable!, ['--roundtrip', fixture], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const values = JSON.parse(result.stdout) as {
      beforeSource: string;
      beforeRevision: string;
      savedSource: string;
      savedRevision: string;
      workingValue: unknown;
      nativeValid: boolean;
      nativeNormalized: unknown;
      revision: number;
      affectedRecords: string[];
    };
    const baseline = roomRecordSchema.parse(decodeSparseRecordYaml('rooms', values.beforeSource));
    const expected = structuredClone(baseline);
    expected.label = 'Native Room session';
    expected.data.presentationSpace.edgePolicy = 'overscan';
    const reopened = roomRecordSchema.parse(decodeSparseRecordYaml('rooms', values.savedSource));

    expect(reopened).toEqual(roomRecordSchema.parse(expected));
    expect(values.workingValue).toEqual(decodeStructuredYaml(values.savedSource));
    expect(values.nativeValid).toBe(true);
    expect(values.nativeNormalized).toEqual(reopened);
    expect(values.beforeRevision).toBe(
      `sha256:${createHash('sha256').update(values.beforeSource).digest('hex')}`,
    );
    expect(values.savedRevision).toBe(
      `sha256:${createHash('sha256').update(values.savedSource).digest('hex')}`,
    );
    expect(values.revision).toBe(1);
    expect(values.affectedRecords).toEqual(['rooms/room-lifecycle-roundtrip']);
    expect(values.savedSource).toContain('    - id: guide');
  });
});
