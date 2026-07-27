import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import {
  FOCUSED_EDITOR_DOCUMENT_LIMITS,
  FOCUSED_PREVIEW_RESOURCE_LIMITS,
  appliedPreviewDocumentResultSchema,
  encodeFocusedEditorDocumentRequest,
  focusedEditorDocumentRequestEnvelopeSchema,
  focusedPreviewRequestSchema,
  focusedRecordPreviewDocumentSchema,
  layoutPreviewInputsSchema,
  previewResourceManifestEntrySchema,
  projectNativeManifest,
  roomPreviewInputsSchema,
  shaderPreviewInputsSchema,
} from '../../shared/focused-preview-contracts';
import {
  AUTHORING_SOURCE_ANALYZER_VERSION,
  AUTHORING_LUA_EXECUTION_SURFACES,
  LUA_REFERENCE_ANALYSIS_LIMITS,
  isSupportedLuaExplicitFallbackOwner,
  luaExplicitDependenciesSchema,
  validateLuaExplicitFallbackOwner,
} from '../../shared/project-schema/authoring-lua-analysis';
import { conditionSchema, textSourceSchema } from '../../shared/project-schema/authoring-flow';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';
import { roomPreviewDocumentV2Schema } from '../../shared/project-schema/room-preview-v2';
import { defaultLayoutData, layoutDataSchema } from '../../shared/project-schema/authoring-layouts';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultScriptModuleData } from '../../shared/project-schema/authoring-script-modules';
import {
  shaderDataSchema,
  shaderStageDataSchema,
} from '../../shared/project-schema/authoring-shaders';
import { shaderVariantValues } from '../../shared/shader-variants';

const hash = `sha256:${'a'.repeat(64)}`;

describe('Phase 1 shared contracts', () => {
  it('keeps focused limits and shader variants closed and in native parity', () => {
    expect(shaderVariantValues).toEqual(['glsl-120', 'essl-100', 'essl-300']);
    expect(FOCUSED_PREVIEW_RESOURCE_LIMITS).toEqual({
      maxResourceBytes: 134_217_728,
      maxTotalResourceBytes: 536_870_912,
    });
    expect(FOCUSED_EDITOR_DOCUMENT_LIMITS).toEqual({
      maxRequestBytes: 16_777_216,
      maxSourceBytes: 4_194_304,
      maxStringBytes: 16_384,
      maxJsonDepth: 64,
      maxLayouts: 512,
      maxResources: 16_384,
      maxItemsPerArray: 8_192,
      maxAdmissionItemsPerSource: 8_192,
    });
    const header = fs.readFileSync(
      path.resolve('../engine/include/noveltea/core/editor_preview_contracts.hpp'),
      'utf8',
    );
    expect(header).toContain('kFocusedPreviewMaxResourceBytes = 128U * 1024U * 1024U');
    expect(header).toContain('kFocusedPreviewMaxTotalResourceBytes = 512U * 1024U * 1024U');
    expect(header).toMatch(
      /struct FocusedEditorManifestProjection \{[\s\S]*std::string resource_id;[\s\S]*std::string source_kind;[\s\S]*std::string logical_path;[\s\S]*std::string content_hash;[\s\S]*std::uint64_t byte_size = 0;[\s\S]*std::string kind;[\s\S]*std::optional<std::string> sampling;/,
    );
    expect(header).toContain('max_request_bytes = 16U * 1024U * 1024U');
    expect(header).toContain('max_source_bytes = 4U * 1024U * 1024U');
    expect(header).toContain('max_string_bytes = 16U * 1024U');
    expect(header).toContain('max_json_depth = 64U');
    expect(header).toContain('max_layouts = 512U');
    expect(header).toContain("max_resources = 16'384U");
    expect(header).toContain("max_items_per_array = 8'192U");
    expect(header).toContain("max_admission_items_per_source = 8'192U");
  });

  it('strictly validates focused documents, manifests, and apply results', () => {
    const manifest = previewResourceManifestEntrySchema.parse({
      resourceId: 'asset:image',
      sourceKind: 'authoring-asset',
      assetId: 'image',
      kind: 'image',
      usageRoles: ['room-background'],
      fetchProjectRelativePath: 'assets/image.png',
      logicalPath: 'project:/assets/image.png',
      contentHash: hash,
      byteSize: 12,
    });
    expect(projectNativeManifest([manifest])).toEqual([
      {
        resourceId: 'asset:image',
        sourceKind: 'authoring-asset',
        logicalPath: 'project:/assets/image.png',
        contentHash: hash,
        byteSize: 12,
        kind: 'image',
        assetId: 'image',
      },
    ]);
    const request = focusedEditorDocumentRequestEnvelopeSchema.parse({
      protocol: 'noveltea.focused-editor-document',
      protocolVersion: 1,
      requestId: 'request-1',
      applySequence: 1,
      projectInstanceId: 'project',
      resourceStageGeneration: 1,
      kind: 'layout-preview',
      recordId: 'layout',
      revision: hash,
      resourceRevision: hash,
      resources: projectNativeManifest([manifest]),
      data: {},
    });
    expect(encodeFocusedEditorDocumentRequest(request)).toContain('"protocolVersion":1');
    expect(() =>
      previewResourceManifestEntrySchema.parse({ ...manifest, unknown: true }),
    ).toThrow();
    expect(() =>
      focusedRecordPreviewDocumentSchema.parse({
        kind: 'room-preview',
        recordId: 'room',
        revision: hash,
        projectInstanceId: 'project',
        projectRevision: 1,
        inputRevision: hash,
        resourceRevision: hash,
        resources: [manifest],
        data: {},
        unknown: true,
      }),
    ).toThrow();
    expect(
      appliedPreviewDocumentResultSchema.parse({
        disposition: 'applied',
        projectInstanceId: 'project',
        kind: 'room-preview',
        recordId: 'room',
        revision: hash,
        resourceStageGeneration: 1,
      }).disposition,
    ).toBe('applied');
    const roomRequest = focusedPreviewRequestSchema(roomPreviewInputsSchema).parse({
      root: { kind: 'room-preview', recordId: 'room' },
      inputs: { displayPreference: { mode: 'project' } },
    });
    expect(roomRequest.root.recordId).toBe('room');
    expect(
      layoutPreviewInputsSchema.parse({
        displayPreference: {
          mode: 'custom',
          aspectRatio: { width: 16, height: 9 },
          orientation: 'landscape',
        },
      }),
    ).toBeTruthy();
    expect(shaderPreviewInputsSchema.parse({})).toEqual({});
    expect(() => shaderPreviewInputsSchema.parse({ variant: 'glsl-120' })).toThrow();
    expect(() =>
      roomPreviewInputsSchema.parse({ displayPreference: { mode: 'project' }, unknown: true }),
    ).toThrow();
  });

  it('keeps legacy Shader compiled references readable while admitting complete metadata', () => {
    expect(
      shaderStageDataSchema.parse({
        stage: 'fragment',
        compiled: { 'glsl-120': 'project:/shaders/bgfx/glsl-120/noise.fs.bin' },
      }).compiled['glsl-120'],
    ).toBe('project:/shaders/bgfx/glsl-120/noise.fs.bin');
    expect(
      shaderStageDataSchema.parse({
        stage: 'fragment',
        compiled: {
          'glsl-120': {
            path: 'project:/shaders/bgfx/glsl-120/noise.fs.bin',
            byteHash: hash,
          },
        },
      }).compiled['glsl-120'],
    ).toMatchObject({ byteHash: hash });
    expect(
      shaderStageDataSchema.parse({
        stage: 'fragment',
        compiled: {
          'glsl-120': {
            path: 'project:/shaders/bgfx/glsl-120/noise.fs.bin',
            byteHash: hash,
            byteSize: 12,
            compileInputFingerprint: `sha256:${'b'.repeat(64)}`,
          },
        },
      }).compiled['glsl-120'],
    ).toMatchObject({ byteHash: hash, byteSize: 12 });
  });

  it('rejects non-canonical and shared compiled Shader stage outputs during authoring validation', () => {
    expect(() =>
      shaderDataSchema.parse({
        stages: [
          {
            stage: 'fragment',
            compiled: { 'glsl-120': 'project:/../outside.bin' },
          },
        ],
      }),
    ).toThrow(/not a canonical runtime Shader path/);
    expect(() =>
      shaderDataSchema.parse({
        stages: [
          {
            stage: 'vertex',
            compiled: { 'glsl-120': 'shaders/bgfx/glsl-120/shared.bin' },
          },
          {
            stage: 'fragment',
            compiled: { 'glsl-120': 'project:/shaders/bgfx/glsl-120/shared.bin' },
          },
        ],
      }),
    ).toThrow(/duplicates stage 0/);
  });

  it('pins the complete source-analysis contract and accepts explicit fallback metadata', () => {
    expect(AUTHORING_SOURCE_ANALYZER_VERSION).toBe('lua-rml-v1');
    expect(LUA_REFERENCE_ANALYSIS_LIMITS.maxSnapshotBytes).toBe(64 * 1024 * 1024);
    const dependency = luaExplicitDependenciesSchema.parse({
      targets: [{ kind: 'record', collection: 'rooms', id: 'hall' }],
    });
    expect(luaExplicitDependenciesSchema.parse(dependency)).toEqual(dependency);
    expect(
      conditionSchema.parse({
        kind: 'lua-predicate',
        source: 'can_enter()',
        additionalDependencies: dependency,
      }),
    ).toMatchObject({ additionalDependencies: dependency });
    expect(
      textSourceSchema.parse({
        kind: 'lua-expression',
        source: 'label()',
        additionalDependencies: dependency,
      }),
    ).toMatchObject({ additionalDependencies: dependency });
    expect(conditionSchema.parse({ kind: 'lua-predicate', source: 'can_enter()' })).toMatchObject({
      additionalDependencies: { targets: [] },
    });
    expect(textSourceSchema.parse({ kind: 'lua-expression', source: 'label()' })).toMatchObject({
      additionalDependencies: { targets: [] },
    });
    const room = defaultRoomData('Room');
    expect(
      roomDataSchema.parse({
        ...room,
        compose: { script: { $ref: { collection: 'scripts', id: 'compose' } } },
      }).compose,
    ).toMatchObject({ additionalDependencies: { targets: [] } });
    const layout = defaultLayoutData('Layout');
    expect(
      layoutDataSchema.parse({
        ...layout,
        script: { enabled: true },
      }).script,
    ).toMatchObject({ additionalDependencies: { targets: [] } });
    expect(AUTHORING_LUA_EXECUTION_SURFACES).toEqual([
      'project-startup-hook',
      'script-record',
      'layout-rml',
      'layout-dedicated-lua',
      'room-composition-script',
      'shared-lua-predicate',
      'shared-lua-expression',
      'shared-run-lua-effect',
      'scene-run-lua-step',
      'dialogue-run-lua-segment',
      'test-init-script',
      'test-check-script',
    ]);
    expect(isSupportedLuaExplicitFallbackOwner('/rooms/room/data/exits/0/condition')).toBe(true);
    expect(isSupportedLuaExplicitFallbackOwner('/rooms/room/data/compose')).toBe(true);
    expect(isSupportedLuaExplicitFallbackOwner('/layouts/hud/data/script')).toBe(true);
    expect(isSupportedLuaExplicitFallbackOwner('/rooms/room/data/lifecycle/canEnter')).toBe(false);
    expect(validateLuaExplicitFallbackOwner('/verbs/use/data/availability', dependency)).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
    expect(validateLuaExplicitFallbackOwner('/scenes/intro/data/steps/0', dependency)).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
  });

  it('keeps focused preview contracts free of compiled publication imports', () => {
    for (const relative of [
      'src/shared/focused-preview-contracts.ts',
      'src/shared/project-schema/authoring-lua-analysis.ts',
      'src/shared/authoring-dependency-contracts.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(relative), 'utf8');
      expect(source).not.toMatch(
        /authoring-compiler|compiled-runtime-export|compiled-artifact-publication/,
      );
    }
  });

  it('defines the production Room v2 document strictly', () => {
    const base = {
      schema: 'noveltea.room-preview',
      schemaVersion: 2,
      environment: {
        profile: { name: 'Desktop', nativeResolution: { width: 1920, height: 1080 } },
        project: {
          referenceResolution: { width: 1920, height: 1080 },
          worldRasterPolicy: 'capped',
          barColor: '#000000',
          accessibility: {
            uiScale: { enabled: true, minimum: 0.75, maximum: 1.5 },
            textScale: { enabled: true, minimum: 0.75, maximum: 1.5 },
          },
        },
      },
      room: {
        roomId: 'room',
        recordLabel: 'Room',
        displayName: 'Room',
        visit: { visitIndex: 1, sourceRoomId: null, entryExitId: null },
      },
      luaAdmission: {
        definitions: [],
        variableIds: [],
        properties: [],
        interactableLocationIds: [],
        compositionDraftCharacterIds: [],
        compositionDraftInteractableIds: [],
      },
      queryState: { variables: [], properties: [], definitions: [], interactableLocations: [] },
      shaderMaterials: { schema: 'noveltea.shader-materials.v1', shaders: {}, materials: {} },
      world: {
        background: { assetId: null, materialId: null, fit: 'cover', color: null },
        placements: [],
        persistentCharacters: [],
        cast: [],
        interactables: [],
        props: [],
        environments: [],
        overlays: [],
      },
      layouts: [
        {
          instanceId: 'game-hud',
          layoutId: null,
          mount: { kind: 'game-hud' },
          source: { kind: 'builtin-game-hud' },
          scriptEnabled: false,
          containsDedicatedLuaSource: false,
          containsExecutableRmlLua: false,
          scalePolicy: { ui: 'inherit', text: 'inherit' },
        },
      ],
      ui: {
        description: { markup: 'plain', source: { kind: 'resolved', text: '' } },
        exits: [],
      },
      composition: null,
    } as const;
    expect(roomPreviewDocumentV2Schema.parse(base).schemaVersion).toBe(2);
    expect(() => roomPreviewDocumentV2Schema.parse({ ...base, unknown: true })).toThrow();
    expect(() =>
      roomPreviewDocumentV2Schema.parse({
        ...base,
        environment: {
          ...base.environment,
          profile: { ...base.environment.profile, unknown: true },
        },
      }),
    ).toThrow();
    expect(() =>
      roomPreviewDocumentV2Schema.parse({
        ...base,
        world: { ...base.world, background: { ...base.world.background, unknown: true } },
      }),
    ).toThrow();
    expect(() =>
      roomPreviewDocumentV2Schema.parse({
        ...base,
        world: { ...base.world, background: undefined },
      }),
    ).toThrow();
    expect(() =>
      roomPreviewDocumentV2Schema.parse({
        ...base,
        layouts: [
          {
            instanceId: 'game-hud',
            layoutId: null,
            mount: { kind: 'game-hud' },
            source: { kind: 'builtin-game-hud' },
            scriptEnabled: false,
            containsDedicatedLuaSource: false,
            containsExecutableRmlLua: false,
            scalePolicy: { ui: 'inherit', text: 'inherit', unknown: true },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      roomPreviewDocumentV2Schema.parse({
        ...base,
        composition: { scriptId: 'compose', source: { kind: 'inline' } },
      }),
    ).toThrow();
    const protocol = fs.readFileSync(path.resolve('src/shared/preview-protocol.ts'), 'utf8');
    expect(protocol).not.toContain('schemaVersion: 2');
  });

  it('adds Layout templates and fallback metadata without changing compiled gameplay bytes', () => {
    const project = createAuthoringProject({ id: 'metadata', name: 'Metadata' });
    const room = defaultRoomData('Room');
    room.description.source = { kind: 'lua-expression', source: 'label()' };
    room.compose = { script: { $ref: { collection: 'scripts', id: 'compose' } } };
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.scripts.compose = {
      id: 'compose',
      label: 'Compose',
      data: defaultScriptModuleData(),
    };
    const layout = defaultLayoutData('Layout');
    project.layouts.layout = { id: 'layout', label: 'Layout', data: layout };
    project.entrypoint = { kind: 'room', id: 'room' };
    const before = compileAuthoringProject(project);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    project.rooms.room!.data = roomDataSchema.parse({
      ...room,
      compose: {
        ...room.compose,
        additionalDependencies: { targets: [] },
      },
      description: {
        ...room.description,
        source: {
          ...room.description.source,
          additionalDependencies: { targets: [] },
        },
      },
    });
    project.layouts.layout!.data = layoutDataSchema.parse({
      ...layout,
      script: { ...layout.script, additionalDependencies: { targets: [] } },
      dependencies: { ...layout.dependencies, templates: [] },
    });
    expect(project.layouts.layout.data.dependencies.templates).toEqual([]);
    const after = compileAuthoringProject(project);
    expect(after.ok, JSON.stringify(after.diagnostics)).toBe(true);
    if (!after.ok) return;
    const clean = JSON.parse(after.canonicalJson);
    expect(JSON.stringify(clean)).not.toContain('additionalDependencies');
    expect(JSON.stringify(clean)).not.toContain('templates');
    expect(after.canonicalJson).toBe(before.canonicalJson);
  });
});
