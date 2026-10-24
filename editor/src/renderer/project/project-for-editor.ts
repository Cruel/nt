import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { decodeAuthoringProject } from '../../shared/project-schema/decode-authoring-project';
import { stripLocalEditorProjectState } from '../../shared/project-schema/editor-project-state';
import { useProjectStore } from './project-store';

/** Display/command-intent view only; native admission belongs to the session reply. */
export function projectForEditor(
  value: unknown,
  nativeSession = useProjectStore.getState().nativeSession,
): AuthoringProject | null {
  if (!value) return null;
  if (nativeSession) return value as AuthoringProject;
  const decoded = decodeAuthoringProject(stripLocalEditorProjectState(value));
  return decoded.project ? (value as AuthoringProject) : null;
}
