import { describe, expect, it } from 'vitest';
import { createInitialCommandBusState, executeCommand, undoCommand } from '@/commands/command-bus';
import { toJsonValue } from '@/project/json-value';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';

function projectWithSettingsTargets() {
  const project = createAuthoringProject();
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: defaultRoomData('Foyer') };
  project.layouts.main = { id: 'main', label: 'Main Layout', tags: [], data: defaultLayoutData('Main Layout') };
  project.assets['main-font'] = {
    id: 'main-font',
    label: 'Main Font',
    tags: [],
    data: { kind: 'font', source: { type: 'project-file', path: 'assets/fonts/main.ttf' }, aliases: [], extension: '.ttf' },
  };
  project.assets.logo = {
    id: 'logo',
    label: 'Logo',
    tags: [],
    data: { kind: 'image', source: { type: 'project-file', path: 'assets/images/logo.png' }, aliases: [], extension: '.png' },
  };
  return project;
}

describe('project settings operations', () => {
  it('updates metadata, entrypoint, startup, default layout, and default font through undoable commands', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    state = executeCommand(state, { type: 'project.updateMetadata', payload: { name: 'Demo', version: '1.2.3', author: 'Author' } }).state;
    state = executeCommand(state, { type: 'project.setEntrypoint', payload: { target: { collection: 'rooms', id: 'foyer' } } }).state;
    state = executeCommand(state, { type: 'project.setStartup', payload: { initScript: 'game.start()' } }).state;
    state = executeCommand(state, { type: 'project.setRuntimeDefaultLayout', payload: { layoutId: 'main' } }).state;
    const font = executeCommand(state, { type: 'project.setDefaultFont', payload: { assetId: 'main-font' } });
    expect(font.ok).toBe(true);
    expect(font.state.document).toMatchObject({
      project: { name: 'Demo', version: '1.2.3', author: 'Author' },
      entrypoint: { collection: 'rooms', id: 'foyer' },
      settings: {
        startup: { initScript: 'game.start()' },
        ui: { defaultLayout: { $ref: { collection: 'layouts', id: 'main' } } },
        text: { defaultFont: { $ref: { collection: 'assets', id: 'main-font' } } },
      },
    });
    const undone = undoCommand(font.state);
    expect((undone.state.document as ReturnType<typeof projectWithSettingsTargets>).settings.text).toBeUndefined();
  });

  it('rejects invalid project settings refs and empty required metadata', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    expect(executeCommand(state, { type: 'project.setEntrypoint', payload: { target: { collection: 'rooms', id: 'missing' } } }).ok).toBe(false);
    expect(executeCommand(state, { type: 'project.setDefaultFont', payload: { assetId: 'logo' } }).ok).toBe(false);
    expect(executeCommand(state, { type: 'project.setIcon', payload: { assetId: 'main-font' } }).ok).toBe(false);
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
      payload: { titleImageId: 'logo', showProjectTitle: false, showAuthor: true, subtitle: 'A demo', startLabel: 'Begin' },
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

  it('updates ComfyUI settings through an undoable command', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    const result = executeCommand(state, {
      type: 'project.setComfyUi',
      payload: { enabled: true, serverUrl: 'http://127.0.0.1:8000/' },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      settings: {
        comfyui: {
          enabled: true,
          serverUrl: 'http://127.0.0.1:8000',
        },
      },
    });
    expect(undoCommand(result.state).state.document).not.toMatchObject({ settings: { comfyui: expect.anything() } });
  });

  it('rejects invalid ComfyUI URLs', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    expect(executeCommand(state, { type: 'project.setComfyUi', payload: { serverUrl: 'file:///tmp/comfy' } }).ok).toBe(false);
  });
});
