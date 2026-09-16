import { describe, expect, it } from 'vite-plus/test';
import { createScriptcPathMetadataReader } from '../../../scripts/noveltea-scriptc-path-metadata';

describe('ScriptC exact path metadata bridge', () => {
  it('requests native metadata and preserves the exact nanosecond timestamp string', async () => {
    const calls: Array<{ operation: string; request: unknown }> = [];
    const reader = createScriptcPathMetadataReader((operation, requestText) => {
      calls.push({ operation, request: JSON.parse(requestText) as unknown });
      return JSON.stringify({
        ok: true,
        kind: 'file',
        byteSize: 42,
        mtimeNanoseconds: '1789510382695187527',
      });
    });

    await expect(reader('/project/project.json')).resolves.toEqual({
      kind: 'file',
      byteSize: 42,
      mtimeNanoseconds: '1789510382695187527',
    });
    expect(calls).toEqual([
      { operation: 'path-metadata', request: { path: '/project/project.json' } },
    ]);
  });

  it('preserves missing paths without requiring metadata fields', async () => {
    const reader = createScriptcPathMetadataReader(() =>
      JSON.stringify({ ok: true, kind: 'missing' }),
    );
    await expect(reader('/project/missing.lua')).resolves.toEqual({ kind: 'missing' });
  });

  it('fails closed when exact native metadata is unavailable or inexact', async () => {
    const unavailable = createScriptcPathMetadataReader(() =>
      JSON.stringify({ ok: false, error: 'Exact metadata unavailable.' }),
    );
    await expect(unavailable('/project/project.json')).rejects.toThrow(
      'Exact metadata unavailable.',
    );

    const inexact = createScriptcPathMetadataReader(() =>
      JSON.stringify({ ok: true, kind: 'file', byteSize: 42, mtimeNanoseconds: 123 }),
    );
    await expect(inexact('/project/project.json')).rejects.toThrow(
      'Native path metadata returned inexact metadata.',
    );
  });
});
