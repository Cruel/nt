import { describe, expect, it } from 'vite-plus/test';
import { createInitialCommandBusState, executeCommand, undoCommand } from './command-test-utils';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { validateProjectSettingsAuthoringState } from '../../shared/project-schema/authoring-project-settings';

function projectWithSettingsTargets() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', data: defaultRoomData('Foyer') };
  project.layouts.main = {
    id: 'main',
    label: 'Main Layout',
    data: defaultLayoutData('Main Layout'),
  };
  project.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    data: {
      kind: 'font',
      source: { type: 'project-file', path: 'assets/fonts/main.ttf' },
      aliases: [],
      extension: '.ttf',
    },
  };
  project.assets.logo = {
    id: 'logo',
    label: 'Logo',
    data: {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/logo.png' },
      aliases: [],
      extension: '.png',
    },
  };
  return project;
}

describe('project settings operations', () => {
  it('updates metadata, entrypoint, startup, system layout, and default font through undoable commands', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    state = executeCommand(state, {
      type: 'project.updateMetadata',
      payload: { name: 'Demo', version: '1.2.3', author: 'Author' },
    }).state;
    state = executeCommand(state, {
      type: 'project.setEntrypoint',
      payload: { target: { kind: 'room', id: 'foyer' } },
    }).state;
    state = executeCommand(state, {
      type: 'project.setStartup',
      payload: { initScript: 'game.start()' },
    }).state;
    state = executeCommand(state, {
      type: 'project.setSystemLayout',
      payload: { role: 'title', layoutId: 'main' },
    }).state;
    const font = executeCommand(state, {
      type: 'project.setDefaultFont',
      payload: { assetId: 'main-font' },
    });
    expect(font.ok).toBe(true);
    expect(font.state.document).toMatchObject({
      project: { name: 'Demo', version: '1.2.3', author: 'Author' },
      entrypoint: { kind: 'room', id: 'foyer' },
      startupHook: { source: 'game.start()' },
      settings: {
        ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'main' } } } },
        text: { defaultFont: { $ref: { collection: 'assets', id: 'main-font' } } },
      },
    });
    const undone = undoCommand(font.state);
    expect(
      (undone.state.document as ReturnType<typeof projectWithSettingsTargets>).settings.text,
    ).toEqual({ defaultFont: null });
  });

  it('stores representable invalid refs so validation can report each owning field', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    let result = executeCommand(state, {
      type: 'project.setEntrypoint',
      payload: { target: { kind: 'room', id: 'missing' } },
    });
    expect(result.ok).toBe(true);
    result = executeCommand(result.state, {
      type: 'project.setDefaultFont',
      payload: { assetId: 'logo' },
    });
    expect(result.ok).toBe(true);
    result = executeCommand(result.state, {
      type: 'project.setIcon',
      payload: { assetId: 'main-font' },
    });
    expect(result.ok).toBe(true);
    result = executeCommand(result.state, {
      type: 'project.setSystemLayout',
      payload: { role: 'title', layoutId: 'missing' },
    });
    expect(result.ok).toBe(true);

    expect(result.state.document).toMatchObject({
      entrypoint: { kind: 'room', id: 'missing' },
      settings: {
        ui: { systemLayouts: { title: { $ref: { collection: 'layouts', id: 'missing' } } } },
        text: { defaultFont: { $ref: { collection: 'assets', id: 'logo' } } },
        app: { icon: { $ref: { collection: 'assets', id: 'main-font' } } },
      },
    });
    expect(
      validateProjectSettingsAuthoringState(
        result.state.document as ReturnType<typeof projectWithSettingsTargets>,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '/entrypoint', severity: 'error' }),
        expect.objectContaining({ path: '/settings/ui/systemLayouts/title/$ref' }),
        expect.objectContaining({ path: '/settings/text/defaultFont/$ref' }),
        expect.objectContaining({ path: '/settings/app/icon/$ref' }),
      ]),
    );
  });

  it('clears individual system layout roles back to built-in fallbacks', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    state = executeCommand(state, {
      type: 'project.setSystemLayout',
      payload: { role: 'game-hud', layoutId: 'main' },
    }).state;
    const clear = executeCommand(state, {
      type: 'project.setSystemLayout',
      payload: { role: 'game-hud', layoutId: null },
    });
    expect(clear.ok).toBe(true);
    expect(clear.state.document).toMatchObject({
      settings: { ui: { systemLayouts: { 'game-hud': null } } },
    });
  });

  it('allows blank project titles so validation can report the invalid project state', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    const result = executeCommand(state, { type: 'project.updateMetadata', payload: { name: '' } });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({ project: { name: '' } });
  });

  it('updates title screen and project icon settings', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    state = executeCommand(state, {
      type: 'project.setTitleScreen',
      payload: {
        titleImageId: 'logo',
        showProjectTitle: false,
        showAuthor: true,
        subtitle: 'A demo',
        startLabel: 'Begin',
      },
    }).state;
    const icon = executeCommand(state, { type: 'project.setIcon', payload: { assetId: 'logo' } });
    expect(icon.ok).toBe(true);
    expect(icon.state.document).toMatchObject({
      settings: {
        titleScreen: {
          titleImage: { $ref: { collection: 'assets', id: 'logo' } },
          showProjectTitle: false,
          showAuthor: true,
          subtitle: 'A demo',
          startLabel: 'Begin',
        },
        app: { icon: { $ref: { collection: 'assets', id: 'logo' } } },
      },
    });
  });

  it('does not expose a project command for editor-wide ComfyUI settings', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    expect(
      executeCommand(state, { type: 'project.setComfyUi', payload: { enabled: true } }).ok,
    ).toBe(false);
  });

  it('preserves display input exactly through an undoable atomic command', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    const result = executeCommand(state, {
      type: 'project.setDisplay',
      payload: {
        aspectRatio: { width: 1920, height: 1080 },
        orientation: 'portrait',
        barColor: '#AABBCC',
      },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      settings: {
        display: {
          aspectRatio: { width: 1920, height: 1080 },
          orientation: 'portrait',
          barColor: '#AABBCC',
        },
      },
    });
    expect(undoCommand(result.state).state.document).toMatchObject({
      settings: {
        display: {
          aspectRatio: { width: 16, height: 9 },
          orientation: 'landscape',
          barColor: '#000000',
        },
      },
    });
  });
});
