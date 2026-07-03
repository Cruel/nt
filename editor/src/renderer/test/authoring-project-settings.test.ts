import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetRef, projectSettingsFromProject, validateTypedProjectSettings } from '../../shared/project-schema/authoring-project-settings';
import { defaultLayoutData, defaultLayoutRef } from '../../shared/project-schema/authoring-layouts';

function addAssets(project: ReturnType<typeof createAuthoringProject>) {
  project.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    tags: [],
    data: { kind: 'font', source: { type: 'project-file', path: 'assets/fonts/main.ttf' }, aliases: [], extension: '.ttf' },
  };
  project.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
}

describe('authoring project settings', () => {
  it('normalizes absent settings to built-in fallbacks', () => {
    const project = createAuthoringProject();
    const settings = projectSettingsFromProject(project);
    expect(settings.ui.defaultLayout).toBeNull();
    expect(settings.text.defaultFont).toBeNull();
    expect(settings.titleScreen).toMatchObject({ showProjectTitle: true, showAuthor: false, startLabel: 'Start' });
    expect(settings.startup.initScript).toBe('');
    expect(settings.comfyui).toMatchObject({
      enabled: false,
      serverUrl: 'http://127.0.0.1:8000',
      defaultWorkflowId: 'flux2-klein-text-to-image',
      defaultWorkflows: {
        'image.generate': 'flux2-klein-text-to-image',
        'image.edit': 'flux2-klein-image-edit',
      },
    });
  });

  it('validates project-level layout, font, image, and icon refs', () => {
    const project = createAuthoringProject();
    addAssets(project);
    project.layouts.main = { id: 'main', label: 'Main Layout', tags: [], data: defaultLayoutData('Main Layout') };
    project.settings.ui = { defaultLayout: defaultLayoutRef('main') };
    project.settings.text = { defaultFont: assetRef('main-font') };
    project.settings.titleScreen = { titleImage: assetRef('logo'), showProjectTitle: true, showAuthor: true, subtitle: '', startLabel: 'Begin' };
    project.settings.app = { icon: assetRef('logo') };
    expect(validateTypedProjectSettings(project).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

    project.settings.text = { defaultFont: assetRef('logo') };
    expect(validateTypedProjectSettings(project)).toContainEqual(expect.objectContaining({ severity: 'error', path: '/settings/text/defaultFont/$ref' }));
  });

  it('validates ComfyUI settings when enabled', () => {
    const project = createAuthoringProject();
    project.settings.comfyui = {
      enabled: true,
      serverUrl: 'file:///tmp/comfyui',
      defaultWorkflowId: 'basic-text-to-image',
      requestTimeoutMs: 15000,
      connectionCheckIntervalMs: 10000,
    };
    expect(validateTypedProjectSettings(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: '/settings/comfyui/serverUrl' }),
    ]));
  });
});
