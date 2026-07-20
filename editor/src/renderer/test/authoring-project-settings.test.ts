import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  assetRef,
  projectSettingsForEditing,
  projectSettingsFromProject,
  validateProjectSettingsAuthoringState,
  validateTypedProjectSettings,
} from '../../shared/project-schema/authoring-project-settings';
import { defaultLayoutData, layoutRecordRef } from '../../shared/project-schema/authoring-layouts';

function addAssets(project: ReturnType<typeof createAuthoringProject>) {
  project.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    data: {
      kind: 'font',
      source: { type: 'project-file', path: 'assets/fonts/main.ttf' },
      aliases: [],
      extension: '.ttf',
    },
  };
  project.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
    },
  };
}

describe('authoring project settings', () => {
  it('normalizes absent settings to built-in fallbacks', () => {
    const project = createAuthoringProject();
    const settings = projectSettingsFromProject(project);
    expect(settings.ui.systemLayouts).toEqual({});
    expect(settings.text.defaultFont).toBeNull();
    expect(settings.titleScreen).toMatchObject({
      showProjectTitle: true,
      showAuthor: false,
      startLabel: 'Start',
    });
    expect(project.startupHook).toBeNull();
    expect(settings.display).toEqual({
      aspectRatio: { width: 16, height: 9 },
      orientation: 'landscape',
      barColor: '#000000',
    });
    expect(settings.app).toMatchObject({
      displayName: 'New Project',
      applicationId: 'org.noveltea.new-project',
      saveNamespace: 'org.noveltea.new-project',
      versionName: '0.1.0',
      icon: null,
    });
    expect(settings).not.toHaveProperty('comfyui');
  });

  it('rejects malformed display settings', () => {
    const project = createAuthoringProject();
    project.settings.display = {
      aspectRatio: { width: 0, height: 9 },
      orientation: 'sideways',
      barColor: 'black',
    } as never;
    expect(validateTypedProjectSettings(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: expect.stringMatching(/^authoring\.settings\.schema\./),
          severity: 'error',
          path: expect.stringContaining('/settings/display'),
          ownerPaths: [expect.stringContaining('/settings/display')],
          boundaries: ['authoring', 'runtime-package', 'platform-export'],
        }),
      ]),
    );
  });

  it('preserves present semantic errors in the Project Settings editing view', () => {
    const project = createAuthoringProject();
    const validApp = projectSettingsFromProject(project).app;
    project.project.version = '';
    project.settings.display = {
      aspectRatio: { width: 0, height: -1 },
      orientation: 'landscape',
      barColor: 'not-a-color',
    };
    project.settings.app = {
      ...validApp,
      applicationId: '',
      versionName: '',
      buildNumber: 0,
    };

    const settings = projectSettingsForEditing(project);

    expect(settings.display).toEqual(project.settings.display);
    expect(settings.app).toMatchObject({
      applicationId: '',
      versionName: '',
      buildNumber: 0,
    });
    expect(validateTypedProjectSettings(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/project/version', severity: 'error' }),
        expect.objectContaining({
          path: '/settings/display/aspectRatio/width',
          severity: 'error',
        }),
        expect.objectContaining({ path: '/settings/app/applicationId', severity: 'error' }),
        expect.objectContaining({ path: '/settings/app/versionName', severity: 'error' }),
        expect.objectContaining({ path: '/settings/app/buildNumber', severity: 'error' }),
      ]),
    );
  });

  it('keeps entrypoint and settings diagnostics independently visible', () => {
    const project = createAuthoringProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    project.project.version = '';
    project.settings.app = {
      ...projectSettingsFromProject(project).app,
      applicationId: '',
    };

    expect(validateProjectSettingsAuthoringState(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.entrypoint.target-missing',
          path: '/entrypoint',
        }),
        expect.objectContaining({ path: '/project/version', severity: 'error' }),
        expect.objectContaining({ path: '/settings/app/applicationId', severity: 'error' }),
      ]),
    );
  });

  it('validates project-level layout, font, image, and icon refs', () => {
    const project = createAuthoringProject();
    addAssets(project);
    project.layouts.main = {
      id: 'main',
      label: 'Main Layout',
      data: defaultLayoutData('Main Layout'),
    };
    project.settings.ui = { systemLayouts: { title: layoutRecordRef('main') } };
    project.settings.text = { defaultFont: assetRef('main-font') };
    project.settings.titleScreen = {
      titleImage: assetRef('logo'),
      showProjectTitle: true,
      showAuthor: true,
      subtitle: '',
      startLabel: 'Begin',
    };
    project.settings.app = { ...projectSettingsFromProject(project).app, icon: assetRef('logo') };
    expect(
      validateTypedProjectSettings(project).filter((diagnostic) => diagnostic.severity === 'error'),
    ).toEqual([]);

    project.settings.text = { defaultFont: assetRef('logo') };
    expect(validateTypedProjectSettings(project)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/settings/text/defaultFont/$ref' }),
    );
  });

  it('rejects legacy project-scoped ComfyUI settings', () => {
    const project = createAuthoringProject();
    const invalid = {
      ...project,
      settings: {
        ...project.settings,
        comfyui: { enabled: true, serverUrl: 'file:///tmp/comfyui' },
      },
    };
    expect(validateTypedProjectSettings(invalid as never)).toContainEqual(
      expect.objectContaining({ severity: 'error', path: '/settings/' }),
    );
  });

  it('migrates icon-only app settings and validates identity fields and launch assets', () => {
    const project = createAuthoringProject({ id: 'tea-house', name: 'Tea House' });
    addAssets(project);
    project.settings.app = { ...projectSettingsFromProject(project).app, icon: assetRef('logo') };
    expect(projectSettingsFromProject(project).app).toMatchObject({
      displayName: 'Tea House',
      applicationId: 'org.noveltea.tea-house',
      icon: assetRef('logo'),
    });
    expect(
      validateTypedProjectSettings(project).filter((item) => item.severity === 'error'),
    ).toEqual([]);

    const validApp = projectSettingsFromProject(project).app;
    project.settings.app = {
      ...validApp,
      applicationId: 'Bad ID',
      buildNumber: 0,
      defaultLocale: 'not_a_locale',
    };
    expect(validateTypedProjectSettings(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/settings/app/applicationId', severity: 'error' }),
        expect.objectContaining({ path: '/settings/app/buildNumber', severity: 'error' }),
      ]),
    );
    project.settings.app = {
      ...validApp,
      applicationId: 'org.example.game',
      buildNumber: 1,
      launchImage: assetRef('main-font'),
    };
    expect(validateTypedProjectSettings(project)).toContainEqual(
      expect.objectContaining({ path: '/settings/app/launchImage/$ref', severity: 'error' }),
    );
  });

  it('warns when exported application or save identity changes', () => {
    const project = createAuthoringProject();
    const app = projectSettingsFromProject(project).app;
    project.settings.app = {
      ...app,
      applicationId: 'org.example.changed',
      saveNamespace: 'org.example.changed.saves',
      lastExportedIdentity: { applicationId: app.applicationId, saveNamespace: app.saveNamespace },
    };
    expect(validateTypedProjectSettings(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoring.settings.app.application-id.changed-after-export',
          path: '/settings/app/applicationId',
          severity: 'warning',
          ownerPaths: ['/settings/app/applicationId'],
          boundaries: ['authoring', 'platform-export'],
        }),
        expect.objectContaining({
          code: 'authoring.settings.app.save-namespace.changed-after-export',
          path: '/settings/app/saveNamespace',
          severity: 'warning',
          ownerPaths: ['/settings/app/saveNamespace'],
          boundaries: ['authoring', 'platform-export'],
        }),
      ]),
    );
  });

  it('attributes invalid localized locale keys to their escaped canonical owner path', () => {
    const project = createAuthoringProject();
    project.settings.app = {
      ...projectSettingsFromProject(project).app,
      defaultLocale: 'en-US',
      localized: {
        'bad/locale~': { displayName: 'Invalid locale key' },
      },
    };

    expect(validateTypedProjectSettings(project)).toContainEqual(
      expect.objectContaining({
        code: 'authoring.settings.app.locale.invalid',
        severity: 'error',
        path: '/settings/app/localized/bad~1locale~0',
        ownerPaths: ['/settings/app/localized/bad~1locale~0'],
        boundaries: ['authoring', 'platform-export'],
      }),
    );
  });
});
