import type { EditorProjectState } from '../../shared/project-schema/editor-project-state';
import { NodeProjectWorkspaceFileSystem } from '../../shared/project-workspace/node-project-workspace-file-system';
import { createHostProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import {
  ResidentProjectWorkspaceSession,
  type InvalidAuthoringSourceBlock,
  type RecoveryFileOwnershipHints,
  type ResidentProjectWorkspaceCoherence,
} from '../../shared/project-workspace/resident-project-workspace-session';
import type {
  LoadedProjectWorkspaceSnapshot,
  ProjectWorkspaceOpenResult,
} from '../../shared/project-workspace/project-workspace-service';

export type { InvalidAuthoringSourceBlock, RecoveryFileOwnershipHints };
export type ActiveProjectWorkspaceCoherence = ResidentProjectWorkspaceCoherence;

/**
 * Electron-main adapter for the reusable resident Project workspace session core.
 * The shared core owns caching, invalidation, recovery, serialization, and invalid-source safety;
 * this adapter supplies the Node filesystem/process host used by the editor.
 */
export class ActiveProjectWorkspaceSession extends ResidentProjectWorkspaceSession {
  private constructor(snapshot: LoadedProjectWorkspaceSnapshot, editorState: EditorProjectState) {
    super(snapshot, editorState, {
      fileSystem: new NodeProjectWorkspaceFileSystem(),
      createWorkspaceService: createHostProjectWorkspaceService,
    });
  }

  static fromOpened(
    opened: Extract<ProjectWorkspaceOpenResult, { ok: true }>,
  ): ActiveProjectWorkspaceSession {
    return new ActiveProjectWorkspaceSession(opened.snapshot, opened.editorState);
  }

  static fromSnapshot(
    snapshot: LoadedProjectWorkspaceSnapshot,
    editorState: EditorProjectState,
  ): ActiveProjectWorkspaceSession {
    return new ActiveProjectWorkspaceSession(snapshot, editorState);
  }
}
