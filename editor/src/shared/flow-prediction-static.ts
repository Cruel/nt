import type { CompiledCondition } from './project-schema/compiled-project';

export type StaticPredictionTruth = 'true' | 'false' | 'unknown';

export function staticPredictionTruth(condition: CompiledCondition): StaticPredictionTruth {
  if (condition.kind === 'always') return 'true';
  if (condition.kind === 'not') {
    const child = staticPredictionTruth(condition.condition);
    return child === 'true' ? 'false' : child === 'false' ? 'true' : 'unknown';
  }
  if (condition.kind === 'all') {
    let unknown = false;
    for (const child of condition.conditions) {
      const value = staticPredictionTruth(child);
      if (value === 'false') return 'false';
      unknown ||= value === 'unknown';
    }
    return unknown ? 'unknown' : 'true';
  }
  if (condition.kind === 'any') {
    let unknown = false;
    for (const child of condition.conditions) {
      const value = staticPredictionTruth(child);
      if (value === 'true') return 'true';
      unknown ||= value === 'unknown';
    }
    return unknown ? 'unknown' : 'false';
  }
  return 'unknown';
}
