import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultExportProfile,
  normalizeExportProfile,
  runtimeExportProfileForPlatform,
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
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300', 'metal'],
      includeTests: false,
    });
    expect(project.export.runtime.id).toBe('runtime-default');
  });

  it('normalizes malformed runtime profiles', () => {
    const project = createAuthoringProject();
    expect(normalizeExportProfile({ label: '', shaderVariants: [] }, project)).toMatchObject({
      id: 'runtime-default',
      label: 'Runtime Package',
      shaderVariants: ['glsl-120', 'essl-100', 'essl-300', 'metal'],
    });
  });

  it('reads the built-in runtime profile from top-level export settings', () => {
    const project = createAuthoringProject();
    project.export.runtime = {
      ...defaultExportProfile(project),
      shaderVariants: ['essl-300'],
    };
    expect(selectedExportProfile(project)).toMatchObject({
      id: 'runtime-default',
      label: 'Runtime Package',
      shaderVariants: ['essl-300'],
    });
    expect(runtimeExportProfileForPlatform(project, 'windows').shaderVariants).toEqual([
      'glsl-120',
    ]);
    expect(runtimeExportProfileForPlatform(project, 'linux').shaderVariants).toEqual(['glsl-120']);
    expect(runtimeExportProfileForPlatform(project, 'web').shaderVariants).toEqual(['essl-100']);
    expect(runtimeExportProfileForPlatform(project, 'android').shaderVariants).toEqual([
      'essl-300',
    ]);
    expect(runtimeExportProfileForPlatform(project, 'macos').shaderVariants).toEqual(['metal']);
  });
});
