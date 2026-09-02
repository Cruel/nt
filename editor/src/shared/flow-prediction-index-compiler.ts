import type { CompiledProjectWire, FlowPredictionIndex } from './project-schema/compiled-project';

/**
 * Compiles runtime-blind speculative prediction metadata from already-lowered Flow definitions.
 * The tracer bullet intentionally recognizes only deterministic Scene continuation and blank-Stage
 * image dependencies; later Flow hosts deepen this module without teaching runtime to re-walk them.
 */
export function compileFlowPredictionIndex(
  project: CompiledProjectWire,
): FlowPredictionIndex | undefined {
  const participatingScenes = new Set<string>();
  project.definitions.scenes.forEach((scene) => {
    if (scene.terminal.kind !== 'continue-scene') return;
    participatingScenes.add(scene.id);
    participatingScenes.add(scene.terminal.scene.id);
  });
  if (participatingScenes.size === 0) return undefined;

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

  const sceneSliceById = new Map<string, number>();
  const indexedScenes = project.definitions.scenes.filter((scene) =>
    participatingScenes.has(scene.id),
  );
  const slices: FlowPredictionIndex['slices'] = indexedScenes.map((scene, index) => {
    sceneSliceById.set(scene.id, index);
    const localDependencies: FlowPredictionIndex['dependencyGroups'][number] = [];
    if (scene.stage.kind === 'blank' && scene.stage.background.asset) {
      localDependencies.push({ kind: 'asset', asset: scene.stage.background.asset });
    }
    const dependencyGroup = internDependencyGroup(localDependencies);
    return {
      point: { kind: 'scene-entry' as const, scene: { kind: 'scene' as const, id: scene.id } },
      dependencyGroups: dependencyGroup === null ? [] : [dependencyGroup],
      successors: [],
    };
  });

  indexedScenes.forEach((scene, index) => {
    if (scene.terminal.kind !== 'continue-scene') return;
    const successor = sceneSliceById.get(scene.terminal.scene.id);
    if (successor !== undefined) slices[index]!.successors.push(successor);
  });

  return { dependencyGroups, slices };
}
