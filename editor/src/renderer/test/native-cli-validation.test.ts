import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import { readNativeProjectValidation } from '../../cli/native-project-validation-cli';
import { runNativeProjectValidationCli } from '../../cli/native-project-validation-cli';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'noveltea-native-validate-'));
  roots.push(root);
  await writeFile(path.join(root, 'project.yaml'), 'invalid: [yaml\n');
  return root;
}

it('reads native semantic diagnostics without parsing Project YAML in TypeScript', async () => {
  const root = await fixture();
  const requests: unknown[] = [];
  const result = await readNativeProjectValidation(
    parseNovelTeaCliGlobals(['--json', 'validate']),
    root,
    (request) => {
      requests.push(request);
      return {
        ok: true,
        valid: false,
        cliDiagnostics: [
          {
            code: 'source.project',
            path: '/',
            severity: 'error',
            message: 'Invalid YAML',
            sourceUrl: 'project:/project.yaml',
            line: 1,
            column: 1,
          },
        ],
      };
    },
  );
  expect(requests).toEqual([{ action: 'project-validate', projectRoot: root }]);
  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics[0]).toMatchObject({
    code: 'source.project',
    sourceUrl: 'project:/project.yaml',
    line: 1,
    column: 1,
  });
});

it('fails closed on transport errors and malformed native diagnostic responses', async () => {
  const root = await fixture();
  for (const native of [
    () => {
      throw Error('transport failure');
    },
    () => ({ ok: true, valid: true, cliDiagnostics: [{ code: 'broken' }] }),
    () => ({ ok: true, valid: true }),
  ]) {
    const result = await readNativeProjectValidation(
      parseNovelTeaCliGlobals(['--json', 'validate']),
      root,
      native,
    );
    expect(result?.exitCode).toBe(70);
    expect(result?.envelope.diagnostics[0]?.code).toBe('NATIVE_PROJECT_VALIDATION_UNAVAILABLE');
  }
});

it('validates the complete native generation without TypeScript Project admission', async () => {
  const root = await fixture();
  const requests: string[] = [];
  const project = createAuthoringProject({ id: 'native-validation', name: 'Native Validation' });
  const nativeTools = {
    validationCacheIdentity: undefined,
    async validateFontCoverage() {
      return { ok: true, success: true, diagnostics: [] };
    },
  } as unknown as NovelTeaCliNativeToolService;
  const result = await runNativeProjectValidationCli(
    parseNovelTeaCliGlobals(['--json', 'validate']),
    root,
    (request) => {
      requests.push(String(request.action));
      if (request.action === 'project-validate')
        return { ok: true, valid: true, cliDiagnostics: [], sourceGeneration: 'generation-one' };
      if (request.action === 'shader-preparation')
        return { ok: true, project, sourceGeneration: 'generation-one', sourceOverlays: {} };
      if (request.action === 'source-generation-proof') {
        expect(request.expectedSourceGeneration).toBe('generation-one');
        return { ok: true };
      }
      throw Error('unexpected native action');
    },
    nativeTools,
  );
  expect(result?.exitCode).toBe(0);
  expect(requests).toEqual(['project-validate', 'shader-preparation', 'source-generation-proof']);
});

it('rejects a changed native generation before any downstream publication', async () => {
  const root = await fixture();
  let count = 0;
  const result = await runNativeProjectValidationCli(
    parseNovelTeaCliGlobals(['--json', 'validate']),
    root,
    (request) => {
      count++;
      return request.action === 'project-validate'
        ? { ok: true, valid: true, cliDiagnostics: [], sourceGeneration: 'old' }
        : { ok: true, project: {}, sourceGeneration: 'new', sourceOverlays: {} };
    },
    {} as NovelTeaCliNativeToolService,
  );
  expect(count).toBe(2);
  expect(result?.exitCode).toBe(5);
  expect(result?.envelope.diagnostics[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
});

it('checks registered physical Assets and attaches native source locations without a TypeScript Project reader', async () => {
  const root = await fixture();
  const project = createAuthoringProject({ id: 'asset-authority', name: 'Asset Authority' });
  project.assets['missing-image'] = {
    id: 'missing-image',
    label: 'Missing Image',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/missing-image.png' },
      aliases: [],
      imageMetadata: { width: 1, height: 1, hasAlpha: true, orientation: 1 },
    },
  };
  const calls: string[] = [];
  const result = await runNativeProjectValidationCli(
    parseNovelTeaCliGlobals(['--json', 'validate']),
    root,
    (request) => {
      calls.push(String(request.action));
      if (request.action === 'project-validate')
        return { ok: true, valid: true, cliDiagnostics: [], sourceGeneration: 'native-asset' };
      if (request.action === 'shader-preparation')
        return { ok: true, project, sourceGeneration: 'native-asset', sourceOverlays: {} };
      if (request.action === 'source-generation-proof') return { ok: true };
      if (request.action === 'project-diagnostic-locations') {
        expect(request.paths).toEqual(['/assets/missing-image/data/source/path']);
        return {
          ok: true,
          locations: [
            { sourceUrl: 'project:/records/assets/missing-image.yaml', line: 4, column: 2 },
          ],
        };
      }
      throw Error('unexpected native action');
    },
    {
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
    } as unknown as NovelTeaCliNativeToolService,
  );
  expect(result?.exitCode).toBe(4);
  expect(result?.envelope.diagnostics).toEqual([
    expect.objectContaining({
      code: 'authoring.asset.source_unavailable',
      path: '/assets/missing-image/data/source/path',
      sourceUrl: 'project:/records/assets/missing-image.yaml',
      line: 4,
      column: 2,
    }),
  ]);
  expect(calls).toEqual([
    'project-validate',
    'shader-preparation',
    'source-generation-proof',
    'project-diagnostic-locations',
  ]);
});

it('rejects a newly created Asset after an earlier missing-source observation', async () => {
  const root = await fixture();
  const project = createAuthoringProject({ id: 'missing-asset-race', name: 'Asset Race' });
  project.assets['new-file'] = {
    id: 'new-file',
    label: 'New File',
    data: {
      kind: 'data',
      source: { type: 'project-file', path: 'assets/new-file.bin' },
      aliases: [],
      imageMetadata: null,
    },
  };
  const result = await runNativeProjectValidationCli(
    parseNovelTeaCliGlobals(['--json', 'validate']),
    root,
    async (request) => {
      if (request.action === 'project-validate')
        return { ok: true, valid: true, cliDiagnostics: [], sourceGeneration: 'generation' };
      if (request.action === 'shader-preparation')
        return { ok: true, project, sourceGeneration: 'generation', sourceOverlays: {} };
      if (request.action === 'source-generation-proof') {
        await mkdir(path.join(root, 'assets'), { recursive: true });
        await writeFile(path.join(root, 'assets/new-file.bin'), 'late-arrival');
        return { ok: true };
      }
      throw Error('Unexpected native command after physical drift');
    },
    {
      async validateFontCoverage() {
        return { ok: true, success: true, diagnostics: [] };
      },
    } as unknown as NovelTeaCliNativeToolService,
  );
  expect(result?.exitCode).toBe(5);
  expect(result?.envelope.diagnostics[0]?.code).toBe('WORKSPACE_REVISION_CONFLICT');
});
