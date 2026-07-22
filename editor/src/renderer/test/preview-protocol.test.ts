import { describe, expect, it } from 'vite-plus/test';
import {
  isEditorToPreviewMessage,
  isPreviewDocument,
  isPreviewToEditorMessage,
  isRuntimeDebugSnapshot,
  validatePreviewHandshake,
  type EnginePreviewSession,
} from '../../shared/preview-protocol';

describe('preview protocol validation', () => {
  const authoredEnvironment = {
    profile: {
      name: 'project',
      nativeResolution: { width: 1920, height: 1080 },
      scalePolicy: { ui: 'ignore', text: 'inherit' },
    },
    project: {
      referenceResolution: { width: 1920, height: 1080 },
      worldRasterPolicy: 'capped',
      barColor: '#000000',
      accessibility: {
        uiScale: { enabled: true, minimum: 0.75, maximum: 2 },
        textScale: { enabled: true, minimum: 0.75, maximum: 2 },
      },
    },
  } as const;

  it('rejects the removed display-profile command', () => {
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-display-profile',
        requestId: 'removed-command',
        profile: null,
      }),
    ).toBe(false);
  });

  it('requires a typed authored environment for Layout preview loads', () => {
    const document = {
      kind: 'layout-preview',
      recordId: 'layout-a',
      revision: 'rev',
      data: { scalePolicy: { ui: 'ignore', text: 'inherit' } },
    };
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'authored-layout',
        document,
        environment: authoredEnvironment,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'missing-environment',
        document,
      }),
    ).toBe(false);
  });

  it('rejects malformed messages', () => {
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'state',
        position: { x: 2, y: 0 },
        running: true,
      }),
    ).toBe(false);
    expect(isPreviewToEditorMessage({ version: 2, type: 'ready', capabilities: [] })).toBe(false);
    expect(isPreviewToEditorMessage({ version: 1, type: 'object-clicked', objectId: 42 })).toBe(
      false,
    );
  });

  it('accepts valid preview events', () => {
    expect(
      isPreviewToEditorMessage({ version: 1, type: 'ready', capabilities: ['demo-click'] }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'object-clicked',
        objectId: 'demo-triangle',
        position: { x: 0.5, y: 0.5 },
        pointerPosition: { x: 0.5, y: 0.5 },
      }),
    ).toBe(true);
  });

  it('accepts and rejects authoring preview protocol messages', () => {
    const document = {
      kind: 'symbolic',
      target: { collection: 'materials', entityId: 'mat-a' },
      label: 'Material A',
    };
    expect(isPreviewDocument(document)).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'shader-preview',
        recordId: 'shader-a',
        revision: 'rev',
        data: {} as never,
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'layout-preview',
        recordId: 'layout-a',
        revision: 'rev',
        data: {} as never,
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'room-preview',
        recordId: 'room-a',
        revision: 'rev',
        data: {} as never,
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'dialogue-preview',
        recordId: 'dialogue-a',
        revision: 'rev',
        data: {} as never,
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'scene-preview',
        recordId: 'scene-a',
        revision: 'rev',
        data: {} as never,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'r1',
        document,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-mode',
        requestId: 'r2',
        mode: 'layout',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-mode',
        requestId: 'r2d',
        mode: 'dialogue',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-mode',
        requestId: 'r2s',
        mode: 'scene',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'request-preview-snapshot',
        requestId: 'r3',
        snapshotId: 's1',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-engine-settings',
        requestId: 'r4',
        settings: { showFpsCounter: true, fpsCap: 60 },
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-engine-settings',
        requestId: 'r5',
        settings: { fpsCap: -1 },
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-activity',
        requestId: 'activity-active',
        active: true,
        visible: true,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-activity',
        requestId: 'activity-inactive',
        active: false,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-activity',
        requestId: 'activity-missing',
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-activity',
        requestId: 'activity-bad-active',
        active: 1,
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-activity',
        requestId: 'activity-bad-visible',
        active: true,
        visible: 'yes',
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({ version: 1, type: 'runtime-start', requestId: 'runtime-start' }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-load-compiled-project',
        requestId: 'runtime-load-compiled-project',
        compiledProject: { engine: 1 },
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-load-compiled-project',
        requestId: 'runtime-load-compiled-project-assets',
        compiledProject: { engine: 1 },
        assets: [{ sourcePath: 'assets/images/foyer.png', runtimePath: 'textures/foyer.png' }],
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-load-compiled-project',
        requestId: 'runtime-load-compiled-project-bad',
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({ version: 1, type: 'runtime-stop', requestId: 'runtime-stop' }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({ version: 1, type: 'runtime-step', requestId: 'runtime-step' }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-step',
        requestId: 'runtime-step-delta',
        deltaSeconds: 0.016,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-step',
        requestId: 'runtime-step-bad',
        deltaSeconds: -1,
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-select-subjects',
        requestId: 'runtime-select',
        subjects: [
          { kind: 'character', id: 'guard' },
          { kind: 'interactable', id: 'lamp' },
        ],
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-select-subjects',
        requestId: 'runtime-select-bad',
        subjects: [{ kind: 'prop', id: 'lamp' }],
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-run-interaction',
        requestId: 'runtime-action',
        verbId: 'look',
        operands: [{ kind: 'interactable', id: 'lamp' }],
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-run-interaction',
        requestId: 'runtime-action-bad',
        verbId: 'look',
        operands: [{ kind: 'interactable', id: 1 }],
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-request-debug-snapshot',
        requestId: 'runtime-debug',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-fast-forward-to-input',
        requestId: 'runtime-fast-forward',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-set-variable',
        requestId: 'runtime-set-variable',
        variableId: 'flag',
        value: true,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-set-variable',
        requestId: 'runtime-set-variable-bad',
        variableId: 'flag',
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-reset-variable',
        requestId: 'runtime-reset-variable',
        variableId: 'flag',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-give-object',
        requestId: 'runtime-give-object',
        objectId: 'lamp',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-remove-inventory-object',
        requestId: 'runtime-remove-object',
        objectId: 'lamp',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-teleport-room',
        requestId: 'runtime-teleport-room',
        roomId: 'foyer',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'r1',
        document: { kind: 'unknown' },
      }),
    ).toBe(false);
    const legacyLayoutMode = `ui-${'layout'}`;
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'set-preview-mode',
        requestId: 'r2',
        mode: legacyLayoutMode,
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({ version: 1, type: 'preview-interacted', interaction: 'pointer' }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({ version: 1, type: 'preview-interacted', interaction: 'hover' }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'preview-diagnostic',
        diagnostic: { severity: 'warning', message: 'Unsupported preview mode' },
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'command-result',
        requestId: 'runtime-debug',
        ok: true,
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'command-result',
        requestId: 'runtime-debug',
        ok: true,
        snapshot: {},
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-debug-event',
        requestId: 'runtime-set-variable',
        event: {
          kind: 'variable-set',
          debugOnly: true,
          label: 'Debug set variable',
          target: { type: 'variable', id: 'flag', collection: 'variables' },
          oldValue: false,
          newValue: true,
        },
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-debug-event',
        event: { kind: 'variable-set', debugOnly: false, label: 'bad' },
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-fast-forward-result',
        requestId: 'runtime-fast-forward',
        result: {
          reason: 'choice-available',
          stepsApplied: 12,
          ticksApplied: 3,
          lastInput: 'continue',
          semanticInputBudget: 500,
          simulatedTickBudget: 300,
          stabilizationTickBudget: 20,
          finalSnapshot: {
            loaded: true,
            running: true,
            waiting: { kind: 'choice', canContinue: false },
            availableInputs: {
              continue: false,
              dialogueOptions: [{ index: 0, label: 'Yes', enabled: true }],
              navigation: [],
              actions: [],
              selectedSubjects: [],
              clickableTargets: [],
            },
            variables: [],
            inventory: [],
            selectedSubjects: [],
            diagnostics: [],
            saveSnapshot: {},
            publication: {
              revision: 1,
              presentationRevision: 1,
              observationCount: 0,
              actorCount: 0,
              interactableCount: 0,
              propCount: 0,
              environmentCount: 0,
              layoutCount: 0,
              desiredAudioCount: 0,
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-fast-forward-result',
        requestId: 'bad',
        result: { reason: 'continue', stepsApplied: 1, ticksApplied: 0, finalSnapshot: {} },
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'preview-snapshot',
        snapshotId: 's1',
        dataUrl: 'data:image/png;base64,test',
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'fps-counter',
        fps: 59.9,
        frameTimeMs: 16.69,
        fpsCap: 60,
      }),
    ).toBe(true);
  });

  it('accepts typed runtime debug snapshots and rejects malformed snapshots', () => {
    const snapshot = {
      requestId: 'runtime-debug',
      loaded: true,
      running: true,
      shellMode: 'game',
      runtimeMode: 'dialogue',
      entrypoint: { type: 'room', id: 'foyer', collection: 'rooms', label: 'Foyer' },
      currentEntity: { type: 'dialogue', id: 'intro', collection: 'dialogues', label: 'Intro' },
      currentRoomId: 'foyer',
      currentDialogueId: 'intro',
      waiting: { kind: 'choice', canContinue: false, reason: 'dialogue choices are available' },
      availableInputs: {
        continue: false,
        dialogueOptions: [{ index: 0, label: 'Ask about the house', enabled: true }],
        navigation: [{ index: 1, label: 'east', enabled: true }],
        actions: [
          { verbId: 'look', label: 'Look', objectCount: 1, selectedCount: 1, enabled: true },
        ],
        selectedSubjects: [
          { kind: 'character', id: 'guard' },
          { kind: 'interactable', id: 'lamp' },
        ],
        clickableTargets: [],
      },
      variables: [
        {
          id: 'route',
          label: 'Route',
          type: 'string',
          value: 'main',
          dirty: true,
          overridden: true,
        },
      ],
      inventory: [
        {
          id: 'lamp',
          label: 'Lamp',
          selected: true,
          enabled: true,
          location: { type: 'custom_script', id: 'player', collection: 'scripts' },
        },
      ],
      selectedSubjects: [
        { kind: 'character', id: 'guard' },
        { kind: 'interactable', id: 'lamp' },
      ],
      diagnostics: [{ severity: 'warning', category: 'runtime', message: 'Example diagnostic' }],
      saveSnapshot: { properties: { route: 'main' } },
      publication: {
        revision: 8,
        presentationRevision: 5,
        observationCount: 2,
        actorCount: 1,
        interactableCount: 1,
        propCount: 0,
        environmentCount: 1,
        layoutCount: 2,
        desiredAudioCount: 1,
      },
    };

    expect(isRuntimeDebugSnapshot(snapshot)).toBe(true);
    expect(isRuntimeDebugSnapshot({ ...snapshot, gameplayPaused: true })).toBe(true);
    expect(isRuntimeDebugSnapshot({ ...snapshot, gameplayPaused: 'yes' })).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-debug-snapshot',
        requestId: 'runtime-debug',
        snapshot,
      }),
    ).toBe(true);
    expect(
      isRuntimeDebugSnapshot({ ...snapshot, waiting: { kind: 'blocked', canContinue: false } }),
    ).toBe(false);
    expect(isRuntimeDebugSnapshot({ ...snapshot, saveSnapshot: [] })).toBe(false);
    expect(
      isRuntimeDebugSnapshot({
        ...snapshot,
        publication: { ...snapshot.publication, layoutCount: -1 },
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'runtime-debug-snapshot',
        snapshot: { ...snapshot, diagnostics: [{ severity: 'fatal', message: 'bad' }] },
      }),
    ).toBe(false);
  });

  it('rejects handshakes from the wrong source, origin, or token', () => {
    const iframeWindow = window;
    const session: EnginePreviewSession = {
      url: 'http://127.0.0.1:5000/?sessionToken=good',
      origin: 'http://127.0.0.1:5000',
      sessionToken: 'good',
    };
    const makeEvent = (source: Window | null, origin: string, sessionToken: string) =>
      ({
        source,
        origin,
        data: { type: 'noveltea-preview-hello', version: 1, sessionToken },
      }) as MessageEvent;

    expect(
      validatePreviewHandshake(
        makeEvent(iframeWindow, session.origin, 'good'),
        iframeWindow,
        session,
      ),
    ).toBe(true);
    expect(
      validatePreviewHandshake(makeEvent(null, session.origin, 'good'), iframeWindow, session),
    ).toBe(false);
    expect(
      validatePreviewHandshake(
        makeEvent(iframeWindow, 'http://127.0.0.1:1', 'good'),
        iframeWindow,
        session,
      ),
    ).toBe(false);
    expect(
      validatePreviewHandshake(
        makeEvent(iframeWindow, session.origin, 'bad'),
        iframeWindow,
        session,
      ),
    ).toBe(false);
  });
});
