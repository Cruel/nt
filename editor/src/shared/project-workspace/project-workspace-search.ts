import { searchProjectIndex } from '../project-search/project-search';
import type {
  ProjectSearchQuery,
  ProjectSearchResponse,
} from '../project-search/project-search-types';
import type { ProjectWorkspaceSnapshot } from './project-workspace-service';
import { buildProjectWorkspaceSearchIndex } from './project-workspace-service';
import type { ReferenceIndex } from '../project-schema/authoring-references';

/** Snapshot-only project-search seam for renderer and future headless callers. */
export function searchProjectWorkspaceSnapshot(
  snapshot: ProjectWorkspaceSnapshot,
  query: ProjectSearchQuery,
  referenceIndex?: ReferenceIndex,
): ProjectSearchResponse {
  return searchProjectIndex(buildProjectWorkspaceSearchIndex(snapshot, referenceIndex), query);
}
