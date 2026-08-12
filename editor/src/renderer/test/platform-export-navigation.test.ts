import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { createProjectValidationDiagnostic } from '../../shared/project-schema/project-validation';
import { resolvePlatformExportDiagnosticTarget } from '../export/platform-export-navigation';

describe('platform export diagnostic navigation', () => {
  it('routes rejected Prepared Runtime Artifact evidence to runtime-package readiness', () => {
    const project = createAuthoringProject({ name: 'Navigation' });
    const diagnostic = createProjectValidationDiagnostic({
      code: 'runtime-artifact.evidence.rejected',
      severity: 'error',
      path: '/artifact/packageOptions',
      message: 'Prepared package evidence was rejected.',
      category: 'Runtime package readiness',
      boundaries: ['runtime-package'],
      ownerPaths: ['/artifact/packageOptions'],
    });

    expect(resolvePlatformExportDiagnosticTarget(project, diagnostic)).toMatchObject({
      target: { id: 'platformExport.runtimePackage' },
    });
  });
});
