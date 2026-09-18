import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import type { EditorValidationAuthority, ValidationResponse } from '../../shared/editor-tooling';
import { canonicalProjectPersistenceContentJson } from '../../shared/project-schema/editor-project-state';
import type { ActiveProjectWorkspaceSession } from './active-project-workspace-session';

type SessionLocalValidator = () => Promise<ValidationResponse>;

type EditorAuthoringValidationServiceOptions = {
  readonly nativeTools?: NovelTeaCliNativeToolService;
};

export class EditorAuthoringValidationService {
  constructor(private readonly options: EditorAuthoringValidationServiceOptions = {}) {}

  private diskAuthoritative(
    workspace: ActiveProjectWorkspaceSession,
    project: unknown,
    authority: EditorValidationAuthority,
  ): boolean {
    if (authority !== 'disk-authoritative' || workspace.coherenceState() !== 'coherent')
      return false;
    try {
      return (
        canonicalProjectPersistenceContentJson(project) ===
        canonicalProjectPersistenceContentJson(workspace.project())
      );
    } catch {
      return false;
    }
  }

  async validate(input: {
    readonly workspace: ActiveProjectWorkspaceSession;
    readonly project: unknown;
    readonly authority: EditorValidationAuthority;
    readonly validateSessionLocal: SessionLocalValidator;
  }): Promise<ValidationResponse> {
    if (!this.diskAuthoritative(input.workspace, input.project, input.authority))
      return input.validateSessionLocal();

    const [{ runNovelTeaCli }, nativeTools] = await Promise.all([
      import('../../cli/application'),
      this.options.nativeTools
        ? Promise.resolve(this.options.nativeTools)
        : import('../../cli/native-tool-service-node').then((module) =>
            module.createNodeNovelTeaCliNativeToolService(),
          ),
    ]);
    const result = await runNovelTeaCli(['--json', 'validate'], {
      cwd: input.workspace.projectRoot(),
      nativeTools,
    });
    return {
      ok: true,
      success: result.envelope.success,
      diagnostics: result.envelope.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    };
  }
}
