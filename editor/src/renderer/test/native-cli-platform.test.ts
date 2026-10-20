import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliPlatformToolService } from '../../cli/platform-tool-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { emptyEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';
import { defaultPlatformExportProfile } from '../../shared/project-schema/platform-export-contracts';
import { logicalRuntimeArtifactPaths } from '../../shared/runtime-artifact-preparation';
import { projectWorkspaceLocalStateFile } from '../../shared/project-workspace/project-workspace-service';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(targets: Array<'linux' | 'windows' | 'android'> = ['linux']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nt-native-platform-'));
  roots.push(root);
  const yaml = 'invalid: [yaml\n';
  await writeFile(path.join(root, 'project.yaml'), yaml);
  const project = createAuthoringProject({ id: 'native-platform', name: 'Native Platform' });
  project.export.profiles = targets.map((target) => defaultPlatformExportProfile(target));
  const preparation = {
    project,
    sourceGeneration: `sha256:${'1'.repeat(64)}`,
    sourceRevisions: {
      'project.yaml': `sha256:${createHash('sha256').update(yaml).digest('hex')}`,
    },
    sourceOverlays: { 'shaders/common.sc': '// native-pinned' },
    referencedAssetIds: ['hero'],
    cliDiagnostics: [],
  };
  const localPath = path.join(root, '.noveltea/editor/state.json');
  return { root, project, preparation, localPath };
}

function platformTools(
  exportProject: NovelTeaCliPlatformToolService['exportProject'],
  patch: Partial<NovelTeaCliPlatformToolService> = {},
): NovelTeaCliPlatformToolService {
  return {
    async exportProject(...args) {
      return exportProject(...args);
    },
    async loadUserConfig() {
      return {
        format: 'noveltea.user-export-config',
        formatVersion: 1,
        toolchains: {},
        signingProfiles: [],
      };
    },
    async listTemplates() {
      return [];
    },
    async inspectTemplate() {
      return null;
    },
    async installTemplate() {
      throw new Error('Unexpected install.');
    },
    async removeTemplate() {
      throw new Error('Unexpected remove.');
    },
    async initializeConfig() {
      throw new Error('Unexpected config init.');
    },
    ...patch,
  };
}

function success(request: Parameters<NovelTeaCliPlatformToolService['exportProject']>[0]) {
  return {
    ok: true,
    success: true,
    cancelled: false,
    operationId: 'native-platform',
    templateToken: 'platform@build',
    outputDirectory: request.outputDirectory,
    diagnostics: [],
  };
}

function native(
  preparation: Awaited<ReturnType<typeof fixture>>['preparation'],
  actions: string[],
  onProof?: () => boolean,
) {
  return (request: Readonly<Record<string, unknown>>) => {
    actions.push(String(request.action));
    return request.action === 'platform-export-preparation'
      ? {
          ok: true,
          ...preparation,
          runtimeIntent: 'platform-export',
          projectIdentity: preparation.project.project,
        }
      : onProof?.() === false
        ? { ok: false, kind: 'conflict', error: 'Project sources changed.' }
        : { ok: true };
  };
}

it('runs write-free native platform preflight with exact source authority and shared tools', async () => {
  const { root, preparation, localPath } = await fixture();
  const actions: string[] = [];
  const received: unknown[] = [];
  const result = await runNovelTeaCli(
    [
      '--json',
      'platform',
      'export',
      '--output',
      'dist/game',
      '--check',
      '--force',
      '--allow-untrusted-template',
    ],
    {
      cwd: root,
      nativeProjectCommands: native(preparation, actions),
      platformTools: platformTools(async (request, _, __, beforePublish, admitted) => {
        received.push({ request, admitted, beforePublish: typeof beforePublish });
        return success(request);
      }),
    },
  );
  expect(result.exitCode, JSON.stringify(result.envelope.diagnostics)).toBe(0);
  expect(result.envelope.checked).toBe(true);
  expect(actions).toEqual([
    'platform-export-preparation',
    'source-generation-proof',
    'source-generation-proof',
  ]);
  expect(received).toMatchObject([
    {
      request: {
        profileId: 'linux-release',
        checkOnly: true,
        force: true,
        allowUntrustedTemplate: true,
        outputDirectory: path.join(root, 'dist/game'),
      },
      admitted: {
        project: preparation.project,
        runtimeAssetReferences: ['hero'],
        shaderSourceOverlays: { 'shaders/common.sc': '// native-pinned' },
      },
      beforePublish: 'function',
    },
  ]);
  await expect(readFile(localPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe('invalid: [yaml\n');
});

it('enforces profile ambiguity, explicit selection and identity acknowledgement without publication', async () => {
  const { root, preparation, localPath } = await fixture(['linux', 'windows']);
  const before = projectWorkspaceLocalStateFile({
    ...emptyEditorProjectState(),
    lastSuccessfulPlatformExportIdentity: {
      applicationId: 'com.example.old',
      saveNamespace: 'old-save',
    },
  });
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, before);
  let calls = 0;
  const tools = platformTools(async (request) => {
    calls++;
    return success(request);
  });
  const options = {
    cwd: root,
    nativeProjectCommands: native(preparation, []),
    platformTools: tools,
  };
  const ambiguous = await runNovelTeaCli(
    ['--json', 'platform', 'export', '--output', 'dist/game', '--check'],
    options,
  );
  expect(ambiguous.exitCode).toBe(4);
  expect(ambiguous.envelope.diagnostics[0]?.code).toBe('platform.profile_missing');
  const unacknowledged = await runNovelTeaCli(
    [
      '--json',
      'platform',
      'export',
      '--output',
      'dist/game',
      '--profile',
      'windows-release',
      '--check',
    ],
    options,
  );
  expect(unacknowledged.exitCode).toBe(4);
  expect(unacknowledged.envelope.diagnostics[0]?.code).toBe(
    'platform.identity_change_acknowledgement_required',
  );
  expect(calls).toBe(0);
  const acknowledged = await runNovelTeaCli(
    [
      '--json',
      'platform',
      'export',
      '--output',
      'dist/game',
      '--profile',
      'windows-release',
      '--allow-identity-change',
      '--check',
    ],
    options,
  );
  expect(acknowledged.exitCode).toBe(0);
  expect(calls).toBe(1);
  expect(await readFile(localPath, 'utf8')).toBe(before);
});

it('updates only ignored local identity after accepted publication and retains editor recovery', async () => {
  const { root, preparation, localPath } = await fixture();
  const original = {
    ...emptyEditorProjectState(),
    previewLocale: 'de-DE',
    sourceRecoveryById: {
      script: {
        file: {
          id: 'script',
          displayPath: 'script',
          projectRelativePath: 'scripts/script.lua',
          kind: 'lua' as const,
        },
        text: 'dirty',
        baseText: 'old',
        baseContentHash: 'absent' as const,
      },
    },
  };
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, projectWorkspaceLocalStateFile(original));
  let beforePublishCalled = false;
  const result = await runNovelTeaCli(['--json', 'platform', 'export', '--output', 'dist/game'], {
    cwd: root,
    nativeProjectCommands: native(preparation, []),
    platformTools: platformTools(async (request, _, __, beforePublish) => {
      expect(await beforePublish?.()).toBeNull();
      beforePublishCalled = true;
      return success(request);
    }),
  });
  expect(result.exitCode, JSON.stringify(result.envelope.diagnostics)).toBe(0);
  expect(beforePublishCalled).toBe(true);
  const saved = JSON.parse(await readFile(localPath, 'utf8')) as Record<string, unknown>;
  expect(saved).toMatchObject({
    previewLocale: 'de-DE',
    sourceRecoveryById: original.sourceRecoveryById,
    lastSuccessfulPlatformExportIdentity: {
      applicationId: projectSettingsFromProject(preparation.project).app.applicationId,
    },
  });
  expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe('invalid: [yaml\n');
});

it('creates missing editor-local metadata only after accepted output and keeps it out of Project source', async () => {
  const { root, preparation, localPath } = await fixture();
  const initial = await readFile(path.join(root, 'project.yaml'), 'utf8');
  const result = await runNovelTeaCli(['--json', 'platform', 'export', '--output', 'dist/game'], {
    cwd: root,
    nativeProjectCommands: native(preparation, []),
    platformTools: platformTools(async (request) => success(request)),
  });
  expect(result.exitCode, JSON.stringify(result.envelope.diagnostics)).toBe(0);
  expect(JSON.parse(await readFile(localPath, 'utf8'))).toMatchObject({
    lastSuccessfulPlatformExportIdentity: {
      applicationId: projectSettingsFromProject(preparation.project).app.applicationId,
    },
  });
  expect(await readFile(path.join(root, 'project.yaml'), 'utf8')).toBe(initial);
});

it('checks pinned source generation at final publication, not only at admission', async () => {
  const { root, preparation, localPath } = await fixture();
  let proofCount = 0;
  let activated = false;
  const result = await runNovelTeaCli(['--json', 'platform', 'export', '--output', 'dist/game'], {
    cwd: root,
    nativeProjectCommands: native(preparation, [], () => ++proofCount === 1),
    platformTools: platformTools(async (request, _, __, beforePublish) => {
      const blocker = await beforePublish?.();
      expect(blocker).toContain('Project sources changed');
      if (!blocker) activated = true;
      return {
        ...success(request),
        ok: !blocker,
        success: !blocker,
        diagnostics: blocker
          ? [
              createPlatformExportValidationDiagnostic({
                code: 'platform-source-changed',
                path: '/outputDirectory',
                severity: 'error',
                message: blocker,
              }),
            ]
          : [],
      };
    }),
  });
  expect(result.exitCode).toBe(4);
  expect(activated).toBe(false);
  expect(proofCount).toBe(2);
  await expect(readFile(localPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not record failed or stale publication and does not overwrite concurrent local edits', async () => {
  const { root, preparation, localPath } = await fixture();
  const actions: string[] = [];
  const failed = await runNovelTeaCli(['--json', 'platform', 'export', '--output', 'dist/game'], {
    cwd: root,
    nativeProjectCommands: native(preparation, actions, () => false),
    platformTools: platformTools(async () => {
      throw new Error('Stale sources must never reach staging.');
    }),
  });
  expect(failed.exitCode).toBe(5);
  await expect(readFile(localPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  const succeeded = await runNovelTeaCli(
    ['--json', 'platform', 'export', '--output', 'dist/game'],
    {
      cwd: root,
      nativeProjectCommands: native(preparation, []),
      platformTools: platformTools(async (request) => {
        await mkdir(path.dirname(localPath), { recursive: true });
        await writeFile(
          localPath,
          projectWorkspaceLocalStateFile({
            ...emptyEditorProjectState(),
            previewLocale: 'fr-FR',
          }),
        );
        return success(request);
      }),
    },
  );
  expect(succeeded.exitCode).toBe(0);
  expect(succeeded.envelope.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'platform.local_state_changed' })]),
  );
  expect(JSON.parse(await readFile(localPath, 'utf8'))).not.toHaveProperty(
    'lastSuccessfulPlatformExportIdentity',
  );
});

it('consumes a pinned native worker generation without readmission and reports signing-profile errors', async () => {
  const { root, preparation } = await fixture(['windows']);
  const pinned = {
    projectRoot: root,
    preparation,
  };
  const captured: unknown[] = [];
  const options = {
    cwd: root,
    nativeProjectCommands() {
      throw new Error('Pinned worker may not readmit native disk Project.');
    },
    pinnedNativePreparation: pinned,
    trustPinnedResidentSnapshot: true,
    pinnedProjectTextSources: {},
    pinnedExternalAssets: [],
    runtimeArtifactPaths: logicalRuntimeArtifactPaths,
    platformTools: platformTools(async (request) => {
      captured.push(request);
      return success(request);
    }),
  };
  const unsigned = await runNovelTeaCli(
    ['--json', 'platform', 'export', '--output', 'dist/game', '--check', '--sign'],
    options,
  );
  expect(unsigned.exitCode).toBe(4);
  expect(unsigned.envelope.diagnostics[0]?.code).toBe('platform.signing_profile_required');
  const checked = await runNovelTeaCli(
    ['--json', 'platform', 'export', '--output', 'dist/game', '--check'],
    options,
  );
  expect(checked.exitCode).toBe(0);
  expect(captured).toMatchObject([{ checkOnly: true, profileId: 'windows-release' }]);
});

it('uses the target-specific Android application identity rather than the desktop identity', async () => {
  const { root, preparation, localPath } = await fixture(['android']);
  preparation.project.settings.app = {
    ...(preparation.project.settings.app as Record<string, unknown>),
    android: { applicationId: 'org.example.native.android' },
  } as never;
  const exports: unknown[] = [];
  const result = await runNovelTeaCli(
    ['--json', 'platform', 'export', '--output', 'dist/android'],
    {
      cwd: root,
      nativeProjectCommands: native(preparation, []),
      platformTools: platformTools(async (request) => {
        exports.push(request);
        return success(request);
      }),
    },
  );
  expect(result.exitCode, JSON.stringify(result.envelope.diagnostics)).toBe(0);
  expect(exports).toMatchObject([{ project: preparation.project }]);
  const saved = JSON.parse(await readFile(localPath, 'utf8'));
  expect(saved.lastSuccessfulPlatformExportIdentity.applicationId).toBe(
    'org.example.native.android',
  );
});
