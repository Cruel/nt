import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import { defaultLayoutData, layoutRecordRef, validateLayoutData } from '../../shared/project-schema/authoring-layouts';
import { buildLayoutPreviewDocumentData, layoutPreviewRevision } from '../../shared/project-schema/layout-project';

describe('authoring layouts schema', () => {
  it('provides valid default layout data and preview documents', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };

    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual([]);
    expect(layoutPreviewRevision(project, 'main')).toContain('main');
    expect(buildLayoutPreviewDocumentData(project, 'main')).toMatchObject({
      layoutId: 'main',
      label: 'Main UI',
      layoutKind: 'fragment',
      target: 'default-ui',
      rml: { sourceMode: 'inline' },
      rcss: { sourceMode: 'inline' },
      lua: { sourceMode: 'inline' },
      dependencies: { scripts: [] },
      internalTemplates: {
        hostRml: '/editor-assets/internal-preview/layout-fragment-host.rml',
        hostRcss: '/editor-assets/internal-preview/layout-fragment-host.rcss',
      },
    });
  });

  it('diagnoses invalid or empty layout source data', () => {
    const project = createAuthoringProject();
    project.layouts.empty = {
      id: 'empty',
      label: 'Empty',
      tags: [],
      data: { ...defaultLayoutData('Empty'), rml: { sourceMode: 'inline', sourceText: '', sourceAsset: null } },
    };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/layouts/empty/data/rml/sourceText', category: 'authoring-layouts' }),
    ]));
  });

  it('validates system layout references and indexes settings usage', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', tags: [], data: defaultLayoutData('Main UI') };
    project.settings.ui = { systemLayouts: { title: layoutRecordRef('main') } };

    expect(validateAuthoringProject(project).filter((diagnostic) => diagnostic.category === 'authoring-layouts')).toEqual([]);
    expect(findUsages(buildReferenceIndex(project), { collection: 'layouts', id: 'main' })).toEqual([
      expect.objectContaining({ sourceCollection: 'project', sourceId: 'settings', path: '/settings/ui/systemLayouts/title/$ref' }),
    ]);
  });

  it('reports missing dependency refs', () => {
    const project = createAuthoringProject();
    project.layouts.main = {
      id: 'main',
      label: 'Main UI',
      tags: [],
      data: {
        ...defaultLayoutData('Main UI'),
        dependencies: { images: [{ $ref: { collection: 'assets', id: 'missing-image' } }], fonts: [], stylesheets: [], scripts: [], materials: [{ $ref: { collection: 'materials', id: 'missing-material' } }] },
      },
    };

    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/layouts/main/data/dependencies/images/0/$ref' }),
      expect.objectContaining({ path: '/layouts/main/data/dependencies/materials/0/$ref' }),
    ]));
  });

  it('warns when fragment RML contains full document tags', () => {
    const project = createAuthoringProject();
    project.layouts.widget = {
      id: 'widget',
      label: 'Widget',
      tags: [],
      data: {
        ...defaultLayoutData('Widget', 'fragment'),
        rml: { sourceMode: 'inline', sourceText: '<rml><body><button>Bad fragment</button></body></rml>', sourceAsset: null },
      },
    };

    expect(validateLayoutData(project, 'widget', project.layouts.widget)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/layouts/widget/data/rml/sourceText', severity: 'warning' }),
    ]));
  });
});
