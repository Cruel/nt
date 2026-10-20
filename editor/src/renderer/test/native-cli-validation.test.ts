import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { parseNovelTeaCliGlobals } from '../../cli/bootstrap';
import { readNativeProjectValidation } from '../../cli/native-project-validation-cli';

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
