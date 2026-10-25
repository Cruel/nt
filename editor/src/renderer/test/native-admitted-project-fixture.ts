import type { ActiveProjectSessionService } from '../../main/services/active-project-session-service';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';

/** Test-only capability fixture for services downstream of native admission.
 * These tests exercise Asset/media authorization, not the native YAML parser;
 * worker/CLI integration tests independently certify actual admission. */
export async function admitNativeTestProject(
  sessions: ActiveProjectSessionService,
  projectFilePath: string,
  project: AuthoringProject,
): Promise<string> {
  const generation = sessions.beginProjectActivation();
  const id = await sessions.stageNativeProjectFile(projectFilePath, generation);
  await sessions.acceptNativeProject(id, project);
  sessions.commitStagedNativeProject(id, generation);
  return id;
}
