import { describe, expect, it } from 'vite-plus/test';
import {
  isDevtoolsDebugReport,
  isEditorToPreviewMessage,
  isDevtoolsSnapshot,
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

  it('validates debugger visibility and exact context selection commands', () => {
    const command = {
      version: 1,
      type: 'devtools-set-rmlui-debugger',
      requestId: 'debugger',
      visible: true,
      context: 'runtime-ui',
    };
    expect(isEditorToPreviewMessage(command)).toBe(true);
    expect(isEditorToPreviewMessage({ ...command, visible: 'true' })).toBe(false);
    expect(isEditorToPreviewMessage({ ...command, context: '' })).toBe(false);
    expect(isEditorToPreviewMessage({ ...command, context: undefined })).toBe(false);
  });

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
      data: {
        schema: 'noveltea.layout-preview',
        scalePolicy: { ui: 'ignore', text: 'inherit' },
      },
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

    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'invalid-native-resolution',
        document,
        environment: {
          ...authoredEnvironment,
          profile: {
            ...authoredEnvironment.profile,
            nativeResolution: { width: 0, height: 1080 },
          },
        },
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'invalid-scale-range',
        document,
        environment: {
          ...authoredEnvironment,
          project: {
            ...authoredEnvironment.project,
            accessibility: {
              ...authoredEnvironment.project.accessibility,
              uiScale: { enabled: true, minimum: 1.5, maximum: 1.25 },
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'load-preview-document',
        requestId: 'wrong-state-environment',
        document: {
          kind: 'shader-preview',
          recordId: 'shader-a',
          revision: 'rev',
          data: {},
        },
        environment: authoredEnvironment,
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
    expect(
      isPreviewToEditorMessage({
        version: 2,
        type: 'ready',
        capabilities: [],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-330',
      }),
    ).toBe(false);
    expect(isPreviewToEditorMessage({ version: 1, type: 'object-clicked', objectId: 42 })).toBe(
      false,
    );
  });

  it('accepts valid preview events', () => {
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'ready',
        capabilities: ['demo-click'],
        hostGeneration: 1,
        transportGeneration: 1,
        activeShaderVariant: 'glsl-330',
      }),
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

  it('accepts native focused Room resolution membership and rejects malformed identities', () => {
    const message = {
      version: 1,
      type: 'focused-document-applied',
      requestId: 'focused-room',
      hostGeneration: 1,
      applySequence: 3,
      result: {
        disposition: 'applied',
        projectInstanceId: 'project-one',
        kind: 'room-preview',
        recordId: 'foyer',
        revision: `sha256:${'a'.repeat(64)}`,
        resourceStageGeneration: 2,
        roomResolution: {
          castEntryIds: ['hero'],
          interactableOccurrenceIds: ['key'],
          propIds: ['desk'],
          environmentIds: ['fog'],
        },
      },
      diagnostics: [],
    };

    expect(isPreviewToEditorMessage(message)).toBe(true);
    expect(
      isPreviewToEditorMessage({
        ...message,
        result: {
          ...message.result,
          roomResolution: { ...message.result.roomResolution, propIds: [''] },
        },
      }),
    ).toBe(false);
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
        data: { schema: 'noveltea.layout-preview' },
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
        data: { schema: 'noveltea.dialogue-preview' },
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'scene-preview',
        recordId: 'scene-a',
        revision: 'rev',
        data: { schema: 'noveltea.scene-preview' },
      }),
    ).toBe(true);
    expect(
      isPreviewDocument({
        kind: 'character-preview',
        recordId: 'character-a',
        revision: 'rev',
        data: { schema: 'noveltea.character-preview' },
      }),
    ).toBe(true);
    for (const [kind, schema] of [
      ['character-preview', 'noveltea.character-preview.v0'],
      ['dialogue-preview', 'noveltea.dialogue-preview.v1'],
      ['scene-preview', 'noveltea.scene-preview.v1'],
      ['layout-preview', 'noveltea.layout-preview.v0'],
    ] as const) {
      expect(
        isPreviewDocument({
          kind,
          recordId: 'retired',
          revision: 'rev',
          data: { schema },
        }),
      ).toBe(false);
    }
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
        settings: { showFpsCounter: true, fpsCap: 60, rmluiRasterSnap: 'text' },
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
        type: 'set-engine-settings',
        requestId: 'r5b',
        settings: { rmluiRasterSnap: 'pixels' },
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
        type: 'runtime-dialogue-choice',
        requestId: 'runtime-dialogue-choice',
        edgeId: 'accept',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-scene-choice',
        requestId: 'runtime-scene-choice',
        optionId: 'investigate',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-dialogue-option',
        requestId: 'obsolete-runtime-dialogue-option',
        optionIndex: 0,
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
        type: 'runtime-primary-activate',
        requestId: 'runtime-primary',
        subject: { kind: 'interactable', id: 'lamp' },
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-open-verb-menu',
        requestId: 'runtime-menu',
        subject: { kind: 'feature', ownerKind: 'room', ownerId: 'foyer', featureId: 'door' },
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-run-interaction',
        requestId: 'runtime-action',
        verbId: 'look',
        bindings: [{ slotId: 'target', subject: { kind: 'interactable', id: 'lamp' } }],
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-run-interaction',
        requestId: 'runtime-action-bad',
        verbId: 'look',
        bindings: [{ slotId: 'target', subject: { kind: 'interactable', id: 1 } }],
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-select-subjects',
        requestId: 'runtime-select-feature',
        subjects: [
          {
            kind: 'feature',
            ownerKind: 'interactable',
            ownerId: 'lamp',
            featureId: 'handle',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-select-subjects',
        requestId: 'runtime-select-feature-bad',
        subjects: [{ kind: 'feature', ownerKind: 'room', ownerId: '', featureId: 'door' }],
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
        type: 'runtime-create-instance',
        requestId: 'runtime-create-instance',
        instanceKind: 'character',
        sourceKind: 'archetype',
        sourceId: 'guard-template',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-replace-instance-configuration',
        requestId: 'runtime-replace-instance',
        instanceKind: 'room',
        instanceId: 'runtime-room-1',
        sourceKind: 'effective',
        sourceId: 'foyer',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-clear-instance-configuration',
        requestId: 'runtime-clear-instance',
        instanceKind: 'interactable',
        instanceId: 'runtime-interactable-2',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-destroy-instance',
        requestId: 'runtime-destroy-instance',
        instanceKind: 'character',
        instanceId: 'runtime-character-3',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-retarget-room-exit',
        requestId: 'runtime-retarget-exit',
        roomId: 'runtime-room-1',
        exitId: 'east',
        targetRoomId: 'foyer',
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'runtime-create-instance',
        requestId: 'runtime-create-instance-bad',
        instanceKind: 'scene',
        sourceKind: 'compiled',
        sourceId: 'opening',
      }),
    ).toBe(false);
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
              choices: [{ kind: 'dialogue', id: 'yes', label: 'Yes', enabled: true }],
              navigation: [],
              actions: [],
              verbOffers: [],
              verbMenuOpen: false,
              selectedSubjects: [],
              clickableTargets: [],
            },
            variables: [],
            inventory: [],
            selectedSubjects: [],
            diagnostics: [],
            dialoguePresentation: { stageSlots: [], mediaSlots: [] },
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
              gameplayInstances: [],
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
        choices: [
          {
            kind: 'dialogue',
            id: 'ask-house',
            label: 'Ask about the house',
            enabled: true,
          },
        ],
        navigation: [{ exitId: 'east-exit', direction: 1, label: 'east', enabled: true }],
        actions: [
          {
            verbId: 'look',
            label: 'Look',
            bindingOrder: ['target'],
            selectedCount: 1,
            rank: 0,
            primary: true,
            enabled: true,
          },
        ],
        verbOffers: [
          {
            verbId: 'look',
            slotId: 'target',
            label: 'Look',
            bindingOrder: ['target'],
            rank: 0,
            primary: true,
          },
        ],
        verbMenuOpen: true,
        selectedSubjects: [
          { kind: 'character', id: 'guard' },
          { kind: 'interactable', id: 'lamp' },
        ],
        clickableTargets: [
          {
            kind: 'subject',
            subject: { kind: 'feature', ownerKind: 'room', ownerId: 'foyer', featureId: 'door' },
            label: 'Door',
          },
          { kind: 'exit', exitId: 'east-exit', label: 'East' },
        ],
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
      dialoguePresentation: {
        stageSlots: [
          {
            id: 'speaker-left',
            speakerSync: true,
            speaking: true,
            presentation: {
              characterId: 'guard',
              profileId: 'stage',
              poseId: 'idle',
              expressionId: 'neutral',
              appearanceId: null,
              position: 0,
              offset: { x: -24, y: 10 },
              scale: 1,
              visible: true,
            },
          },
        ],
        mediaSlots: [
          { id: 'evidence', visible: true, content: { kind: 'image', assetId: 'photo' } },
        ],
      },
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
        gameplayInstances: [
          {
            kind: 'room',
            id: 'foyer',
            declared: true,
            provenance: 'declared',
            archetype: null,
            source: null,
          },
          {
            kind: 'interactable',
            id: 'runtime-interactable-3',
            declared: false,
            provenance: 'clone',
            archetype: null,
            source: 'lamp',
          },
        ],
      },
    };

    expect(isRuntimeDebugSnapshot(snapshot)).toBe(true);
    expect(isRuntimeDebugSnapshot({ ...snapshot, gameplayPaused: true })).toBe(true);
    expect(isRuntimeDebugSnapshot({ ...snapshot, gameplayPaused: 'yes' })).toBe(false);
    expect(
      isRuntimeDebugSnapshot({
        ...snapshot,
        dialoguePresentation: {
          ...snapshot.dialoguePresentation,
          stageSlots: [
            {
              ...snapshot.dialoguePresentation.stageSlots[0],
              presentation: {
                ...snapshot.dialoguePresentation.stageSlots[0]!.presentation!,
                position: 4,
              },
            },
          ],
        },
      }),
    ).toBe(false);
    expect(isRuntimeDebugSnapshot({ ...snapshot, itemStacks: [] })).toBe(false);
    expect(
      isRuntimeDebugSnapshot({
        ...snapshot,
        selectedSubjects: [{ kind: 'item-stack', id: 'coins' }],
      }),
    ).toBe(false);
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

    const devtoolsSnapshot = {
      host: {
        platform: 'SDL3',
        renderer: 'OpenGL',
        hostGeneration: 12,
        surface: {
          logicalWidth: 1280,
          logicalHeight: 720,
          framebufferWidth: 2560,
          framebufferHeight: 1440,
          framebufferScaleX: 2,
          framebufferScaleY: 2,
        },
      },
      input: {
        referenceX: 640,
        referenceY: 360,
        pointerValid: true,
        lastEvent: 'mouse-motion',
        debugProcessed: true,
        debugConsumed: false,
        runtimeUiProcessed: true,
        runtimeUiConsumed: false,
        runtimeUiWantsPointer: false,
        gameplayEvent: true,
        gameplayAdmitted: true,
        gameplayBlockReason: 'none',
        governingLayout: null,
        governingLayoutMode: 'none',
      },
      rmluiDebugger: { available: true, visible: false, context: 'runtime-ui' },
      rmlui: [
        {
          name: 'game-ui',
          label: 'Game UI — runtime-ui',
          lifecycleIdentity: 'game-ui:0:0:gameplay:normal:gameplay:ui-inherit-text-inherit',
          plane: 'game-ui',
          clock: 'gameplay',
          inputMode: 'normal',
          owner: 'gameplay',
          scaleDomain: 'ui-inherit-text-inherit',
          compositionGroup: 0,
          compatibilityGroup: 0,
          width: 1280,
          height: 720,
          mediaQueryWidth: 1280,
          mediaQueryHeight: 720,
          requestedUiScale: 1,
          textScaleFactor: 1,
          referenceToContextScaleX: 1,
          referenceToContextScaleY: 1,
          uiRasterScaleX: 2,
          uiRasterScaleY: 2,
          fontRasterScale: 2,
          hasInspectableDocuments: true,
          mouseInteracting: false,
          recentEventProcessed: true,
          recentEventConsumed: false,
          hover: {
            documentId: 'hud',
            tag: 'button',
            id: 'continue',
            classes: 'primary',
            pointerEvents: 'auto',
          },
          focus: null,
        },
      ],
      world: {
        referenceX: 640,
        referenceY: 360,
        pointerValid: true,
        captureActive: false,
        underPointer: 'room/foyer/hotspot/door',
        hovered: 'room/foyer/hotspot/door',
        pressed: null,
        hotspots: [
          {
            identity: 'room/foyer/hotspot/door',
            label: 'Door',
            conditionEligible: true,
            targetAvailable: true,
            target: 'room/foyer/exit/hall',
            highlight: 'default',
            cursor: 'system:0',
            preparedHitTarget: true,
            hitTestOrder: 0,
            inputOrder: 10,
            hitShape: 'rect',
            hitShapeX: 0.1,
            hitShapeY: 0.2,
            hitShapeWidth: 0.3,
            hitShapeHeight: 0.4,
            hitBoundsX: 10,
            hitBoundsY: 20,
            hitBoundsWidth: 100,
            hitBoundsHeight: 80,
            underPointer: true,
            hovered: true,
            pressed: false,
          },
        ],
      },
      tooling: {
        previewRunning: true,
        renderPerfLogging: false,
        nativeDebugUiAvailable: false,
        nativeDebugUiEnabled: false,
      },
      runtime: snapshot,
    };
    expect(isDevtoolsSnapshot(devtoolsSnapshot)).toBe(true);
    expect(isDevtoolsSnapshot({ ...devtoolsSnapshot, rmluiDebugger: undefined })).toBe(false);
    expect(
      isDevtoolsSnapshot({
        ...devtoolsSnapshot,
        rmluiDebugger: { available: true, visible: 'yes', context: 'runtime-ui' },
      }),
    ).toBe(false);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-snapshot',
        requestId: 'devtools-debug',
        snapshot: devtoolsSnapshot,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'devtools-request-snapshot',
        requestId: 'devtools-debug',
      }),
    ).toBe(true);
    const consoleDelta = {
      afterSequence: '4',
      earliestRetainedSequence: '2',
      latestSequence: '6',
      lostRecordCount: '0',
      historyGap: false,
      records: [
        {
          sequence: '5',
          globalSequence: '9',
          hostGeneration: '2',
          runtimeGeneration: '7',
          frame: '39',
          severity: 'warning',
          category: 'lua',
          message: 'careful',
          source: { chunk: 'project:/scripts/main.lua', line: 12 },
          generationMarker: false,
        },
      ],
    };
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-console-delta',
        delta: consoleDelta,
      }),
    ).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'devtools-clear-console',
        requestId: 'clear-console',
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-console-delta',
        delta: { ...consoleDelta, latestSequence: 6 },
      }),
    ).toBe(false);
    const traceDelta = {
      afterSequence: '6',
      earliestRetainedSequence: '2',
      latestSequence: '8',
      lostRecordCount: '0',
      historyGap: false,
      records: [
        {
          sequence: '8',
          firstSequence: '7',
          globalSequence: '10',
          firstGlobalSequence: '8',
          hostGeneration: '2',
          runtimeGeneration: '7',
          kind: 'input-routing',
          category: 'input',
          repeatCount: 2,
          firstFrame: '40',
          lastFrame: '41',
          input: {
            event: 'mouse-motion',
            hostX: 320,
            hostY: 180,
            referenceX: 640,
            referenceY: 360,
            mouseButton: null,
            wheelX: null,
            wheelY: null,
            referenceValid: true,
            debugProcessed: true,
            debugConsumed: false,
            runtimeUiProcessed: true,
            runtimeUiConsumed: false,
            runtimeUiWantsPointer: false,
            gameplayEvent: true,
            gameplayAdmitted: true,
            gameplayBlockReason: 'none',
            governingLayout: null,
            governingLayoutMode: 'none',
            rmluiHover: {
              context: 'game-ui',
              documentId: 'hud',
              tag: 'button',
              id: 'continue',
              classes: 'primary',
              pointerEvents: 'auto',
            },
            rmluiFocus: null,
            worldEvaluated: true,
            worldConsumed: false,
            worldHit: 'room/foyer/hotspot/door',
            worldHovered: 'room/foyer/hotspot/door',
            worldPressed: null,
            worldTarget: null,
          },
          debuggerMutation: null,
          detail: '',
          generationMarker: false,
        },
      ],
    };
    expect(
      isPreviewToEditorMessage({ version: 1, type: 'devtools-trace-delta', delta: traceDelta }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-trace-delta',
        delta: {
          ...traceDelta,
          records: [
            {
              ...traceDelta.records[0],
              sequence: '9',
              firstSequence: '9',
              globalSequence: '11',
              firstGlobalSequence: '11',
              kind: 'debugger-mutation',
              category: 'debugger',
              repeatCount: 1,
              input: null,
              debuggerMutation: {
                sourceFrontend: 'editor-react',
                operation: 'set variable trust',
              },
              detail: 'editor-react: set variable trust',
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-trace-delta',
        delta: {
          ...traceDelta,
          records: [
            {
              ...traceDelta.records[0],
              kind: 'debugger-mutation',
              input: null,
              debuggerMutation: { sourceFrontend: 7, operation: 'set variable trust' },
            },
          ],
        },
      }),
    ).toBe(false);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'devtools-clear-trace',
        requestId: 'clear-trace',
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-trace-delta',
        delta: { ...traceDelta, records: [{ ...traceDelta.records[0], repeatCount: 0 }] },
      }),
    ).toBe(false);

    const debugReport = {
      formatVersion: 1,
      build: {
        engineVersion: '1.0.0',
        buildConfiguration: 'RelWithDebInfo',
        targetPlatform: 'Emscripten',
        hostPlatform: 'SDL3',
        renderer: 'WebGL',
      },
      capabilities: [
        'devtools-snapshot-v1',
        'devtools-console-v1',
        'devtools-trace-v1',
        'devtools-debug-report-v1',
      ],
      snapshot: devtoolsSnapshot,
      diagnostics: [
        {
          code: 'runtime.example',
          severity: 'warning',
          message: 'Example warning',
          sourcePath: 'project:/scripts/main.lua',
          jsonPointer: '',
          causes: [],
        },
      ],
      rmlui: {
        contexts: devtoolsSnapshot.rmlui,
        debugger: devtoolsSnapshot.rmluiDebugger,
      },
      console: { ...consoleDelta, afterSequence: '0' },
      trace: { ...traceDelta, afterSequence: '0' },
    };
    expect(isDevtoolsDebugReport(debugReport)).toBe(true);
    expect(
      isEditorToPreviewMessage({
        version: 1,
        type: 'devtools-request-debug-report',
        requestId: 'debug-report',
      }),
    ).toBe(true);
    expect(
      isPreviewToEditorMessage({
        version: 1,
        type: 'devtools-debug-report',
        requestId: 'debug-report',
        report: debugReport,
      }),
    ).toBe(true);
    expect(isDevtoolsDebugReport({ ...debugReport, formatVersion: 2 })).toBe(false);
    expect(
      isDevtoolsDebugReport({
        ...debugReport,
        console: { ...debugReport.console, lostRecordCount: 3 },
      }),
    ).toBe(false);
    expect(isDevtoolsSnapshot({ ...devtoolsSnapshot, runtime: {} })).toBe(false);
    expect(
      isDevtoolsSnapshot({
        ...devtoolsSnapshot,
        host: { ...devtoolsSnapshot.host, hostGeneration: 0 },
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
