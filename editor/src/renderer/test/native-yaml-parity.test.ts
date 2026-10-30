import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { roomRecordSchema } from '../../shared/project-schema/authoring-records';
import { parseRestrictedYamlDocument } from '../../shared/project-workspace/restricted-yaml-source';
import {
  decodeSparseRecordYaml,
  encodeSparseRecordYaml,
} from '../../shared/project-workspace/sparse-record-yaml-source';
import {
  decodeStructuredYaml,
  encodeStructuredYaml,
} from '../../shared/project-workspace/structured-yaml-source';

const executable = process.env.NOVELTEA_YAML_CERTIFY;
const room = readFileSync(
  resolve(process.cwd(), '../tests/projects/feature-lab/records/rooms/active-text.yaml'),
  'utf8',
);
const runNative = (input: string, args: string[] = ['--open']) => {
  const result = spawnSync(executable!, args, { input, encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    accepted: boolean;
    source: string;
    value?: unknown;
    error?: string;
    offset?: number;
    locations?: { path: string; begin: number; end: number; line: number; column: number }[];
  };
};

describe.skipIf(!executable)('libfyaml native / Project Workspace YAML parity', () => {
  it('opens a real sparse Room with the same explicit values and leaves source bytes unchanged', () => {
    const opened = runNative(room);
    expect(opened.accepted, opened.error).toBe(true);
    expect(opened.source).toBe(room);
    expect(opened.value).toEqual(decodeStructuredYaml(room));
    const effective = roomRecordSchema.parse(decodeSparseRecordYaml('rooms', opened.source));
    expect(effective.data.kind).toBe('room');
    expect((opened.value as { data: Record<string, unknown> }).data).not.toHaveProperty('kind');
    expect(opened.locations?.map((loc) => loc.path)).not.toContain('/data/kind');
    expect(opened.locations?.map((loc) => loc.path)).toContain(
      '/data/lifecycle/afterEnter/0/dialogue',
    );
  });

  it('replaces a nested typed Room reference, preserving unrelated bytes and reopens normalized', () => {
    const before = roomRecordSchema.parse(decodeSparseRecordYaml('rooms', room));
    const next = structuredClone(before);
    const event = next.data.lifecycle.afterEnter[0] as { dialogue?: { $ref: { id: string } } };
    expect(event.dialogue?.$ref.id).toBe('active-text');
    event.dialogue!.$ref.id = 'conversation-paths';
    const encodedByTs = encodeSparseRecordYaml('rooms', next, room, true);
    const edited = runNative(room, [
      '--edit',
      '/data/lifecycle/afterEnter/0/dialogue',
      JSON.stringify('conversation-paths'),
      'Keep',
    ]);
    expect(edited.accepted, edited.error).toBe(true);
    expect(edited.source).toContain('dialogue: conversation-paths');
    expect(roomRecordSchema.parse(decodeSparseRecordYaml('rooms', edited.source))).toEqual(
      roomRecordSchema.parse(decodeSparseRecordYaml('rooms', encodedByTs)),
    );
    const original = room.indexOf('dialogue: active-text');
    expect(edited.source.slice(0, original)).toBe(room.slice(0, original));
    expect(edited.source.slice(original + 'dialogue: conversation-paths'.length)).toBe(
      room.slice(original + 'dialogue: active-text'.length),
    );
  });

  it('matches selective edits, explicit-comment Keep/Remove, and quoted scalar semantics', () => {
    const input = `# document header\nid: example\ndata:\n  # field note\n  description: Initial # explanatory note\n  entries:\n    - id: first\n      ref: room-one\n    - id: second\n      ref: room-two\n`;
    const update = structuredClone(decodeStructuredYaml(input)) as {
      id: string;
      data: { description: string; entries: { id: string; ref: string }[] };
    };
    update.data.entries[1]!.ref = 'room-three';
    const tsWritten = encodeStructuredYaml(update, input);
    const native = runNative(input, ['--edit', '/data/entries/1/ref', '"room-three"']);
    expect(native.accepted, native.error).toBe(true);
    expect(native.value).toEqual(decodeStructuredYaml(tsWritten));
    expect(native.source).toContain('# field note');
    expect(native.source).toContain('# explanatory note');
    expect(native.source).toContain('ref: room-one');

    const keep = runNative(input, ['--edit', '/data/description', '"yes"']);
    expect(keep.accepted, keep.error).toBe(true);
    expect(keep.source).toContain('description: "yes" # explanatory note');
    expect(keep.source).toContain('# field note');

    const remove = runNative(input, ['--edit', '/data/description', '"yes"', 'Remove']);
    expect(remove.accepted, remove.error).toBe(true);
    expect(remove.source).toContain('description: "yes"');
    expect(remove.source).not.toContain('# field note');
    expect(remove.source).not.toContain('# explanatory note');
    expect(remove.source).toContain('# document header');
    expect(remove.value).toEqual(keep.value);
  });

  it('retains commented defaults with Keep and omits unannotated defaults', () => {
    const input = 'data:\n  description: Changed\n  edgePolicy: clip # human annotation\n';
    const keep = runNative(input, ['--edit', '/data/edgePolicy', '"contain"', 'Keep', '"contain"']);
    expect(keep.accepted, keep.error).toBe(true);
    expect(keep.source).toContain('edgePolicy: contain # human annotation');
    const remove = runNative(input, [
      '--edit',
      '/data/edgePolicy',
      '"contain"',
      'Remove',
      '"contain"',
    ]);
    expect(remove.accepted, remove.error).toBe(true);
    expect(remove.value).toEqual({ data: { description: 'Changed' } });
    expect(remove.source).not.toContain('edgePolicy');
    const elide = runNative(input, ['--edit', '/data/description', '""', 'Keep', '""']);
    expect(elide.accepted, elide.error).toBe(true);
    expect(elide.value).toEqual({ data: { edgePolicy: 'clip' } });
  });

  it('omits the first sequence-item mapping key without changing its container or siblings', () => {
    const source = `items:\n  - optional: changed\n    required: retained\n  - required: second\n`;
    const native = runNative(source, ['--edit', '/items/0/optional', '""', 'Remove', '""']);
    expect(native.accepted, native.error).toBe(true);
    expect(native.source).toContain('  -\n    required: retained');
    expect(native.value).toEqual({ items: [{ required: 'retained' }, { required: 'second' }] });
    expect(native.value).toEqual(decodeStructuredYaml(native.source));

    const lastKey = runNative('items:\n  - optional: changed\n', [
      '--edit',
      '/items/0/optional',
      '""',
      'Remove',
      '""',
    ]);
    expect(lastKey.accepted, lastKey.error).toBe(true);
    expect(lastKey.value).toEqual({ items: [{}] });
  });

  it('preserves document headers on Remove, including default omissions', () => {
    const input = '# document header\nid: old\ndata: {}\n';
    const updated = runNative(input, ['--edit', '/id', '"new"', 'Remove']);
    expect(updated.accepted, updated.error).toBe(true);
    expect(updated.source).toBe('# document header\nid: new\ndata: {}\n');

    const omitted = runNative('# document header\noptional: changed\ndata: {}\n', [
      '--edit',
      '/optional',
      '""',
      'Remove',
      '""',
    ]);
    expect(omitted.accepted, omitted.error).toBe(true);
    expect(omitted.source).toBe('# document header\ndata: {}\n');
  });

  it('removes owned preceding field annotations when omitting a default', () => {
    const input = 'data:\n  # field note\n  description: Changed\n  other: retained\n';
    const omitted = runNative(input, ['--edit', '/data/description', '""', 'Remove', '""']);
    expect(omitted.accepted, omitted.error).toBe(true);
    expect(omitted.source).toBe('data:\n  other: retained\n');
    expect(omitted.value).toEqual({ data: { other: 'retained' } });
  });

  it.each([
    'id: a\nid: b\n',
    'value: yes\n',
    'value: on\n',
    'value: 01\n',
    'value: +12\n',
    'value: .nan\n',
    'value: .inf\n',
    'value: 0x12\n',
    'items: [one, two\n',
    'tag: !custom string\n',
    'first: &anchor value\nsecond: *anchor\n',
    'a: 1\n---\nb: 2\n',
    'x: {a: 1, a: 2}\n',
    '? [one, two]\n: map\n',
    '%YAML 1.1\n---\na: 2\n',
    'value: 1_000\n',
    'value: 1.\n',
    'value: .5\n',
  ])('matches TypeScript restricted profile for unsafe YAML: %j', (input) => {
    let referenceAccepted = true;
    try {
      parseRestrictedYamlDocument(input);
    } catch {
      referenceAccepted = false;
    }
    expect(runNative(input).accepted).toBe(referenceAccepted);
  });

  it('rejects YAML 1.3 directives even when the JS YAML parser normalizes them to 1.2', () => {
    expect(runNative('%YAML 1.3\n---\na: 2\n').accepted).toBe(false);
  });

  it.each([
    'value: true\n',
    'value: null\n',
    'value: -1.0e+2\n',
    'value: "yes"\n',
    'value: "01"\n',
    'value: [false, null]\n',
    'value: !!str 123\n',
    'value: !!str false\n',
    'value: !!str null\n',
    'value: !!str yes\n',
    '!!str 123: typed string key\n',
    '%YAML 1.2\n---\nvalue: 12\n',
    'value: "👋 café"\n',
  ])('matches accepted YAML 1.2 scalars: %j', (input) => {
    const native = runNative(input);
    const reference = parseRestrictedYamlDocument(input).toJS();
    expect(native.accepted, native.error).toBe(true);
    expect(native.value).toEqual(reference);
    expect(native.source).toBe(input);
  });
});
