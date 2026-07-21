import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { runtimeExportProfileForPlatform } from '../../shared/project-schema/authoring-export';
import { buildCompiledRuntimeExport } from '../../shared/project-schema/compiled-runtime-export';
import {
  defaultPlatformExportProfile,
  type ExportPlatform,
} from '../../shared/project-schema/platform-export-contracts';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';
import { evaluatePlatformExportReadiness } from '@/export/platform-export-readiness';

function project() {
  const value = createAuthoringProject({ name: 'Readiness Matrix' });
  const room = defaultRoomData('Room');
  room.description.source = { kind: 'inline', text: 'Ready.' };
  value.rooms.room = { id: 'room', label: 'Room', data: room };
  value.entrypoint = { kind: 'room', id: 'room' };
  value.assets.icon = {
    id: 'icon',
    label: 'Icon',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/icon.png' },
      aliases: [],
    },
  };
  value.settings.app = {
    ...(value.settings.app as Record<string, unknown>),
    icon: { $ref: { collection: 'assets', id: 'icon' } },
  } as never;
  return value;
}

function readiness(target: ExportPlatform) {
  const value = project();
  const profile = defaultPlatformExportProfile(target);
  const built = buildCompiledRuntimeExport(value, {
    projectRoot: '/project',
    profile: runtimeExportProfileForPlatform(value, target),
  });
  return {
    value,
    profile,
    built,
    result: evaluatePlatformExportReadiness({
      runtimeExport: built,
      commonIdentity: {
        displayName: 'Readiness Matrix',
        applicationId: 'org.noveltea.readiness',
        saveNamespace: 'org.noveltea.readiness',
        versionName: '1.0.0',
        iconSourcePath: '/project/assets/icon.png',
      },
      profile,
      templateState: { templateToken: `${target}/build-1` },
      toolchainState: target === 'android' ? { androidSdk: '/sdk', javaHome: '/java' } : {},
      outputDirectory: '/dist',
    }),
  };
}

describe('platform export readiness', () => {
  it.each(['linux', 'web', 'android'] as const)(
    'keeps runtime and common identity blockers in every %s target matrix row',
    (target) => {
      const { value, profile } = readiness(target);
      value.entrypoint = null;
      const runtime = buildCompiledRuntimeExport(value, {
        projectRoot: '/project',
        profile: runtimeExportProfileForPlatform(value, target),
      });
      const result = evaluatePlatformExportReadiness({
        runtimeExport: runtime,
        commonIdentity: {
          displayName: '',
          applicationId: 'org.noveltea.readiness',
          saveNamespace: 'org.noveltea.readiness',
          versionName: '1.0.0',
          iconSourcePath: '/project/assets/icon.png',
        },
        profile,
        templateState: { templateToken: `${target}/build-1` },
        toolchainState: target === 'android' ? { androidSdk: '/sdk', javaHome: '/java' } : {},
        outputDirectory: '/dist',
      });
      expect(result.groups.runtimePackage.some((item) => item.severity === 'error')).toBe(true);
      expect(
        result.groups.commonIdentity.some((item) => item.path === '/settings/app/displayName'),
      ).toBe(true);
    },
  );

  it.each([
    ['linux', '/settings/app/desktop/linuxDesktopId'],
    ['web', '/settings/app/web/manifestId'],
    ['android', '/settings/app/android/applicationId'],
  ] as const)('selects only %s target metadata diagnostics', (target, selectedPath) => {
    const base = readiness(target);
    const diagnostics = [
      ['/settings/app/desktop/linuxDesktopId', 'desktop-target'],
      ['/settings/app/web/manifestId', 'web-target'],
      ['/settings/app/android/applicationId', 'android-target'],
    ].map(([path, code]) =>
      createPlatformExportValidationDiagnostic({
        severity: 'error',
        code,
        path,
        message: code,
        ownerPaths: [path],
      }),
    );
    const result = evaluatePlatformExportReadiness({
      runtimeExport: {
        ...base.built,
        diagnostics: [...base.built.diagnostics, ...diagnostics],
      },
      commonIdentity: {
        displayName: 'Readiness Matrix',
        applicationId: 'org.noveltea.readiness',
        saveNamespace: 'org.noveltea.readiness',
        versionName: '1.0.0',
        iconSourcePath: '/project/assets/icon.png',
      },
      profile: base.profile,
      templateState: { templateToken: `${target}/build-1` },
      toolchainState: target === 'android' ? { androidSdk: '/sdk', javaHome: '/java' } : {},
      outputDirectory: '/dist',
    });
    expect(result.groups.targetMetadata).toHaveLength(1);
    expect(result.diagnostics.filter((item) => item.code.endsWith('-target'))).toHaveLength(1);
    expect(result.groups.targetMetadata[0]).toMatchObject({
      path: selectedPath,
      ownerPaths: [selectedPath],
      severity: 'error',
      boundaries: ['platform-export'],
    });
  });

  it('preserves exact identity-warning contracts and requires confirmation', () => {
    const base = readiness('linux');
    const result = evaluatePlatformExportReadiness({
      runtimeExport: base.built,
      commonIdentity: {
        displayName: 'Readiness Matrix',
        applicationId: 'org.noveltea.changed',
        saveNamespace: 'org.noveltea.changed.saves',
        versionName: '1.0.0',
        iconSourcePath: '/project/assets/icon.png',
      },
      profile: base.profile,
      templateState: { templateToken: 'linux/build-1' },
      outputDirectory: '/dist',
      lastSuccessfulIdentity: {
        applicationId: 'org.noveltea.previous',
        saveNamespace: 'org.noveltea.previous',
      },
    });
    expect(result.requiresIdentityConfirmation).toBe(true);
    expect(result.identityChangeDiagnostics).toEqual([
      expect.objectContaining({
        code: 'authoring.settings.app.application-id.changed-after-export',
        path: '/settings/app/applicationId',
        ownerPaths: ['/settings/app/applicationId'],
        severity: 'warning',
        boundaries: ['platform-export'],
      }),
      expect.objectContaining({
        code: 'authoring.settings.app.save-namespace.changed-after-export',
        path: '/settings/app/saveNamespace',
        ownerPaths: ['/settings/app/saveNamespace'],
        severity: 'warning',
        boundaries: ['platform-export'],
      }),
    ]);
  });

  it('reports Android toolchain readiness without affecting Desktop or Web', () => {
    const android = readiness('android');
    const result = evaluatePlatformExportReadiness({
      runtimeExport: android.built,
      commonIdentity: {
        displayName: 'Readiness Matrix',
        applicationId: 'org.noveltea.readiness',
        saveNamespace: 'org.noveltea.readiness',
        versionName: '1.0.0',
        iconSourcePath: '/project/assets/icon.png',
      },
      profile: android.profile,
      templateState: { templateToken: 'android/build-1' },
      outputDirectory: '/dist',
    });
    expect(result.groups.environment.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'platform-export.toolchain.androidSdk.required',
        'platform-export.toolchain.javaHome.required',
      ]),
    );
    expect(result.groups.environment).toHaveLength(2);
    expect(readiness('linux').result.groups.environment).toEqual([]);
    expect(readiness('web').result.groups.environment).toEqual([]);
  });
});
