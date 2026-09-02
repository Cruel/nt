import type {
  CompiledGameplayCommand,
  CompiledProjectWire,
  FlowPredictionIndex,
} from './project-schema/compiled-project';

type PredictionProgram = FlowPredictionIndex['slices'][number]['program'];
type PredictionPoint = FlowPredictionIndex['slices'][number]['point'];

function summarizeGameplayCommands(
  commands: readonly CompiledGameplayCommand[],
): PredictionProgram {
  const result: PredictionProgram = [];
  for (const command of commands) {
    switch (command.kind) {
      case 'set-global-property':
        result.push({
          kind: 'set-global-property',
          property: command.property,
          value: command.value,
        });
        break;
      case 'unset-global-property':
        result.push({ kind: 'invalidate-global-property', property: command.property });
        break;
      case 'call-scene':
        result.push({ kind: 'call-scene', scene: command.scene });
        break;
      case 'call-dialogue':
        result.push({ kind: 'call-dialogue', dialogue: command.dialogue });
        break;
      case 'run-lua':
        result.push({ kind: 'opaque' });
        break;
      case 'if':
        result.push({
          kind: 'if',
          condition: command.condition,
          thenCommands: summarizeGameplayCommands(command.then),
          elseCommands: summarizeGameplayCommands(command.else),
        });
        break;
      default:
        // Mutations outside the admitted global-Property prediction subset are intentionally not
        // simulated. Conditions depending on those facts remain unknown at runtime and widen.
        break;
    }
  }
  return result;
}

/**
 * Compiles runtime-blind speculative prediction metadata from already-lowered Flow definitions.
 * Runtime consumes only this projection for the covered Flow semantics; mandatory dependency
 * collection remains a separate correctness path.
 */
export function compileFlowPredictionIndex(
  project: CompiledProjectWire,
): FlowPredictionIndex | undefined {
  if (
    project.definitions.scenes.length === 0 &&
    project.definitions.dialogues.length === 0 &&
    project.definitions.rooms.length === 0
  )
    return undefined;

  const dependencyGroups: FlowPredictionIndex['dependencyGroups'] = [];
  const dependencyGroupByKey = new Map<string, number>();
  const internDependencyGroup = (
    dependencies: FlowPredictionIndex['dependencyGroups'][number],
  ): number | null => {
    if (dependencies.length === 0) return null;
    const key = JSON.stringify(dependencies);
    const existing = dependencyGroupByKey.get(key);
    if (existing !== undefined) return existing;
    const index = dependencyGroups.length;
    dependencyGroups.push(dependencies);
    dependencyGroupByKey.set(key, index);
    return index;
  };

  const slices: FlowPredictionIndex['slices'] = [];
  const sliceByPoint = new Map<string, number>();
  const pointKey = (point: PredictionPoint): string => JSON.stringify(point);
  const addSlice = (
    point: PredictionPoint,
    dependencies: FlowPredictionIndex['dependencyGroups'][number] = [],
    program: PredictionProgram = [],
  ): number => {
    const dependencyGroup = internDependencyGroup(dependencies);
    const index = slices.length;
    slices.push({
      point,
      dependencyGroups: dependencyGroup === null ? [] : [dependencyGroup],
      successors: [],
      program,
    });
    sliceByPoint.set(pointKey(point), index);
    return index;
  };

  for (const scene of project.definitions.scenes) {
    const dependencies: FlowPredictionIndex['dependencyGroups'][number] = [];
    if (scene.stage.kind === 'blank' && scene.stage.background.asset)
      dependencies.push({ kind: 'asset', asset: scene.stage.background.asset });
    addSlice({ kind: 'scene-entry', scene: { kind: 'scene', id: scene.id } }, dependencies);
  }

  for (const dialogue of project.definitions.dialogues) {
    const dependencies: FlowPredictionIndex['dependencyGroups'][number] = [];
    for (const media of dialogue.mediaSlots) {
      if (media.visible && media.initial?.kind === 'image')
        dependencies.push({ kind: 'asset', asset: media.initial.asset });
    }
    addSlice(
      { kind: 'dialogue-entry', dialogue: { kind: 'dialogue', id: dialogue.id } },
      dependencies,
    );
  }

  const lifecycleStages = [
    ['before-leave', 'beforeLeave'],
    ['before-enter', 'beforeEnter'],
    ['presentation', null],
    ['after-leave', 'afterLeave'],
    ['after-enter', 'afterEnter'],
  ] as const;
  for (const room of project.definitions.rooms) {
    for (const [stage, lifecycleField] of lifecycleStages) {
      const dependencies =
        stage === 'presentation'
          ? ([
              { kind: 'room', room: { kind: 'room', id: room.id } },
            ] satisfies FlowPredictionIndex['dependencyGroups'][number])
          : [];
      const program =
        lifecycleField === null ? [] : summarizeGameplayCommands(room.lifecycle[lifecycleField]);
      if (lifecycleField !== null && room.scriptHooks.some((hook) => hook.hook === stage)) {
        // Runtime invokes the Room's Lua hook after the typed lifecycle command program. Keep
        // that ordering in the prediction summary, but treat the Lua boundary as opaque.
        program.push({ kind: 'opaque' });
      }
      addSlice(
        { kind: 'room-lifecycle', room: { kind: 'room', id: room.id }, stage },
        dependencies,
        program,
      );
    }
  }

  for (const scene of project.definitions.scenes) {
    if (scene.terminal.kind !== 'continue-scene') continue;
    const source = sliceByPoint.get(
      pointKey({ kind: 'scene-entry', scene: { kind: 'scene', id: scene.id } }),
    );
    const target = sliceByPoint.get(pointKey({ kind: 'scene-entry', scene: scene.terminal.scene }));
    if (source !== undefined && target !== undefined) slices[source]!.successors.push(target);
  }

  return { dependencyGroups, slices };
}
