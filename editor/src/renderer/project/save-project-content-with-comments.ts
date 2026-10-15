import type {
  ProjectContentSaveRequest,
  ProjectContentSaveResponse,
} from '../../shared/editor-tooling';
import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import { confirmProjectComments } from './project-comment-confirmation';

/** A source edit during review invalidates approval; re-prompt rather than committing stale comments. */
export async function saveProjectContentWithComments(
  projectSessionId: string,
  request: ProjectContentSaveRequest,
  editorState: EditorProjectState,
): Promise<{ response: ProjectContentSaveResponse; cancelled: boolean }> {
  let next = request;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const response = await window.noveltea.saveProjectContent(projectSessionId, next, editorState);
    if (!response.commentConfirmationRequired) return { response, cancelled: false };
    if (!response.commentConfirmationToken || !response.commentImpacts?.length)
      return {
        response: { ...response, error: 'Incomplete comment confirmation preflight.' },
        cancelled: false,
      };
    const decision = await confirmProjectComments(response.commentImpacts, request.operationLabel);
    if (decision === 'cancel') return { response, cancelled: true };
    next = {
      ...request,
      commentConfirmation: { token: response.commentConfirmationToken, decision },
    };
  }
  return {
    cancelled: false,
    response: {
      ok: false,
      success: false,
      error: 'Project source changed repeatedly during comment review.',
    },
  };
}
