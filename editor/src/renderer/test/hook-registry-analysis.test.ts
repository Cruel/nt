import { describe, expect, it } from 'vite-plus/test';
import { analyzeHookRegistry } from '../../shared/hook-registry-analysis';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData, roomDataSchema } from '../../shared/project-schema/authoring-rooms';

function addScript(project: ReturnType<typeof createAuthoringProject>, id: string, source: string) {
  project.scripts[id] = {
    id,
    label: id,
    data: { kind: 'script-module', source: { kind: 'inline-lua', source } },
  };
}

function addRoom(project: ReturnType<typeof createAuthoringProject>, id: string) {
  project.rooms[id] = { id, label: id, data: defaultRoomData(id) };
  return project.rooms[id].data;
}

describe('typed Hook Registry analysis', () => {
  it('resolves exact, longest qualified-prefix, and catchall mappings deterministically', () => {
    const project = createAuthoringProject();
    addScript(project, 'direct-hooks', 'return { before_enter = function() end }');
    addScript(project, 'prefix-hooks', 'return { before_enter = function() end }');
    addScript(project, 'catchall-hooks', 'return { before_enter = function() end }');
    const room = addRoom(project, 'foyer');
    room.scriptHooks.push({
      hook: 'before-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'direct-hooks' } },
        export: 'before_enter',
      },
    });
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `hooks.register('room', 'before-enter', 'chapter.*', 'prefix-hooks', 'before_enter')`,
          `hooks.register('room', 'before-enter', '*', 'catchall-hooks', 'before_enter')`,
          'return {}',
        ].join('\n'),
      },
    };

    const analysis = analyzeHookRegistry(project);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.dynamicUncertainty).toBe(false);

    const exact = analysis.explain('before-enter', 'foyer');
    expect(exact.winner).toMatchObject({
      source: 'direct-definition',
      moduleId: 'direct-hooks',
      capabilityProfile: 'gameplay-effect',
    });
    expect(exact.fallbacks.map((item) => item.moduleId)).toEqual(['catchall-hooks']);

    const prefix = analysis.explain('before-enter', 'chapter.scene-one');
    expect(prefix.winner).toMatchObject({
      source: 'bootstrap',
      moduleId: 'prefix-hooks',
      selector: { kind: 'qualified-prefix', authored: 'chapter.*' },
    });
    expect(prefix.fallbacks.map((item) => item.moduleId)).toEqual(['catchall-hooks']);

    expect(analysis.explain('before-enter', 'elsewhere').winner?.moduleId).toBe('catchall-hooks');
  });

  it('reports duplicate literal mappings and structurally knowable invalid registrations', () => {
    const project = createAuthoringProject();
    addScript(project, 'room-hooks', 'return { guard = function() return true end }');
    const room = addRoom(project, 'foyer');
    room.scriptHooks.push({
      hook: 'can-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'room-hooks' } },
        export: 'guard',
      },
    });
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `hooks.register('room', 'can-enter', 'foyer', 'room-hooks', 'guard')`,
          `hooks.register('entity', 'can-enter', '*', 'room-hooks', 'guard')`,
          `hooks.register('room', 'can-enter', 'bad*selector', 'missing-hooks', 'guard')`,
          'return {}',
        ].join('\n'),
      },
    };

    const analysis = analyzeHookRegistry(project);
    expect(analysis.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'script.duplicate_hook_mapping' }),
        expect.objectContaining({ code: 'script.invalid_hook_semantic_kind' }),
        expect.objectContaining({ code: 'script.invalid_hook_selector' }),
      ]),
    );
    expect(analysis.explain('can-enter', 'foyer').winner).toBeUndefined();
    expect(analysis.explain('can-enter', 'foyer').conflicts).toHaveLength(2);
  });

  it('marks non-literal Bootstrap registration as dynamic uncertainty', () => {
    const project = createAuthoringProject();
    addScript(project, 'room-hooks', 'return { guard = function() return true end }');
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `local selector = '*'`,
          `hooks.register('room', 'can-enter', selector, 'room-hooks', 'guard')`,
          'return {}',
        ].join('\n'),
      },
    };

    const analysis = analyzeHookRegistry(project);
    expect(analysis.dynamicUncertainty).toBe(true);
    expect(analysis.explain('can-enter', 'foyer').dynamicUncertainty).toBe(true);
  });

  it('requires scriptHooks in the current authoring Room shape without a schema-version bump', () => {
    const room = defaultRoomData('Foyer');
    const legacyShape = { ...room } as Record<string, unknown>;
    delete legacyShape.scriptHooks;
    expect(roomDataSchema.safeParse(legacyShape).success).toBe(false);
    expect(roomDataSchema.safeParse(room).success).toBe(true);
  });
});
