import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';
import { mapRecordSchema } from '../../shared/project-schema/authoring-records';
import fixture from '../../../../tools/project_authoring/tests/map.json';

const executable = process.env.NOVELTEA_SCHEMA_CERTIFY;
const native = (value: unknown, contract = 'MapsRecord') => {
  const result = spawnSync(executable!, [contract], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    accepted: boolean;
    value?: unknown;
    diagnostics: { path: string; code: string; message: string }[];
  };
};
const predicatePath = 'data/locations/0/visibility/conditions/0/condition';
const target = { kind: 'record', collection: 'rooms', id: 'station' };

// CI sets this to the separately built, Node-independent host certification executable.
describe.skipIf(!executable)('native/Zod authored Map record certification', () => {
  it('preserves recursive Conditions, default arrays, overwrites, and ECMAScript trims', () => {
    const input = structuredClone(fixture);
    input.data.locations[0]!.style = '\ufeff\u2009highlighted\u00a0\u2029';
    const expected = mapRecordSchema.parse(input);
    const result = native(input);
    expect(result.accepted, JSON.stringify(result.diagnostics)).toBe(true);
    expect(result.value).toEqual(expected);
    expect(input.data.locations[0]!.visibility.conditions[0]).not.toHaveProperty(
      'condition.additionalDependencies',
    );
  });

  it.each([
    ['empty trimmed style', 'data/locations/0/style', ' \t '],
    ['nested wrong scalar', 'data/locations/0/visibility/conditions/1/quantity', -1],
    ['nested unknown discriminator', `${predicatePath}/kind`, 'unknown'],
    ['explicit null is not omission', `${predicatePath}/additionalDependencies`, null],
    [
      'duplicate semantic targets',
      `${predicatePath}/additionalDependencies`,
      { targets: [target, target] },
    ],
    ['strict unknown keys', `${predicatePath}/unexpected`, true],
  ] as const)('rejects %s with useful nested paths', (_, path, value) => {
    const input = structuredClone(fixture);
    const parts = path.split('/');
    let owner = input as unknown as Record<string, unknown>;
    for (const key of parts.slice(0, -1)) owner = owner[key] as Record<string, unknown>;
    owner[parts.at(-1)!] = value;
    const reference = mapRecordSchema.safeParse(input);
    expect(reference.success).toBe(false);
    const result = native(input);
    expect(result.accepted).toBe(false);
    if (!reference.success) {
      const paths = reference.error.issues.flatMap((issue) =>
        issue.code === 'unrecognized_keys'
          ? issue.keys.map((key) => '/' + [...issue.path, key].join('/'))
          : ['/' + issue.path.join('/')],
      );
      expect(result.diagnostics.map(({ path }) => path)).toEqual(expect.arrayContaining(paths));
    }
  });

  it('does not claim full Project admission before registered semantic operations are implemented', () => {
    const result = native({}, 'Project');
    expect(result.accepted).toBe(false);
    expect(result.diagnostics.some(({ code }) => code === 'contract.unsupported_operation')).toBe(
      true,
    );
  });
});
