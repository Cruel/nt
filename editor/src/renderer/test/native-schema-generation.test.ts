import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { generateNativeContracts } from '../../../scripts/native-schema/generate';
import { nativeOperation } from '../../shared/project-schema/native-schema-operations';
import { nativeSchemaSources } from '../../../scripts/native-schema/sources';
import { mapRecordSchema } from '../../shared/project-schema/authoring-records';

describe('native Project schema generation', () => {
  it('accounts for the complete effective Project and workspace schema families', () => {
    const contracts = generateNativeContracts(nativeSchemaSources);
    expect(Object.keys(contracts.roots).sort()).toEqual(Object.keys(nativeSchemaSources).sort());
    expect(contracts.schemas.Project).toHaveProperty('properties.rooms');
  });
  it('detects stale committed outputs through the generator command', () => {
    const output = mkdtempSync(path.join(tmpdir(), 'nt-schema-'));
    const script = path.resolve('scripts/generate-native-schema.mjs');
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [script, '--output', output, ...args], { encoding: 'utf8' });
    try {
      const generated = run();
      expect(generated.status, generated.stderr).toBe(0);
      expect(run('--check').status).toBe(0);
      const target = path.join(output, 'contracts.json');
      writeFileSync(target, readFileSync(target, 'utf8') + ' ');
      const stale = run('--check');
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('Stale native schema artifact');
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }, 30000);

  it('rejects semantics that JSON Schema would silently omit', () => {
    for (const schema of [
      z.string().trim(),
      z.string().refine((value) => value !== 'reserved'),
      z.string().transform((value) => value.length),
      z.string().overwrite((value) => value.toLowerCase()),
      z.object({ value: z.string() }).superRefine(() => {}),
    ]) {
      expect(() => generateNativeContracts({ Record: schema })).toThrow(/unregistered/i);
    }
  });

  it('rejects unknown operation IDs, unsupported Zod nodes, and non-JSON or dynamic defaults', () => {
    expect(() => nativeOperation('missing' as never, z.string().trim())).toThrow(/unregistered/i);
    expect(() => generateNativeContracts({ Record: z.date() })).toThrow(/unsupported/i);
    expect(() => generateNativeContracts({ Record: z.string().regex(/name/i) })).toThrow(
      /unsupported.*flags/i,
    );
    expect(() => generateNativeContracts({ Record: z.email() })).toThrow(/unsupported.*format/i);
    expect(() => generateNativeContracts({ Record: z.unknown().default(new Date()) })).toThrow(
      /non-JSON default/i,
    );
    let sequence = 0;
    expect(() => generateNativeContracts({ Record: z.number().default(() => sequence++) })).toThrow(
      /dynamic default/i,
    );
  });

  it('keeps UTF-16 length checks as explicit native semantics rather than code-point JSON Schema bounds', () => {
    const generated = generateNativeContracts({
      Record: z.object({ title: z.string().min(2).max(4) }),
    });
    expect(generated.schemas.Record).toHaveProperty('properties.title.x-native-utf16-length', {
      minimum: 2,
      maximum: 4,
    });
    expect(generated.schemas.Record).not.toHaveProperty('properties.title.minLength');
    expect(generated.operations).toContainEqual({ id: 'string.utf16-length', kind: 'refinement' });
  });

  it('generates deterministic structural and semantic contracts for real recursive Map records', () => {
    const generated = generateNativeContracts({ MapRecord: mapRecordSchema });
    expect(generated).toEqual(generateNativeContracts({ MapRecord: mapRecordSchema }));
    expect(generated.schemas.MapRecord).toMatchObject({ $schema: expect.any(String) });
    expect(generated.operations.map((operation) => operation.id)).toEqual(
      expect.arrayContaining([
        'string.trim',
        'value.default',
        'lua.dependencies.unique',
        'lua.dependencies.empty',
      ]),
    );
    expect(generated.types).toContain('struct MapRecord');
  });
});
