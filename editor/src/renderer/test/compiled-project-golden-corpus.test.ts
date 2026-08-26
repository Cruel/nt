import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import {
  compiledProjectWireSchema,
  type CompiledProjectWire,
} from '../../shared/project-schema/compiled-project';
import {
  canonicalExplorationGoldenProject,
  canonicalLinearGoldenProject,
  canonicalFlowGoldenProject,
  canonicalVocabularyGoldenProject,
  comprehensiveGoldenProject,
  dialogueProgramGoldenProject,
  traitPropertiesLocalizationGoldenProject,
  interactionProgramGoldenProject,
  minimalGoldenProject,
  resourceGoldenProject,
  sceneProgramGoldenProject,
} from './fixtures/compiled-project-golden-projects';

function golden(name: string): string {
  return readFileSync(
    resolve('src/renderer/test/fixtures/compiled-project-golden', `${name}.json`),
    'utf8',
  ).trimEnd();
}

function compileFixture(project: ReturnType<typeof minimalGoldenProject>): CompiledProjectWire {
  const result = compileAuthoringProject(project);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  if (!result.ok) throw new Error('Golden project did not compile.');
  return result.project;
}

function expectGolden(
  name: string,
  project: ReturnType<typeof minimalGoldenProject>,
): CompiledProjectWire {
  const result = compileAuthoringProject(project);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  if (!result.ok) throw new Error('Golden project did not compile.');
  expect(result.canonicalJson).toBe(golden(name));
  return result.project;
}

function collectKinds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKinds(entry, result));
    return result;
  }
  if (value === null || typeof value !== 'object') return result;
  const record = value as Record<string, unknown>;
  if (typeof record.kind === 'string') result.add(record.kind);
  Object.values(record).forEach((entry) => collectKinds(entry, result));
  return result;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('compiled project cross-language golden corpus', () => {
  it('keeps the minimal complete document byte-stable', () => {
    expectGolden('minimal', minimalGoldenProject());
  });

  it('keeps the Room-free canonical linear Scene/Dialogue project byte-stable', () => {
    const project = expectGolden('canonical-linear', canonicalLinearGoldenProject());
    expect(project.definitions.rooms).toEqual([]);
    expect(project.entrypoint).toEqual({ kind: 'scene', scene: { kind: 'scene', id: 'opening' } });
  });

  it('keeps the canonical exploration and restoration project byte-stable', () => {
    expectGolden('canonical-exploration', canonicalExplorationGoldenProject());
  });

  it('keeps staged flashback and repeated Dialogue Handoff byte-stable', () => {
    expectGolden('canonical-flow', canonicalFlowGoldenProject());
  });

  it('keeps the complete post-refactor canonical vocabulary byte-stable', () => {
    expectGolden('canonical-vocabulary', canonicalVocabularyGoldenProject());
  });

  it('keeps every compiled definition, declaration, localization, and resource family byte-stable', () => {
    const project = expectGolden('comprehensive', comprehensiveGoldenProject());
    for (const definitions of Object.values(project.definitions))
      expect(definitions.length).toBeGreaterThan(0);
  });

  it('keeps Traits, properties, and localization edge data byte-stable', () => {
    expectGolden('trait-properties-localization', traitPropertiesLocalizationGoldenProject());
  });

  it('keeps typed gameplay-resource references and both resource source modes byte-stable', () => {
    expectGolden('resources', resourceGoldenProject());
  });

  it('keeps every Scene instruction variant byte-stable', () => {
    expectGolden('scene-program', sceneProgramGoldenProject());
  });

  it('keeps every Dialogue graph variant byte-stable', () => {
    expectGolden('dialogue-program', dialogueProgramGoldenProject());
  });

  it('keeps every Interaction matching and instruction variant byte-stable', () => {
    expectGolden('interaction-program', interactionProgramGoldenProject());
  });

  it('rejects malformed compiled Feature references', () => {
    const interaction = structuredClone(compileFixture(interactionProgramGoldenProject()));
    const rule = interaction.definitions.interactions
      .flatMap((definition) => definition.rules)
      .find((candidate) => candidate.id === 'room-feature')!;
    const selector = rule.slots[0]?.selectors[0];
    if (selector?.kind !== 'exact' || selector.subject.kind !== 'feature')
      throw new Error('Expected exact Feature selector.');
    (selector.subject.feature as { featureId: unknown }).featureId = null;
    expect(compiledProjectWireSchema.safeParse(interaction).success).toBe(false);
  });

  it('covers the closed decoder vocabulary rather than only nominal collection records', () => {
    const comprehensive = compileFixture(comprehensiveGoldenProject());
    const canonicalLinear = compileFixture(canonicalLinearGoldenProject());
    const canonicalVocabulary = compileFixture(canonicalVocabularyGoldenProject());
    const resources = compileFixture(resourceGoldenProject());
    const scene = compileFixture(sceneProgramGoldenProject());
    const dialogue = compileFixture(dialogueProgramGoldenProject());
    const interaction = compileFixture(interactionProgramGoldenProject());
    const kinds = collectKinds([
      comprehensive,
      canonicalLinear,
      canonicalVocabulary,
      resources,
      scene,
      dialogue,
      interaction,
    ]);

    const requiredKinds = [
      'actor-cue',
      'always',
      'family',
      'apply-effect',
      'asset',
      'audio-cue',
      'camera',
      'call-interaction',
      'call-scene',
      'call-dialogue',
      'character',
      'choice',
      'clear-background',
      'clear-configuration',
      'conditional-branch',
      'consume-item-quantity',
      'create-character',
      'create-interactable',
      'create-room',
      'directed-room-change',
      'destroy-instance',
      'dialogue',
      'end',
      'exact',
      'effective-instance',
      'flash',
      'gameplay-effect-batch',
      'gesture',
      'grant-item-quantity',
      'inline',
      'inline-lua',
      'interactable',
      'inventory',
      'feature',
      'item-definition',
      'layout',
      'line',
      'localized',
      'lua-expression',
      'lua-predicate',
      'material',
      'media',
      'merge-item-stacks',
      'move-character',
      'move-interactable',
      'navigation-attempt',
      'next',
      'notify',
      'punch',
      'qualified-pattern',
      'replace-configuration',
      'resume-dialogue',
      'retarget-room-exit',
      'unplaced',
      'rect',
      'redirect',
      'return',
      'room',
      'run-lua',
      'run-lua-effect',
      'runtime-world-transaction',
      'scene',
      'sequence',
      'set-background',
      'set-character-state',
      'set-interactable-state',
      'set-item-stack-traits',
      'set-layout',
      'set-global-property',
      'set-property',
      'shake',
      'show-text',
      'sound-effect',
      'speaker-expression',
      'split-item-stack',
      'stage',
      'start-detached-scene',
      'trait',
      'transfer-item-quantity',
      'transition-group',
      'property',
      'global-property-comparison',
      'unset-property',
      'verb',
      'voice',
      'wait-audio',
      'wait-condition',
      'wait-duration',
      'wait-input',
      'wait-layout-signal',
      'wait-operation',
    ];
    for (const kind of requiredKinds)
      expect(kinds, `missing compiled kind '${kind}'`).toContain(kind);

    const opening = scene.definitions.scenes.find((candidate) => candidate.id === 'opening')!;
    expect(sorted(new Set(opening.program.events.map((event) => event.instruction.kind)))).toEqual(
      sorted([
        'set-background',
        'actor-cue',
        'call-dialogue',
        'show-text',
        'audio-cue',
        'set-global-property',
        'run-lua',
        'wait-duration',
        'wait-input',
        'conditional-branch',
        'choice',
        'set-layout',
        'material-parameter',
        'postprocess-effect',
        'transition-group',
      ]),
    );

    const canonicalSceneInstructions = sorted(
      new Set(
        [...scene.definitions.scenes, ...canonicalVocabulary.definitions.scenes].flatMap(
          (definition) => definition.program.events.map((event) => event.instruction.kind),
        ),
      ),
    );
    expect(canonicalSceneInstructions).toEqual(
      sorted([
        'actor-cue',
        'audio-cue',
        'call-dialogue',
        'call-interaction',
        'call-scene',
        'choice',
        'conditional-branch',
        'directed-room-change',
        'gameplay-effect-batch',
        'material-parameter',
        'navigation-attempt',
        'postprocess-effect',
        'resume-dialogue',
        'run-lua',
        'runtime-world-transaction',
        'set-background',
        'set-global-property',
        'set-layout',
        'show-text',
        'start-detached-scene',
        'transition-group',
        'wait-audio',
        'wait-condition',
        'wait-duration',
        'wait-input',
        'wait-layout-signal',
        'wait-operation',
      ]),
    );
    expect(
      sorted(
        new Set(
          [canonicalLinear, canonicalVocabulary, scene].flatMap((project) =>
            project.definitions.scenes.map((definition) => definition.stage.kind),
          ),
        ),
      ),
    ).toEqual(['blank', 'inherited', 'staged-room']);
    expect(
      sorted(
        new Set(
          [canonicalLinear, canonicalVocabulary, scene].flatMap((project) =>
            project.definitions.scenes.map((definition) => definition.terminal.kind),
          ),
        ),
      ),
    ).toEqual([
      'complete-game',
      'continue-dialogue',
      'continue-scene',
      'release-to-exploration',
      'return',
    ]);

    const vocabularyScene = canonicalVocabulary.definitions.scenes.find(
      (candidate) => candidate.id === 'vocabulary',
    )!;
    expect(
      sorted(
        new Set(
          vocabularyScene.program.events.flatMap((event) =>
            event.instruction.kind === 'gameplay-effect-batch'
              ? event.instruction.operations.map((operation) => operation.kind)
              : [],
          ),
        ),
      ),
    ).toEqual(
      sorted([
        'consume-item-quantity',
        'grant-item-quantity',
        'merge-item-stacks',
        'move-character',
        'move-interactable',
        'set-character-state',
        'set-global-property',
        'set-interactable-state',
        'set-item-stack-traits',
        'set-property',
        'split-item-stack',
        'transfer-item-quantity',
        'unset-property',
      ]),
    );
    const worldOperations = vocabularyScene.program.events.flatMap((event) =>
      event.instruction.kind === 'runtime-world-transaction' ? event.instruction.operations : [],
    );
    expect(sorted(new Set(worldOperations.map((operation) => operation.kind)))).toEqual(
      sorted([
        'clear-configuration',
        'create-character',
        'create-interactable',
        'create-room',
        'destroy-instance',
        'replace-configuration',
        'retarget-room-exit',
      ]),
    );
    expect(
      sorted(
        new Set(
          worldOperations.flatMap((operation) =>
            'source' in operation ? [operation.source.kind] : [],
          ),
        ),
      ),
    ).toEqual(['archetype', 'compiled-instance', 'effective-instance']);
    expect(
      sorted(new Set(canonicalVocabulary.archetypes.map((item) => item.instanceKind))),
    ).toEqual(['character', 'interactable', 'room']);
    expect(
      sorted(
        new Set(
          [...scene.definitions.scenes, ...canonicalVocabulary.definitions.scenes].flatMap(
            (definition) =>
              definition.program.events.flatMap((event) =>
                event.instruction.kind === 'material-parameter'
                  ? [event.instruction.target.kind]
                  : [],
              ),
          ),
        ),
      ),
    ).toEqual(['actor', 'background', 'layout', 'postprocess']);
    expect(
      sorted(
        new Set(
          [...scene.definitions.scenes, ...canonicalVocabulary.definitions.scenes].flatMap(
            (definition) =>
              definition.program.events.flatMap((event) =>
                event.instruction.kind === 'transition-group'
                  ? event.instruction.children.map((child) => child.kind)
                  : [],
              ),
          ),
        ),
      ),
    ).toEqual(['actor-cue', 'clear-background', 'set-background', 'set-layout']);

    const intro = dialogue.definitions.dialogues.find((candidate) => candidate.id === 'intro')!;
    expect(sorted(new Set(intro.program.blocks.map((block) => block.kind)))).toEqual([
      'choice',
      'redirect',
      'sequence',
    ]);
    expect(sorted(new Set(intro.program.edges.map((edge) => edge.kind)))).toEqual([
      'choice',
      'next',
    ]);
    expect(
      sorted(
        new Set(
          intro.program.blocks.flatMap((block) =>
            block.kind === 'sequence' ? block.segments.map((segment) => segment.kind) : [],
          ),
        ),
      ),
    ).toEqual(['line', 'run-lua']);

    const cueDialogue = canonicalVocabulary.definitions.dialogues.find(
      (candidate) => candidate.id === 'cue-vocabulary',
    )!;
    const cueSegments = cueDialogue.program.blocks.flatMap((block) =>
      block.kind === 'sequence' ? block.segments : [],
    );
    expect(
      sorted(
        new Set(
          [
            ...cueSegments,
            ...intro.program.blocks.flatMap((block) =>
              block.kind === 'sequence' ? block.segments : [],
            ),
          ].map((segment) => segment.kind),
        ),
      ),
    ).toEqual(['call-scene', 'handoff', 'line', 'run-lua']);
    const cueLine = cueSegments.find((segment) => segment.kind === 'line');
    if (!cueLine || cueLine.kind !== 'line') throw new Error('Expected cue vocabulary line.');
    expect(sorted(new Set(cueLine.cues.map((cue) => cue.kind)))).toEqual([
      'camera',
      'gesture',
      'media',
      'sound-effect',
      'speaker-expression',
      'stage',
      'voice',
    ]);
    expect(
      sorted(
        new Set(cueLine.cues.flatMap((cue) => (cue.kind === 'camera' ? [cue.emphasis.kind] : []))),
      ),
    ).toEqual(['flash', 'punch', 'shake']);
    expect(
      sorted(
        new Set(
          cueDialogue.mediaSlots.flatMap((slot) => (slot.initial ? [slot.initial.kind] : [])),
        ),
      ),
    ).toEqual(['character', 'image']);

    expect(
      sorted(
        new Set(
          canonicalVocabulary.definitions.verbs.flatMap((verb) =>
            verb.slots.flatMap((slot) => slot.selectors.map((selector) => selector.kind)),
          ),
        ),
      ),
    ).toEqual(['any-subject', 'exact', 'family', 'item-definition', 'qualified-pattern', 'trait']);

    const actions = interaction.definitions.interactions.find(
      (candidate) => candidate.id === 'actions',
    )!;
    expect(sorted(new Set(actions.rules.map((rule) => rule.guard.kind)))).toEqual([
      'always',
      'global-property-comparison',
      'lua-predicate',
    ]);
    expect(actions.rules.map((rule) => rule.priority)).toEqual([10, 10, 20, 0, 5, 0]);
    const room = interaction.definitions.rooms.find((candidate) => candidate.id === 'start')!;
    expect(room.hotspots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inspect-door',
          target: { kind: 'owner-feature', featureId: 'door' },
          shape: { kind: 'rect', bounds: { x: 0.7, y: 0.1, width: 0.2, height: 0.5 } },
        }),
        expect.objectContaining({
          id: 'north-door',
          target: { kind: 'exit', exitId: 'north-exit' },
        }),
      ]),
    );
    const key = interaction.definitions.interactables.find((candidate) => candidate.id === 'key')!;
    expect(key.presentation.hotspots).toMatchObject({
      kind: 'sprite-alpha',
      hotspot: { id: 'key-alpha', highlight: { kind: 'default' } },
    });
    const coin = interaction.definitions.interactables.find(
      (candidate) => candidate.id === 'coin',
    )!;
    expect(coin.presentation.hotspots).toMatchObject({
      kind: 'custom',
      hotspots: [
        { id: 'coin-front', highlight: { kind: 'material' } },
        { id: 'coin-center', highlight: { kind: 'none' } },
      ],
    });
    expect(
      sorted(
        new Set(
          actions.rules.flatMap((rule) =>
            rule.slots.flatMap((slot) => slot.selectors.map((selector) => selector.kind)),
          ),
        ),
      ),
    ).toEqual(['exact', 'family']);
    expect(
      sorted(
        new Set(
          [actions, ...canonicalVocabulary.definitions.interactions].flatMap((interaction) =>
            interaction.rules.flatMap((rule) =>
              rule.program.instructions.map((instruction) => instruction.kind),
            ),
          ),
        ),
      ),
    ).toEqual(
      sorted([
        'apply-effect',
        'call-dialogue',
        'call-scene',
        'move-interactable',
        'notify',
        'set-interactable-state',
      ]),
    );
    expect(sorted(new Set(actions.rules.map((rule) => rule.program.outcome)))).toEqual([
      'handled',
      'unhandled',
    ]);
    expect(
      sorted(
        new Set(
          actions.rules.flatMap((rule) =>
            rule.program.instructions.flatMap((instruction) =>
              instruction.kind === 'move-interactable' ? [instruction.target.kind] : [],
            ),
          ),
        ),
      ),
    ).toEqual(['inventory', 'room']);

    expect(sorted(new Set(resources.resources.assets.map((asset) => asset.kind)))).toEqual([
      'audio',
      'binary',
      'data',
      'font',
      'image',
      'script',
      'shader-source',
      'text',
    ]);
    expect(
      sorted(
        new Set(
          resources.resources.layouts.flatMap((layout) => [
            layout.rml.kind,
            layout.rcss.kind,
            layout.lua.kind,
          ]),
        ),
      ),
    ).toEqual(['asset', 'inline']);
    expect(
      sorted(new Set(resources.resources.scripts.map((script) => script.source.kind))),
    ).toEqual(['asset', 'inline-lua']);
    const globalProperties = comprehensive.properties.filter(
      (property) => property.scope === 'global',
    );
    const identityProperties = comprehensive.properties.filter(
      (property) => property.scope === 'identity',
    );
    expect(sorted(new Set(globalProperties.map((property) => property.type)))).toEqual([
      'boolean',
      'enum',
      'integer',
      'number',
      'string',
    ]);
    expect(sorted(new Set(identityProperties.map((property) => property.type)))).toEqual([
      'boolean',
      'enum',
      'integer',
      'number',
      'string',
    ]);
    expect(sorted(new Set(comprehensive.properties.map((property) => property.scope)))).toEqual([
      'global',
      'identity',
    ]);
  });

  it('ignores editor metadata and authoring collection insertion order', () => {
    const first = comprehensiveGoldenProject();
    first.editor.recordMetadata = {
      rooms: { start: { color: '#ffffff', sortKey: '9', tags: [] } },
    };
    const reordered = comprehensiveGoldenProject();
    reordered.rooms = {
      tower: reordered.rooms.tower!,
      hall: reordered.rooms.hall!,
      start: reordered.rooms.start!,
    };
    reordered.editor.recordMetadata = {
      rooms: { hall: { color: '#000000', sortKey: '1', tags: [] } },
    };
    const left = compileAuthoringProject(first);
    const right = compileAuthoringProject(reordered);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.canonicalJson).toBe(right.canonicalJson);
  });
});
