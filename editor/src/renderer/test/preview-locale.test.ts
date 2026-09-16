import { describe, expect, it } from 'vite-plus/test';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import { DEFAULT_PREVIEW_DISPLAY_PREFERENCE } from '../../shared/preview-display';
import { effectivePreviewLocale, projectWithPreviewLocale } from '../../shared/preview-locale';
import {
  PSEUDO_PREVIEW_LOCALE,
  pseudoLocalizeDialogueCues,
  pseudoLocalizePattern,
  pseudoLocalizeText,
  pseudoPreviewRuntimeLocale,
} from '../../shared/pseudo-localization';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { focusedPreviewAdapterFor } from '../preview/focused-preview-adapters';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const PATTERN_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';

describe('Preview Locale', () => {
  it('overrides runtime preview default without mutating the authored Project Default', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: true, parentLocale: null, fontStack: null };
    project.editor.previewLocale = 'fr';

    const preview = projectWithPreviewLocale(project);

    expect(effectivePreviewLocale(project)).toBe('fr');
    expect(preview.localization.defaultLocale).toBe('fr');
    expect(project.localization.defaultLocale).toBe('en');
    expect(preview.localization.sourceLocale).toBe(project.localization.sourceLocale);
  });

  it('allows a declared work-in-progress locale for preview without changing Project support', () => {
    const project = createAuthoringProject();
    project.localization.locales.fr = { supported: false, parentLocale: null, fontStack: null };
    project.editor.previewLocale = 'fr';

    const preview = projectWithPreviewLocale(project);
    expect(effectivePreviewLocale(project)).toBe('fr');
    expect(preview.localization.defaultLocale).toBe('fr');
    expect(preview.localization.locales.fr?.supported).toBe(true);
    expect(project.localization.locales.fr?.supported).toBe(false);
  });

  it('falls back to the Project Default when the editor selection is no longer declared', () => {
    const project = createAuthoringProject();
    project.editor.previewLocale = 'fr';

    expect(effectivePreviewLocale(project)).toBe('en');
    expect(projectWithPreviewLocale(project)).toBe(project);
  });

  it('pseudo-localizes visible text while preserving placeholders and markup structure', () => {
    const semanticToken = '[nt-cue id=voice kind=voice data=%7B%7D]';
    const source = `Hello {name}, <em>open</em> &amp; [shake]now[/shake]! ${semanticToken}`;
    const pseudo = pseudoLocalizeText(source).text;

    expect(pseudo.startsWith('⟦')).toBe(true);
    expect(pseudo.endsWith('⟧')).toBe(true);
    expect(pseudo).toContain('{name}');
    expect(pseudo).toContain('<em>');
    expect(pseudo).toContain('</em>');
    expect(pseudo).toContain('&amp;');
    expect(pseudo).toContain('[shake]');
    expect(pseudo).toContain('[/shake]');
    expect(pseudo).toContain(semanticToken);
    expect(Array.from(pseudo).length).toBeGreaterThan(Array.from(source).length);
  });

  it('preserves plural/select structure and remaps semantic Cue offsets through expansion', () => {
    const pattern = {
      kind: 'plural' as const,
      argument: 'count',
      cases: {
        one: { kind: 'text' as const, text: 'One {count} item' },
        other: {
          kind: 'select' as const,
          argument: 'kind',
          cases: {
            rare: { kind: 'text' as const, text: 'Rare {count} items' },
            other: { kind: 'text' as const, text: '{count} items' },
          },
        },
      },
    };
    const pseudo = pseudoLocalizePattern(pattern);

    expect(pseudo.kind).toBe('plural');
    if (pseudo.kind !== 'plural') return;
    expect(Object.keys(pseudo.cases)).toEqual(['one', 'other']);
    expect(pseudo.cases.one).toMatchObject({ kind: 'text' });
    expect((pseudo.cases.one as { kind: 'text'; text: string }).text).toContain('{count}');
    expect(pseudo.cases.other).toMatchObject({ kind: 'select' });

    const cues = pseudoLocalizeDialogueCues('Open door', [
      { id: 'before-door', position: { offset: 5, order: 0 } },
      { id: 'after-line', position: { offset: 9, order: 0 } },
    ]);
    expect(cues.map((cue) => cue.id)).toEqual(['before-door', 'after-line']);
    expect(cues[0]!.position.offset).toBeGreaterThan(5);
    expect(cues[1]!.position.offset).toBeGreaterThan(cues[0]!.position.offset);
  });

  it('includes the Project cursor registry and source artwork in focused Layout preview', async () => {
    const project = createAuthoringProject();
    project.assets.pointer = {
      id: 'pointer',
      label: 'Pointer',
      data: assetDataFromImportMetadata({
        kind: 'image',
        projectRelativePath: 'assets/images/pointer.png',
        extension: '.png',
        byteSize: 128,
        contentHash: `sha256:${'a'.repeat(64)}`,
        imageMetadata: { width: 32, height: 24, hasAlpha: true, orientation: 1 },
      }),
    };
    project.settings.cursors = {
      defaults: {
        default: { kind: 'system', cursor: 'default' },
        pointer: { kind: 'named', id: 'tea-pointer' },
        hotspot: { kind: 'inherit', semantic: 'pointer' },
      },
      named: [
        {
          id: 'tea-pointer',
          image: { $ref: { collection: 'assets', id: 'pointer' } },
          hotspotX: 2,
          hotspotY: 3,
        },
      ],
    };
    const layout = defaultLayoutData('Cursor Preview', 'document');
    layout.rcss.sourceText = '#target { cursor: tea-pointer; }';
    project.layouts.cursor = { id: 'cursor', label: 'Cursor Preview', data: layout };

    const document = await focusedPreviewAdapterFor('layout-preview').build({
      project,
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: 'project-instance',
      projectRevision: 1,
      root: { kind: 'layout-preview', recordId: 'cursor' },
      inputs: { displayPreference: DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
      inputRevision: `sha256:${'0'.repeat(64)}`,
      graph: null,
      sourceAnalysis: [],
      hostCapabilities: { activeShaderVariant: 'glsl-120' },
    });

    expect(document.resources).toContainEqual(
      expect.objectContaining({ assetId: 'pointer', usageRoles: ['project-cursor'] }),
    );
    expect(document.data.cursors).toEqual({
      defaultCursor: 'default',
      pointerCursor: 'tea-pointer',
      hotspotCursor: 'tea-pointer',
      named: [
        {
          id: 'tea-pointer',
          logicalPath: 'project:/assets/images/pointer.png',
          width: 32,
          height: 24,
          hotspotX: 2,
          hotspotY: 3,
        },
      ],
    });
  });

  it('materializes pseudo-localized live RML source in focused Layout preview', async () => {
    const project = createAuthoringProject();
    project.localization.messages[MESSAGE_ID] = {
      kind: 'named',
      key: 'ui.preview.greeting',
      source: 'Hello {name}',
      arguments: { name: 'string' },
    };
    const layout = defaultLayoutData('Pseudo RML', 'document');
    layout.rml.sourceText =
      `<rml><head></head><body><nt-tr>Hello <em>traveler</em> &amp; friend.</nt-tr>` +
      `<nt-tr key="ui.preview.greeting" arg-name="{{ score > 0 and 'Ada' or 'Lin' }}"/></body></rml>`;
    project.layouts.pseudo = { id: 'pseudo', label: 'Pseudo RML', data: layout };
    project.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;

    const document = await focusedPreviewAdapterFor('layout-preview').build({
      project,
      projectSessionId: '11111111-1111-4111-8111-111111111111',
      projectInstanceId: 'project-instance',
      projectRevision: 1,
      root: { kind: 'layout-preview', recordId: 'pseudo' },
      inputs: { displayPreference: DEFAULT_PREVIEW_DISPLAY_PREFERENCE },
      inputRevision: `sha256:${'0'.repeat(64)}`,
      graph: null,
      sourceAnalysis: [],
      hostCapabilities: { activeShaderVariant: 'glsl-330' },
    });

    expect(document.kind).toBe('layout-preview');
    if (document.kind !== 'layout-preview') return;
    const data = document.data as { rml: { kind: string; text?: string } };
    expect(data.rml.kind).toBe('inline');
    if (data.rml.kind !== 'inline') return;
    expect(data.rml.text).toContain('<em>');
    expect(data.rml.text).toContain('</em>');
    expect(data.rml.text).toContain('&amp;');
    expect(data.rml.text).toContain('{name}');
    expect(data.rml.text).toContain(`arg-name="{{ score > 0 and 'Ada' or 'Lin' }}"`);
    expect(data.rml.text?.match(/⟦/gu)?.length).toBe(2);
    expect(project.layouts.pseudo?.data.rml.sourceText).not.toContain('⟦');
  });

  it('generates pseudo only in the detached Play project and compiles it as the active catalog', () => {
    const project = createAuthoringProject();
    const room = defaultRoomData('foyer');
    room.description.source = { kind: 'inline', text: 'A quiet foyer' };
    project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: room };
    project.entrypoint = { kind: 'room', id: 'foyer' };
    project.localization.messages[MESSAGE_ID] = {
      kind: 'named',
      key: 'ui.preview.greeting',
      source: 'Hello {name}',
      arguments: { name: 'string' },
    };
    project.localization.messages[PATTERN_MESSAGE_ID] = {
      kind: 'named',
      key: 'ui.preview.items',
      source: '{count} items',
      arguments: { count: 'plural-number' },
      pattern: {
        kind: 'plural',
        argument: 'count',
        cases: {
          one: { kind: 'text', text: 'One {count} item' },
          other: { kind: 'text', text: '{count} items' },
        },
      },
    };
    const layout = defaultLayoutData('Pseudo RML', 'document');
    layout.rml.sourceText =
      '<rml><head></head><body><nt-tr arg-name="Ada">Hello <em>{name}</em>.</nt-tr></body></rml>';
    project.layouts.pseudo = { id: 'pseudo', label: 'Pseudo RML', data: layout };
    project.editor.previewLocale = PSEUDO_PREVIEW_LOCALE;

    const runtimeLocale = pseudoPreviewRuntimeLocale(project.localization.sourceLocale);
    const preview = projectWithPreviewLocale(project);

    expect(effectivePreviewLocale(project)).toBe(PSEUDO_PREVIEW_LOCALE);
    expect(preview.localization.defaultLocale).toBe(runtimeLocale);
    expect(preview.localization.locales[runtimeLocale]).toMatchObject({
      supported: true,
      parentLocale: project.localization.sourceLocale,
    });
    expect(preview.localization.translations[runtimeLocale]?.[MESSAGE_ID]?.text).toContain(
      '{name}',
    );

    expect(project.localization.defaultLocale).toBe('en');
    expect(project.localization.locales[runtimeLocale]).toBeUndefined();
    expect(project.localization.translations[runtimeLocale]).toBeUndefined();

    const compiled = compileAuthoringProject(preview);
    expect(compiled.ok, JSON.stringify(compiled.ok ? [] : compiled.diagnostics)).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.project.localization.defaultLocale).toBe(runtimeLocale);
    const pseudoCatalog = compiled.project.localization.catalogs.find(
      (catalog) => catalog.locale === runtimeLocale,
    );
    expect(pseudoCatalog).toBeDefined();
    expect(pseudoCatalog?.entries.some((entry) => entry.value.includes('{name}'))).toBe(true);
    expect(
      pseudoCatalog?.entries.some(
        (entry) => entry.value.includes('<em>') && entry.value.includes('{name}'),
      ),
    ).toBe(true);
    expect(
      pseudoCatalog?.entries.some(
        (entry) =>
          entry.pattern?.nodes.some(
            (node) =>
              node.kind === 'text' && node.text.includes('{count}') && node.text.includes('⟦'),
          ) === true,
      ),
    ).toBe(true);
    const compiledRml = compiled.project.resources.layouts.find(
      (entry) => entry.id === 'pseudo',
    )?.rml;
    expect(compiledRml?.kind).toBe('inline');
    if (compiledRml?.kind === 'inline') {
      expect(compiledRml.text).toMatch(/<nt-tr\s+arg-name="Ada"\s+message="\d+"><\/nt-tr>/u);
      expect(compiledRml.text).not.toContain('⟦');
    }

    const shipping = compileAuthoringProject(project);
    expect(shipping.ok).toBe(true);
    if (!shipping.ok) return;
    expect(
      shipping.project.localization.locales.some((locale) => locale.locale === runtimeLocale),
    ).toBe(false);
    expect(
      shipping.project.localization.catalogs.some((catalog) => catalog.locale === runtimeLocale),
    ).toBe(false);
  });
});
