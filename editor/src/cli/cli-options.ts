import type { CliTerminalContext } from './commands/types';
import type { NovelTeaAgentKitPayload } from './agent-kit';
import type { WorkflowLibraryServiceOptions } from '../main/services/comfyui-workflow-library-service';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import type { NativeResidentProjectOwner } from '../shared/project-workspace/native-resident-project-owner';
import type { ScopedReadAuthorityToken } from '../shared/scoped-read-authority';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';

export interface CliScopedReadAuthority {
  captureScopedReadAuthority(
    projectRoot: string,
    requiredSemanticPaths: readonly string[],
  ): Promise<ScopedReadAuthorityToken | null>;
  verifyScopedReadAuthority(token: ScopedReadAuthorityToken): Promise<boolean>;
}

export interface RunNovelTeaCliOptions {
  readonly cwd?: string;
  readonly terminal?: CliTerminalContext;
  readonly fileSystem?: ProjectWorkspaceFileSystem;
  readonly residentWorkspace?: NativeResidentProjectOwner;
  readonly scopedReadAuthority?: CliScopedReadAuthority;
  readonly nativeTools?: NovelTeaCliNativeToolService;
  readonly nativeProjectCommands?: import('./native-project-lifecycle-cli').NativeProjectCommandCall;
  readonly platformTools?: NovelTeaCliPlatformToolService;
  readonly onPlatformProgress?: (stage: string, message: string) => void;
  readonly agentKitPayload?: NovelTeaAgentKitPayload;
  readonly stdinText?: string;
  readonly readStdinText?: () => string;
  readonly forceRuntimeCacheRebuild?: boolean;
  readonly comfyUiWorkflowLibraryOptions?: WorkflowLibraryServiceOptions;
  readonly abortSignal?: AbortSignal;
  readonly onComfyUiProgress?: (stage: 'queued' | 'running' | 'completed', message: string) => void;
  readonly prepareResidentSnapshotOnly?: boolean;
  readonly trustPinnedResidentSnapshot?: boolean;
  readonly pinnedNativePreparation?: Readonly<{
    projectRoot: string;
    preparation:
      | import('../shared/project-workspace/native-project-preparation-contracts').NativeResidentProjectPreparation
      | null;
  }>;
  readonly pinnedExternalAssets?: readonly import('./pinned-external-assets').PinnedExternalAssetExpectation[];
  readonly pinnedProjectTextSources?: Readonly<
    Record<string, Readonly<{ text: string; contentHash?: string }>>
  >;
  readonly runtimeArtifactPaths?: import('../shared/runtime-artifact-preparation').RuntimeArtifactPathAdapter;
  readonly pinnedRuntimeBuildCacheInputs?:
    | import('../shared/runtime-build-cache').PinnedRuntimeBuildCacheInputs
    | null;
}
