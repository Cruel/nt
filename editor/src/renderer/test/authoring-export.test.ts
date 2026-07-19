import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultExportProfile,
  defaultExportSettings,
  normalizeExportProfile,
  parseExportSettings,
  selectedExportProfile,
} from '../../shared/project-schema/authoring-export';

describe('authoring export settings', () => {
  it('creates a runtime export profile by default', () => {
    const project = createAuthoringProject({ name: 'Demo Project' });
    expect(defaultExportProfile(project)).toMatchObject({
      id: 'runtime-default',
      label: 'Runtime Package',
      kind: 'runtime',
      includeChecksums: true,
      stripShaderSources: true,
      compileShadersBeforeExport: true,
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
      includeTests: false,
    });
    expect(defaultExportSettings(project).selectedProfileId).toBe('runtime-default');
  });

  it('normalizes absent or malformed settings', () => {
    const project = createAuthoringProject();
    expect(parseExportSettings(null, project).profiles).toHaveLength(1);
    expect(normalizeExportProfile({ label: '', shaderVariants: [] }, project)).toMatchObject({
      id: 'runtime-default',
      label: 'Runtime Package',
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300'],
    });
  });

  it('reads the selected profile from project settings', () => {
    const project = createAuthoringProject();
    project.settings.export = {
      selectedProfileId: 'web',
      profiles: [
        { ...defaultExportProfile(project), id: 'desktop', label: 'Desktop' },
        { ...defaultExportProfile(project), id: 'web', label: 'Web', shaderVariants: ['essl-300'] },
      ],
    };
    expect(selectedExportProfile(project)).toMatchObject({
      id: 'web',
      label: 'Web',
      shaderVariants: ['essl-300'],
    });
  });
});
