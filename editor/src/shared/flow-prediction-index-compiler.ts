import type {
  CompiledGameplayCommand,
  CompiledProjectWire,
  FlowPredictionIndex,
} from './project-schema/compiled-project';

type PredictionDependency = FlowPredictionIndex['dependencyGroups'][number][number];
type PredictionProgram = FlowPredictionIndex['slices'][number]['program'];
type PredictionPoint = FlowPredictionIndex['slices'][number]['point'];
type PredictionSlice = FlowPredictionIndex['slices'][number];
type SceneInstruction =
  CompiledProjectWire['definitions']['scenes'][number]['program']['events'][number]['instruction'];

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

function appendBackgroundDependencies(
  dependencies: PredictionDependency[],
  background: {
    asset: { kind: 'asset'; id: string } | null;
    material: { kind: 'material'; id: string } | null;
  },
) {
  if (background.asset) dependencies.push({ kind: 'asset', asset: background.asset });
  if (background.material) dependencies.push({ kind: 'material', material: background.material });
}

function sceneInstructionDependencies(instruction: SceneInstruction): PredictionDependency[] {
  const dependencies: PredictionDependency[] = [];
  switch (instruction.kind) {
    case 'set-background':
      appendBackgroundDependencies(dependencies, instruction);
      break;
    case 'actor-cue':
      if (instruction.action !== 'hide') {
        dependencies.push({
          kind: 'character',
          character: instruction.character,
          profileId: instruction.profileId,
          poseId: instruction.poseId,
          expressionId: instruction.expressionId,
          appearanceId: instruction.appearanceId,
        });
      }
      break;
    case 'audio-cue':
      if (instruction.asset && ['play', 'fade-in'].includes(instruction.action))
        dependencies.push({
          kind: 'audio',
          asset: instruction.asset,
          purpose: instruction.purpose,
        });
      break;
    case 'set-layout':
      if (instruction.action !== 'hide' && instruction.layout)
        dependencies.push({ kind: 'layout', layout: instruction.layout });
      break;
    case 'material-parameter':
      dependencies.push({ kind: 'material', material: instruction.material });
      break;
    case 'postprocess-effect':
      if (instruction.action === 'upsert' && instruction.material)
        dependencies.push({ kind: 'material', material: instruction.material });
      break;
    case 'transition-group':
      for (const child of instruction.children) {
        if (child.kind === 'set-background') appendBackgroundDependencies(dependencies, child);
        else if (child.kind === 'actor-cue' && child.action !== 'hide') {
          dependencies.push({
            kind: 'character',
            character: child.character,
            profileId: child.profileId,
            poseId: child.poseId,
            expressionId: child.expressionId,
            appearanceId: child.appearanceId,
          });
        } else if (child.kind === 'set-layout' && child.action !== 'hide' && child.layout) {
          dependencies.push({ kind: 'layout', layout: child.layout });
        }
      }
      break;
    default:
      break;
  }
  return dependencies;
}

function sceneInstructionProgram(instruction: SceneInstruction): PredictionProgram {
  switch (instruction.kind) {
    case 'call-scene':
      return [{ kind: 'call-scene', scene: instruction.scene }];
    case 'start-detached-scene':
      return [{ kind: 'start-detached-scene', scene: instruction.scene }];
    case 'call-dialogue':
      return [{ kind: 'call-dialogue', dialogue: instruction.dialogue }];
    case 'gameplay-effect-batch':
      return summarizeGameplayCommands(instruction.operations);
    case 'run-lua':
      return [{ kind: 'opaque' }];
    default:
      return [];
  }
}

function sceneInstructionFrontier(instruction: SceneInstruction): PredictionSlice['frontier'] {
  switch (instruction.kind) {
    case 'choice':
      return 'decision';
    case 'wait-input':
    case 'wait-condition':
    case 'wait-operation':
    case 'wait-audio':
    case 'wait-layout-signal':
      return 'strong-wait';
    case 'wait-duration':
      return instruction.durationMs <= 2_000 ? 'short-wait' : 'strong-wait';
    case 'show-text':
      return instruction.wait === 'input' ? 'strong-wait' : 'normal';
    case 'audio-cue':
      return instruction.waitForCompletion ? 'strong-wait' : 'normal';
    case 'set-background':
    case 'actor-cue':
    case 'set-layout':
    case 'material-parameter':
    case 'transition-group':
      if (!instruction.waitForCompletion) return 'normal';
      return instruction.durationMs <= 2_000 ? 'short-wait' : 'strong-wait';
    case 'run-lua':
      return instruction.mayYield ? 'strong-wait' : 'normal';
    default:
      return 'normal';
  }
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
    options: { condition?: PredictionSlice['condition']; frontier: PredictionSlice['frontier'] } = {
      frontier: 'normal',
    },
  ): number => {
    const dependencyGroup = internDependencyGroup(dependencies);
    const index = slices.length;
    slices.push({
      point,
      dependencyGroups: dependencyGroup === null ? [] : [dependencyGroup],
      ...(options.condition ? { condition: options.condition } : {}),
      conditionFalseSuccessor: null,
      control: { kind: 'sequential', successor: null },
      frontier: options.frontier,
      program,
    });
    sliceByPoint.set(pointKey(point), index);
    return index;
  };
  const findSlice = (point: PredictionPoint): number | undefined =>
    sliceByPoint.get(pointKey(point));

  for (const scene of project.definitions.scenes) {
    const sceneRef = { kind: 'scene' as const, id: scene.id };
    const stageDependencies: PredictionDependency[] = [];
    if (scene.stage.kind === 'staged-room') {
      stageDependencies.push({ kind: 'room', room: scene.stage.room });
    } else if (scene.stage.kind === 'blank') {
      appendBackgroundDependencies(stageDependencies, scene.stage.background);
      if (scene.stage.layout)
        stageDependencies.push({ kind: 'layout', layout: scene.stage.layout });
    }
    addSlice({ kind: 'scene-entry', scene: sceneRef }, stageDependencies);
    for (const event of scene.program.events) {
      addSlice(
        { kind: 'scene-step', scene: sceneRef, stepId: event.id },
        sceneInstructionDependencies(event.instruction),
        sceneInstructionProgram(event.instruction),
        {
          condition: event.instruction.condition,
          frontier: sceneInstructionFrontier(event.instruction),
        },
      );
    }
    addSlice({ kind: 'scene-terminal', scene: sceneRef });
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
    const sceneRef = { kind: 'scene' as const, id: scene.id };
    const terminalPoint = { kind: 'scene-terminal' as const, scene: sceneRef };
    const terminal = findSlice(terminalPoint);
    const first = scene.program.events[0];
    const firstPoint: PredictionPoint = first
      ? { kind: 'scene-step', scene: sceneRef, stepId: first.id }
      : terminalPoint;
    const entry = findSlice({ kind: 'scene-entry', scene: sceneRef });
    const firstSlice = findSlice(firstPoint);
    if (entry !== undefined)
      slices[entry]!.control = { kind: 'sequential', successor: firstSlice ?? null };

    for (let index = 0; index < scene.program.events.length; index += 1) {
      const event = scene.program.events[index]!;
      const instruction = event.instruction;
      const sliceIndex = findSlice({ kind: 'scene-step', scene: sceneRef, stepId: event.id });
      if (sliceIndex === undefined) continue;
      const sequentialEvent = scene.program.events[index + 1];
      const sequential = sequentialEvent
        ? findSlice({ kind: 'scene-step', scene: sceneRef, stepId: sequentialEvent.id })
        : terminal;
      slices[sliceIndex]!.conditionFalseSuccessor = instruction.condition
        ? (sequential ?? null)
        : null;

      if (instruction.kind === 'conditional-branch') {
        const branches = instruction.branches.flatMap((branch) => {
          const target = findSlice({
            kind: 'scene-step',
            scene: sceneRef,
            stepId: branch.targetInstructionId,
          });
          return target === undefined ? [] : [{ condition: branch.condition, target }];
        });
        const fallback = findSlice({
          kind: 'scene-step',
          scene: sceneRef,
          stepId: instruction.fallbackInstructionId,
        });
        if (fallback !== undefined)
          slices[sliceIndex]!.control = { kind: 'branch', branches, fallback };
        continue;
      }
      if (instruction.kind === 'choice') {
        const options = instruction.options.flatMap((option) => {
          const target = findSlice({
            kind: 'scene-step',
            scene: sceneRef,
            stepId: option.targetInstructionId,
          });
          return target === undefined
            ? []
            : [
                {
                  optionId: option.id,
                  ...(option.condition ? { condition: option.condition } : {}),
                  programs: option.effects.map((effect) => summarizeGameplayCommands([effect])),
                  target,
                },
              ];
        });
        slices[sliceIndex]!.control = { kind: 'choice', options };
        continue;
      }
      slices[sliceIndex]!.control = { kind: 'sequential', successor: sequential ?? null };
    }

    if (terminal === undefined) continue;
    if (scene.terminal.kind === 'continue-scene') {
      slices[terminal]!.control = {
        kind: 'sequential',
        successor: findSlice({ kind: 'scene-entry', scene: scene.terminal.scene }) ?? null,
      };
    } else if (scene.terminal.kind === 'continue-dialogue') {
      slices[terminal]!.control = {
        kind: 'sequential',
        successor: findSlice({ kind: 'dialogue-entry', dialogue: scene.terminal.dialogue }) ?? null,
      };
    }
  }

  return { dependencyGroups, slices };
}
