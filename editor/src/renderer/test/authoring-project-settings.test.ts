import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetRef, projectSettingsFromProject, validateTypedProjectSettings } from '../../shared/project-schema/authoring-project-settings';
import { defaultLayoutData, layoutRecordRef } from '../../shared/project-schema/authoring-layouts';

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
    expect(settings.ui.systemLayouts).toEqual({});
    expect(settings.text.defaultFont).toBeNull();
    expect(settings.titleScreen).toMatchObject({ showProjectTitle: true, showAuthor: false, startLabel: 'Start' });
    expect(settings.startup.initScript).toBe('');
    expect(settings.display).toEqual({ aspectRatio: { width: 16, height: 9 }, orientation: 'landscape', barColor: '#000000' });
    expect(settings).not.toHaveProperty('comfyui');
  });

  it('rejects malformed display settings', () => {
    const project = createAuthoringProject();
    project.settings.display = { aspectRatio: { width: 0, height: 9 }, orientation: 'sideways', barColor: 'black' };
    expect(validateTypedProjectSettings(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', path: expect.stringContaining('/settings/display') }),
    ]));
  });

  it('validates project-level layout, font, image, and icon refs', () => {
    const project = createAuthoringProject();
    addAssets(project);
    project.layouts.main = { id: 'main', label: 'Main Layout', tags: [], data: defaultLayoutData('Main Layout') };
    project.settings.ui = { systemLayouts: { title: layoutRecordRef('main') } };
    project.settings.text = { defaultFont: assetRef('main-font') };
    project.settings.titleScreen = { titleImage: assetRef('logo'), showProjectTitle: true, showAuthor: true, subtitle: '', startLabel: 'Begin' };
    project.settings.app = { icon: assetRef('logo') };
    expect(validateTypedProjectSettings(project).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);

    project.settings.text = { defaultFont: assetRef('logo') };
    expect(validateTypedProjectSettings(project)).toContainEqual(expect.objectContaining({ severity: 'error', path: '/settings/text/defaultFont/$ref' }));
  });

  it('leaves legacy ComfyUI settings as passthrough data', () => {
    const project = createAuthoringProject();
    project.settings.comfyui = { enabled: true, serverUrl: 'file:///tmp/comfyui' };
    expect(projectSettingsFromProject(project)).toMatchObject({ comfyui: { enabled: true } });
    expect(validateTypedProjectSettings(project)).toEqual([]);
  });
});
