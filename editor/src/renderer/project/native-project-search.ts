import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { buildProjectSearchIndex } from '../../shared/project-search/project-search-index';
import { referenceIndexFromCurrentGraph } from './authoring-graph-consumers';
import type { NativeRendererGraphSnapshot } from './native-authoring-graph-projection';

/** Presentation indexing only: references come from the revision-pinned native graph. */
export function buildNativeProjectSearchIndex(
  project: AuthoringProject,
  graph: NativeRendererGraphSnapshot,
) {
  return buildProjectSearchIndex(project, {
    referenceIndex: referenceIndexFromCurrentGraph(project, graph),
  });
}
