import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { HookRegistryResolutionInspector } from '@/components/HookRegistryResolutionInspector';
import { analyzeHookRegistry } from '../../shared/hook-registry-analysis';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

function addScript(project: ReturnType<typeof createAuthoringProject>, id: string) {
  project.scripts[id] = {
    id,
    label: id,
    data: {
      kind: 'script-module',
      source: { kind: 'inline-lua', source: 'return { handler = function() end }' },
    },
  };
}

function addRoom(project: ReturnType<typeof createAuthoringProject>, id: string) {
  project.rooms[id] = { id, label: id, data: defaultRoomData(id) };
  return project.rooms[id].data;
}

describe('HookRegistryResolutionInspector', () => {
  it('shows the exact winner and ordered qualified-prefix and catchall fallbacks', () => {
    const project = createAuthoringProject();
    addScript(project, 'exact-hooks');
    addScript(project, 'prefix-hooks');
    addScript(project, 'catchall-hooks');
    const room = addRoom(project, 'chapter.foyer');
    room.scriptHooks.push({
      hook: 'before-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'exact-hooks' } },
        export: 'handler',
      },
    });
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `hooks.register('room', 'before-enter', 'chapter.*', 'prefix-hooks', 'handler')`,
          `hooks.register('room', 'before-enter', '*', 'catchall-hooks', 'handler')`,
          'return {}',
        ].join('\n'),
      },
    };

    render(
      <HookRegistryResolutionInspector
        analysis={analyzeHookRegistry(project)}
        hook="before-enter"
        target="chapter.foyer"
      />,
    );

    expect(screen.getByText('exact-hooks.handler')).toBeInTheDocument();
    expect(screen.getByText('Room definition')).toBeInTheDocument();
    expect(screen.getAllByText('gameplay-effect')).toHaveLength(3);
    expect(screen.getAllByText('chapter.foyer').length).toBeGreaterThanOrEqual(1);
    const fallbacks = screen.getAllByTestId('hook-registry-fallback');
    expect(fallbacks).toHaveLength(2);
    expect(fallbacks[0]).toHaveTextContent('chapter.*');
    expect(fallbacks[0]).toHaveTextContent('prefix-hooks.handler');
    expect(fallbacks[1]).toHaveTextContent('*');
    expect(fallbacks[1]).toHaveTextContent('catchall-hooks.handler');
  });

  it('surfaces ambiguous competing registrations', () => {
    const project = createAuthoringProject();
    addScript(project, 'direct-hooks');
    addScript(project, 'bootstrap-hooks');
    const room = addRoom(project, 'foyer');
    room.scriptHooks.push({
      hook: 'can-enter',
      handler: {
        module: { $ref: { collection: 'scripts', id: 'direct-hooks' } },
        export: 'handler',
      },
    });
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `hooks.register('room', 'can-enter', 'foyer', 'bootstrap-hooks', 'handler')`,
          'return {}',
        ].join('\n'),
      },
    };

    render(
      <HookRegistryResolutionInspector
        analysis={analyzeHookRegistry(project)}
        hook="can-enter"
        target="foyer"
      />,
    );

    expect(screen.getByText('Ambiguous static resolution')).toBeInTheDocument();
    expect(screen.getAllByTestId('hook-registry-conflict')).toHaveLength(2);
    expect(screen.getByText('direct-hooks.handler')).toBeInTheDocument();
    expect(screen.getByText('bootstrap-hooks.handler')).toBeInTheDocument();
    expect(screen.getAllByText('synchronous-expression')).toHaveLength(2);
  });

  it('warns when dynamic Bootstrap behavior makes static resolution incomplete', () => {
    const project = createAuthoringProject();
    addScript(project, 'room-hooks');
    addRoom(project, 'foyer');
    project.scripts.bootstrap.data = {
      kind: 'script-module',
      source: {
        kind: 'inline-lua',
        source: [
          `local selector = '*'`,
          `hooks.register('room', 'after-enter', selector, 'room-hooks', 'handler')`,
          'return {}',
        ].join('\n'),
      },
    };

    render(
      <HookRegistryResolutionInspector
        analysis={analyzeHookRegistry(project)}
        hook="after-enter"
        target="foyer"
      />,
    );

    expect(screen.getAllByText('Static result may be incomplete')).toHaveLength(2);
    expect(
      screen.getByText(/dynamic Bootstrap registration or import behavior/i),
    ).toBeInTheDocument();
  });
});
