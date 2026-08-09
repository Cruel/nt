import { searchProjectIndex } from '../project-search/project-search';
import type {
  ProjectSearchQuery,
  ProjectSearchResponse,
} from '../project-search/project-search-types';
import type { ProjectWorkspaceSnapshot } from './project-workspace-service';
import { buildProjectWorkspaceSearchIndex } from './project-workspace-service';

/** Snapshot-only project-search seam for renderer and future headless callers. */
export function searchProjectWorkspaceSnapshot(
  snapshot: ProjectWorkspaceSnapshot,
  query: ProjectSearchQuery,
): ProjectSearchResponse {
  return searchProjectIndex(buildProjectWorkspaceSearchIndex(snapshot), query);
}
