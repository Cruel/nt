import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import type { PrepareRuntimeArtifactOptions } from '../../shared/runtime-artifact-preparation';
import type { NativeCleanExportAdmission } from '../../main/services/native-editor-session-controller';
import {
  exportNativeEditorPackage,
  prepareNativeEditorExportAssessment,
  type NativeEditorPackageTools,
} from '../../main/services/native-editor-export-service';

function sourceAdmission(): NativeCleanExportAdmission {
  return {
    project: createAuthoringProject({ name: 'Native export' }),
    diagnostics: [],
    runtimeAssetReferences: ['included'],
    workingRevision: 3,
    sourceRevisions: { 'project.yaml': 'sha256:' + 'a'.repeat(64) },
  };
}

function tools() {
  const prepare = vi.fn(async (_input: PrepareRuntimeArtifactOptions) => ({
    status: 'prepared' as const,
    artifact: {
      compiledProject: { schema: 'test-compiled', value: 'native' },
      packageOptions: { includeShaderSources: true },
    },
  }));
  const publish = vi.fn(async (_project: unknown, output: string) => {
    await writeFile(output, 'native compiled output');
    return { ok: true, success: true, diagnostics: [] };
  });
  return {
    prepare,
    publish,
    options: { prepare: prepare as unknown as NativeEditorPackageTools['prepare'], publish },
  };
}

describe('native editor package export admission', () => {
  it('rejects stale export assessment before compiling from an obsolete revision', async () => {
    const owner = { prepareCleanExportAdmission: vi.fn(async () => sourceAdmission()) };
    await expect(
      prepareNativeEditorExportAssessment(owner, 'session', 2, '/project', 'runtime'),
    ).rejects.toThrow('Stale native Project export revision.');
    expect(owner.prepareCleanExportAdmission).toHaveBeenCalledOnce();
  });

  it('publishes admitted compiled output atomically and never requests TypeScript Project validation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-export-test-'));
    try {
      const admission = sourceAdmission();
      const owner = { prepareCleanExportAdmission: vi.fn(async () => admission) };
      const output = path.join(root, 'game.ntpkg');
      const test = tools();
      expect(
        await exportNativeEditorPackage(owner, 'session', root, output, test.options),
      ).toMatchObject({
        success: true,
      });
      expect(await readFile(output, 'utf8')).toBe('native compiled output');
      expect(test.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          project: admission.project,
          admittedAuthoringDiagnostics: [],
          admittedValidationContributions: [],
          admittedRuntimeAssetReferences: ['included'],
          intent: 'runtime-package-export',
        }),
      );
      expect(owner.prepareCleanExportAdmission).toHaveBeenCalledTimes(3);
      expect((await readdir(root)).filter((file) => file.startsWith('.noveltea-package-'))).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite the last good archive when sources drift during publication', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-export-drift-'));
    try {
      const admission = sourceAdmission();
      const changed = {
        ...admission,
        sourceRevisions: { 'project.yaml': 'sha256:' + 'b'.repeat(64) },
      };
      const owner = {
        prepareCleanExportAdmission: vi
          .fn()
          .mockResolvedValueOnce(admission)
          .mockResolvedValueOnce(admission)
          .mockResolvedValueOnce(changed),
      };
      const output = path.join(root, 'game.ntpkg');
      await writeFile(output, 'previous successful export');
      const test = tools();
      await expect(
        exportNativeEditorPackage(owner, 'session', root, output, test.options),
      ).rejects.toThrow(/sources changed/);
      expect(test.publish).toHaveBeenCalledOnce();
      expect(await readFile(output, 'utf8')).toBe('previous successful export');
      expect((await readdir(root)).filter((file) => file.startsWith('.noveltea-package-'))).toEqual(
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects dirty or invalid admission without invoking the downstream compiler or writer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'native-export-block-'));
    try {
      const owner = {
        prepareCleanExportAdmission: vi.fn(async () => {
          throw new Error('Save or resolve all dirty Project and source files before exporting.');
        }),
      };
      const test = tools();
      await expect(
        exportNativeEditorPackage(
          owner,
          'session',
          root,
          path.join(root, 'game.ntpkg'),
          test.options,
        ),
      ).rejects.toThrow('Save or resolve');
      expect(test.prepare).not.toHaveBeenCalled();
      expect(test.publish).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
