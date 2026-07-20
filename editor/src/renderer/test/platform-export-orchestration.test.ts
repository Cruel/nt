import { describe, expect, it } from 'vite-plus/test';
import { exportProjectToPlatform } from '../../main/services/platform-export-orchestration-service';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import { buildCompiledRuntimeExport } from '../../shared/project-schema/compiled-runtime-export';
import { parseProjectPlatformExportSettings } from '../../shared/project-schema/platform-export-contracts';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';

function exportableProject() {
  const project = createAuthoringProject({ name: 'Main Trust Boundary' });
  const room = defaultRoomData('Room');
  room.description.source = { kind: 'inline', text: 'Ready.' };
  project.rooms.room = { id: 'room', label: 'Room', data: room };
  project.entrypoint = { kind: 'room', id: 'room' };
  project.assets.icon = {
    id: 'icon',
    label: 'Icon',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/icon.png' },
      aliases: [],
    },
  };
  project.settings.app = {
    ...(project.settings.app as Record<string, unknown>),
    icon: { $ref: { collection: 'assets', id: 'icon' } },
  } as never;
  return project;
}

function prepared(project: ReturnType<typeof exportableProject>) {
  const profile = parseProjectPlatformExportSettings(project.settings.platformExport).profiles[0]!;
  const runtimeProfile = runtimeExportProfileForPlatform(project, profile.target);
  const built = buildCompiledRuntimeExport(project, {
    projectRoot: '/project',
    profile: runtimeProfile,
  });
  expect(built.ok).toBe(true);
  return {
    profile,
    runtime: {
      sourceFingerprint: built.sourceFingerprint,
      profile: runtimeProfile,
      compiledProject: built.compiledProject,
      packageOptions: built.packageOptions,
      diagnostics: built.diagnostics,
    },
  };
}

describe('platform export main-process trust boundary', () => {
  it('rejects malformed serialized requests before orchestration', async () => {
    const result = await exportProjectToPlatform({
      profileId: 'linux-release',
      outputDirectory: '',
    } as never);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'platform-export-request-invalid',
        path: '/request',
        ownerPaths: ['/request'],
        boundaries: ['platform-export'],
      }),
    );
  });

  it('rejects a prepared package fingerprint from an older project revision', async () => {
    const project = exportableProject();
    const preparation = prepared(project);
    project.project.name = 'Changed after readiness';
    const result = await exportProjectToPlatform({
      operationId: 'stale-fingerprint',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      preparedRuntimeExport: preparation.runtime,
    });
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'runtime-package-fingerprint-stale',
        path: '/preparedRuntimeExport/sourceFingerprint',
        ownerPaths: ['/preparedRuntimeExport/sourceFingerprint', '/project'],
        severity: 'error',
        boundaries: ['platform-export'],
      }),
    ]);
  });

  it('preserves prepared blocker contracts across the IPC orchestration boundary', async () => {
    const project = exportableProject();
    const preparation = prepared(project);
    const blocker = createPlatformExportValidationDiagnostic({
      code: 'platform-export.contract-test',
      severity: 'error',
      category: 'Contract test',
      path: '/settings/app/applicationId',
      message: 'Contract test blocker.',
      ownerPaths: ['/settings/app/applicationId'],
    });
    const result = await exportProjectToPlatform({
      operationId: 'diagnostic-contract',
      project,
      projectRoot: '/project',
      profileId: preparation.profile.id,
      outputDirectory: '/dist',
      preparedRuntimeExport: {
        ...preparation.runtime,
        diagnostics: [...preparation.runtime.diagnostics, blocker],
      },
    });
    expect(result.diagnostics).toContainEqual(blocker);
  });
});
