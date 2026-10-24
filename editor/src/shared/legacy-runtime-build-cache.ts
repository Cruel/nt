/** Legacy production cache publication adapter, removed with Project authority in #521. */
import { validateAuthoringProject } from './project-schema/authoring-validation';
import {
  publishCanonicalRuntimeBuildCache as publishNativeCanonical,
  publishRuntimeBuildCacheVariant as publishNativeVariant,
} from './runtime-build-cache';

export * from './runtime-build-cache';

export function publishCanonicalRuntimeBuildCache(
  ...args: Parameters<typeof publishNativeCanonical>
) {
  return publishNativeCanonical(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
    args[8],
    args[9],
    args[10],
    validateAuthoringProject,
  );
}

export function publishRuntimeBuildCacheVariant(...args: Parameters<typeof publishNativeVariant>) {
  return publishNativeVariant(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    args[7],
    args[8],
    args[9],
    args[10],
    validateAuthoringProject,
  );
}
