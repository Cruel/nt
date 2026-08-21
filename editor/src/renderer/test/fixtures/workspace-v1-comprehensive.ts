import { NOVELTEA_PROJECT_AGENTS_BOOTSTRAP } from '../../../shared/project-workspace/agent-bootstrap';
import {
  projectWorkspaceFiles,
  projectWorkspaceLocalStateFile,
} from '../../../shared/project-workspace/project-workspace-service';
import { defaultTestData } from '../../../shared/project-schema/authoring-tests';
import { comprehensiveGoldenProject } from './compiled-project-golden-projects';

export const FINAL_WORKSPACE_FIXTURE_ROOT = '/fixtures/workspace-v1-comprehensive';

export function finalWorkspaceV1SourceTreeFixture(): Readonly<Record<string, string>> {
  const project = comprehensiveGoldenProject();
  project.tests['smoke-test'] = {
    id: 'smoke-test',
    label: 'Smoke Test',
    data: defaultTestData('Smoke Test'),
  };

  const tracked = projectWorkspaceFiles(project, project.editor);
  const files: Record<string, string> = {
    ...tracked,
    'AGENTS.md': NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
    '.gitignore': '/.noveltea/\n/dist/\n',
    '.noveltea/editor/state.json': projectWorkspaceLocalStateFile(
      project.editor,
      `sha256:${'0'.repeat(64)}`,
    ),
  };

  for (const record of Object.values(project.assets)) {
    files[record.data.source.path] ??= `fixture bytes for ${record.id}\n`;
  }

  return Object.fromEntries(
    Object.entries(files).map(([relativePath, content]) => [
      `${FINAL_WORKSPACE_FIXTURE_ROOT}/${relativePath}`,
      content,
    ]),
  );
}
