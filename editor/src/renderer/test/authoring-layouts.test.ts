import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { emptyMaterialApplication } from '../../shared/project-schema/authoring-material-applications';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { buildReferenceIndex, findUsages } from '../../shared/project-schema/authoring-references';
import {
  defaultLayoutData,
  resolveLayoutScalePolicy,
  layoutRecordRef,
  validateLayoutData,
} from '../../shared/project-schema/authoring-layouts';
import {
  buildLayoutPreviewDocumentData,
  layoutPreviewRevision,
} from '../../shared/project-schema/layout-project';

describe('authoring layouts schema', () => {
  it('provides valid default layout data and preview documents', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };

    const defaults = defaultLayoutData('Main UI');
    expect(defaults.preview).toEqual({ background: 'dark' });
    expect(defaults.contract).toEqual({ inputs: {}, signals: {} });
    expect(defaults.rcss.sourceText).not.toContain('pointer-events');
    expect(defaults.rcss.sourceText).toContain('.noveltea-layout-preview {\n  margin: 48px;');
    const documentDefaults = defaultLayoutData('Main UI', 'document');
    expect(documentDefaults.rml.sourceText).toContain(
      'onshow="layout_preview.on_show(event, element, document)"',
    );
    expect(documentDefaults.rml.sourceText).toContain('Lua global: 0');
    expect(documentDefaults.rml.sourceText).toContain('Saved Layout State: 0');
    expect(documentDefaults.lua.sourceText).toContain("mount:state('session')");
    expect(documentDefaults.lua.sourceText).toContain("mount:commit_state('session'");
    expect(documentDefaults.contract.state).toMatchObject({
      type: 'object',
      defaultValue: { saved_count: 0 },
    });
    expect(documentDefaults.sampleState).toEqual({ state: { saved_count: 0 } });
    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual([]);
    expect(layoutPreviewRevision(project, 'main')).toContain('main');
    expect(buildLayoutPreviewDocumentData(project, 'main')).toMatchObject({
      schema: 'noveltea.layout-preview',
      layoutId: 'main',
      label: 'Main UI',
      layoutKind: 'fragment',
      target: 'default-ui',
      scalePolicy: { ui: 'inherit', text: 'inherit' },
      contract: { inputs: [], signals: [], state: null },
      rml: { sourceMode: 'inline' },
      rcss: { sourceMode: 'inline' },
      lua: { sourceMode: 'inline' },
      dependencies: { scripts: [] },
      preview: { background: 'dark' },
      internalTemplates: {
        hostRml: '/editor-assets/internal-preview/layout-fragment-host.rml',
        hostRcss: '/editor-assets/internal-preview/layout-fragment-host.rcss',
      },
    });
  });

  it('admits registered JSON data dependencies and rejects other Asset kinds', () => {
    const project = createAuthoringProject();
    const data = defaultLayoutData('Catalog');
    project.assets.catalog = {
      id: 'catalog',
      label: 'Catalog',
      data: {
        kind: 'data',
        source: { type: 'project-file', path: 'assets/data/Catalog.JSON' },
        aliases: [],
        extension: '.json',
        imageMetadata: null,
      },
    };
    project.layouts.main = {
      id: 'main',
      label: 'Main',
      data: {
        ...data,
        dependencies: {
          ...data.dependencies,
          data: [{ $ref: { collection: 'assets', id: 'catalog' } }],
        },
      },
    };
    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual([]);
    expect(buildLayoutPreviewDocumentData(project, 'main')).toMatchObject({
      dependencies: { data: [{ id: 'catalog', path: 'assets/data/Catalog.JSON' }] },
    });
    (project.assets.catalog.data as { kind: string }).kind = 'text';
    expect(validateLayoutData(project, 'main', project.layouts.main)).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        path: '/layouts/main/data/dependencies/data/0/$ref',
      }),
    );
  });

  it('validates direct RCSS image cursors against the Layout image dependency closure', () => {
    const project = createAuthoringProject();
    project.assets.pointer = {
      id: 'pointer',
      label: 'Pointer',
      data: {
        kind: 'image',
        source: { type: 'project-file', path: 'assets/images/pointer.png' },
        aliases: [],
        sampling: 'nearest',
        extension: '.png',
        imageMetadata: { width: 256, height: 64, hasAlpha: true, orientation: 1 },
      },
    };
    project.assets.notes = {
      id: 'notes',
      label: 'Notes',
      data: {
        kind: 'text',
        source: { type: 'project-file', path: 'assets/text/notes.txt' },
        aliases: [],
        extension: '.txt',
        imageMetadata: null,
      },
    };
    const data = defaultLayoutData('Cursor UI');
    data.dependencies.images = [{ $ref: { collection: 'assets', id: 'pointer' } }];
    data.rcss.sourceText = `
      #quoted { cursor: image("assets/images/pointer.png"); }
      #unquoted { cursor: image(project:/assets/images/pointer.png); }
      #native { cursor: pointer; }
      #automatic { cursor: auto; }
      #dynamic { cursor: var(--cursor); }
    `;
    project.layouts.main = { id: 'main', label: 'Cursor UI', data };

    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual([]);

    data.dependencies.images = [];
    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/layouts/main/data/rcss/sourceText',
          message: expect.stringContaining('image dependency'),
        }),
      ]),
    );

    data.dependencies.images = [{ $ref: { collection: 'assets', id: 'pointer' } }];
    data.rcss.sourceText = `
      #wrong-kind { cursor: image(project:/assets/text/notes.txt); }
      #malformed { cursor: image("assets/images/pointer.png", pointer); }
      #unknown { cursor: poitner; }
    `;
    const diagnostics = validateLayoutData(project, 'main', project.layouts.main);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('not an Image Asset') }),
        expect.objectContaining({ message: expect.stringContaining('exactly one image source') }),
        expect.objectContaining({ message: expect.stringContaining("Unknown cursor 'poitner'") }),
      ]),
    );
  });

  it('reserves the built-in Inventory fallback Layout ID', () => {
    const project = createAuthoringProject();
    project.layouts['builtin-inventory'] = {
      id: 'builtin-inventory',
      label: 'Collision',
      data: defaultLayoutData('Collision'),
    };

    expect(
      validateLayoutData(project, 'builtin-inventory', project.layouts['builtin-inventory']),
    ).toContainEqual(
      expect.objectContaining({
        path: '/layouts/builtin-inventory',
        message: expect.stringContaining('reserved'),
      }),
    );
  });

  it('validates Layout contract input defaults against declared types', () => {
    const project = createAuthoringProject();
    const valid = defaultLayoutData('Main UI');
    valid.contract = {
      inputs: { count: { type: 'integer', nullable: false, defaultValue: 3 } },
      signals: {
        confirm: {
          fields: { accepted: { type: 'boolean', nullable: false, required: true } },
        },
      },
    };
    project.layouts.main = { id: 'main', label: 'Main UI', data: valid };
    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual([]);

    project.layouts.main.data = {
      ...valid,
      contract: {
        ...valid.contract,
        inputs: { count: { type: 'integer', nullable: false, defaultValue: 'three' } },
      },
    };
    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining('/contract/inputs/count/defaultValue'),
          category: 'Layouts',
        }),
      ]),
    );
  });

  it('validates recursive Layout State Shapes and defaults', () => {
    const project = createAuthoringProject();
    const data = defaultLayoutData('Stateful UI');
    data.contract.state = {
      type: 'object',
      nullable: false,
      fields: {
        page: { required: true, shape: { type: 'integer', nullable: false } },
        filters: {
          required: false,
          shape: {
            type: 'array',
            nullable: false,
            items: { type: 'string', nullable: false },
          },
        },
      },
      defaultValue: { page: 1, filters: ['all'] },
    };
    project.layouts.stateful = { id: 'stateful', label: 'Stateful UI', data };
    expect(validateLayoutData(project, 'stateful', project.layouts.stateful)).toEqual([]);

    project.layouts.stateful.data = {
      ...data,
      contract: {
        ...data.contract,
        state: { ...data.contract.state, defaultValue: { page: 'one' } },
      },
    };
    expect(validateLayoutData(project, 'stateful', project.layouts.stateful)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: expect.stringContaining('/contract/state/defaultValue') }),
      ]),
    );
  });

  it('resolves omitted scale policy from the authored target', () => {
    expect(resolveLayoutScalePolicy('scene-overlay', undefined)).toEqual({
      ui: 'ignore',
      text: 'inherit',
    });
    expect(resolveLayoutScalePolicy('room-overlay', undefined)).toEqual({
      ui: 'ignore',
      text: 'inherit',
    });
    expect(resolveLayoutScalePolicy('custom-overlay', undefined)).toEqual({
      ui: 'ignore',
      text: 'inherit',
    });
    expect(resolveLayoutScalePolicy('default-ui', undefined)).toEqual({
      ui: 'inherit',
      text: 'inherit',
    });
    expect(resolveLayoutScalePolicy('scene-overlay', { ui: 'inherit', text: 'ignore' })).toEqual({
      ui: 'inherit',
      text: 'ignore',
    });
  });

  it('diagnoses invalid or empty layout source data', () => {
    const project = createAuthoringProject();
    project.layouts.empty = {
      id: 'empty',
      label: 'Empty',
      data: {
        ...defaultLayoutData('Empty'),
        rml: { sourceMode: 'inline', sourceText: '', sourceAsset: null },
      },
    };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/layouts/empty/data/rml/sourceText',
          category: 'Layouts',
        }),
      ]),
    );
  });

  it('validates system layout references and indexes settings usage', () => {
    const project = createAuthoringProject();
    project.layouts.main = { id: 'main', label: 'Main UI', data: defaultLayoutData('Main UI') };
    project.settings.ui = { systemLayouts: { title: layoutRecordRef('main') } };

    expect(
      validateAuthoringProject(project).filter((diagnostic) => diagnostic.category === 'Layouts'),
    ).toEqual([]);
    expect(findUsages(buildReferenceIndex(project), { collection: 'layouts', id: 'main' })).toEqual(
      [
        expect.objectContaining({
          sourceCollection: 'project',
          sourceId: 'settings',
          path: '/settings/ui/systemLayouts/title/$ref',
        }),
      ],
    );
  });

  it('rejects custom contracts on fixed System Layout Roles', () => {
    const project = createAuthoringProject();
    const data = defaultLayoutData('Main UI');
    data.contract.inputs.title = { type: 'string', nullable: false, defaultValue: 'HUD' };
    project.layouts.main = { id: 'main', label: 'Main UI', data };
    project.settings.ui = { systemLayouts: { title: layoutRecordRef('main') } };

    expect(validateAuthoringProject(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/settings/ui/systemLayouts/title/$ref',
          message: expect.stringContaining('fixed engine contract'),
        }),
      ]),
    );
  });

  it('reports missing dependency refs', () => {
    const project = createAuthoringProject();
    project.layouts.main = {
      id: 'main',
      label: 'Main UI',
      data: {
        ...defaultLayoutData('Main UI'),
        dependencies: {
          images: [{ $ref: { collection: 'assets', id: 'missing-image' } }],
          fonts: [],
          stylesheets: [],
          scripts: [],
          materials: [emptyMaterialApplication('missing-material')],
        },
      },
    };

    expect(validateLayoutData(project, 'main', project.layouts.main)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/layouts/main/data/dependencies/images/0/$ref' }),
        expect.objectContaining({
          path: '/layouts/main/data/dependencies/materials/0/material/$ref',
        }),
      ]),
    );
  });

  it('warns when fragment RML contains full document tags', () => {
    const project = createAuthoringProject();
    project.layouts.widget = {
      id: 'widget',
      label: 'Widget',
      data: {
        ...defaultLayoutData('Widget', 'fragment'),
        rml: {
          sourceMode: 'inline',
          sourceText: '<rml><body><button>Bad fragment</button></body></rml>',
          sourceAsset: null,
        },
      },
    };

    expect(validateLayoutData(project, 'widget', project.layouts.widget)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/layouts/widget/data/rml/sourceText',
          severity: 'warning',
        }),
      ]),
    );
  });
});
