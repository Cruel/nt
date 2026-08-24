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
  project.scripts['boot-alt'] = {
    id: 'boot-alt',
    label: 'Alternate Bootstrap',
    data: { kind: 'script-module', source: { kind: 'inline-lua', source: 'return {}' } },
  };
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
      imageMetadata: null,
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
      imageMetadata: { width: 512, height: 512, hasAlpha: true, orientation: 1 },
    },
  };
  return project;
}

describe('project settings operations', () => {
  it('updates metadata, entrypoint, Bootstrap Module, system layout, and default font through undoable commands', () => {
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
      type: 'project.setBootstrapModule',
      payload: { scriptId: 'boot-alt' },
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
      bootstrapModule: { $ref: { collection: 'scripts', id: 'boot-alt' } },
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

  it('sets and clears the optional Project undefined Interaction behavior without changing schema versions', () => {
    const project = projectWithSettingsTargets();
    const authoringVersion = project.schemaVersion;
    let state = createInitialCommandBusState(toJsonValue(project));
    const set = executeCommand(state, {
      type: 'project.setUndefinedInteractionProgram',
      payload: {
        program: {
          instructions: [
            {
              id: 'fallback-notice',
              kind: 'notify',
              message: { markup: 'plain', source: { kind: 'inline', text: 'Nothing useful.' } },
            },
          ],
          completion: { kind: 'return' },
          outcome: 'handled',
        },
      },
    });
    expect(set.ok).toBe(true);
    expect(set.state.document).toMatchObject({
      schemaVersion: authoringVersion,
      undefinedInteractionProgram: {
        instructions: [{ id: 'fallback-notice', kind: 'notify' }],
        outcome: 'handled',
      },
    });
    state = set.state;
    const clear = executeCommand(state, {
      type: 'project.setUndefinedInteractionProgram',
      payload: { program: null },
    });
    expect(clear.ok).toBe(true);
    expect(clear.state.document).toMatchObject({
      schemaVersion: authoringVersion,
      undefinedInteractionProgram: null,
    });
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

  it('changes only reference dimensions through an undoable atomic command', () => {
    let state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    state = executeCommand(state, {
      type: 'project.setDisplay',
      payload: {
        referenceResolution: { width: 1920, height: 1080 },
        worldRasterPolicy: 'native',
        barColor: '#AABBCC',
      },
    }).state;
    const result = executeCommand(state, {
      type: 'project.setReferenceResolution',
      payload: { width: 1080, height: 1920 },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      settings: {
        display: {
          referenceResolution: { width: 1080, height: 1920 },
          worldRasterPolicy: 'native',
          barColor: '#AABBCC',
        },
      },
    });
    expect(undoCommand(result.state).state.document).toMatchObject({
      settings: {
        display: {
          referenceResolution: { width: 1920, height: 1080 },
          worldRasterPolicy: 'native',
          barColor: '#AABBCC',
        },
      },
    });
    expect(
      executeCommand(state, {
        type: 'project.setReferenceResolution',
        payload: { width: 0, height: 1080 },
      }).ok,
    ).toBe(false);
  });

  it('updates one accessibility policy without deleting its retained range', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    const result = executeCommand(state, {
      type: 'project.setAccessibilityScale',
      payload: {
        scale: 'uiScale',
        policy: { enabled: false, minimum: 1.25, maximum: 2.5 },
      },
    });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({
      settings: {
        accessibility: {
          uiScale: { enabled: false, minimum: 1.25, maximum: 2.5 },
          textScale: { enabled: true, minimum: 1, maximum: 2 },
        },
      },
    });
  });

  it('updates the complete semantic audio mix atomically and rejects out-of-range gain', () => {
    const state = createInitialCommandBusState(toJsonValue(projectWithSettingsTargets()));
    const audio = {
      purposes: {
        music: { volume: 0.7, muted: false },
        ambience: { volume: 0.6, muted: true },
        voice: { volume: 0.9, muted: false },
        'sound-effect': { volume: 0.8, muted: false },
        'ui-sound': { volume: 0.5, muted: false },
      },
      voiceDucking: { enabled: true, musicGain: 0.35, ambienceGain: 0.45 },
    };
    const result = executeCommand(state, { type: 'project.setAudio', payload: { audio } });
    expect(result.ok).toBe(true);
    expect(result.state.document).toMatchObject({ settings: { audio } });
    expect(undoCommand(result.state).state.document).not.toMatchObject({ settings: { audio } });

    expect(
      executeCommand(state, {
        type: 'project.setAudio',
        payload: {
          audio: {
            ...audio,
            purposes: { ...audio.purposes, music: { volume: 1.1, muted: false } },
          },
        },
      }).ok,
    ).toBe(false);
  });
});
