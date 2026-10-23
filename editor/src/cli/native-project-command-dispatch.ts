import path from 'node:path';
import type { ParsedGlobalArguments } from './bootstrap';
import type { NovelTeaCliCommandResult } from './contracts';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import type { NovelTeaCliPlatformToolService } from './platform-tool-service';
import type { RunNovelTeaCliOptions } from './application';

/** Shared native Project dispatch for standalone and daemon ScriptC hosts.
 * A non-claimed Project command is never silently dispatched to TypeScript
 * authoring. The caller must reject it before any legacy admission. */
export async function dispatchNativeProjectCommand(
  globals: ParsedGlobalArguments,
  cwd: string,
  options: RunNovelTeaCliOptions,
  nativeTools: NovelTeaCliNativeToolService,
  platformTools: NovelTeaCliPlatformToolService,
): Promise<NovelTeaCliCommandResult | null> {
  if (options.nativeProjectCommands) {
    // The native candidate owns the complete public validation result. This
    // path never opens the retired TypeScript authoring Project/workspace.
    if (!options.prepareResidentSnapshotOnly && !options.trustPinnedResidentSnapshot) {
      const { runNativeProjectValidationCli } = await import('./native-project-validation-cli');
      const nativeValidation = await runNativeProjectValidationCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        nativeTools,
        options.fileSystem,
      );
      if (nativeValidation) return nativeValidation;
    }
    // Disposable shaders consume the native preparation embedded in the pinned snapshot.
    // Never invoke disk-backed native Project admission in a disposable worker.
    if (
      !options.prepareResidentSnapshotOnly &&
      (!options.residentWorkspace || options.trustPinnedResidentSnapshot)
    ) {
      const { runNativeProjectShadersCli } = await import('./native-project-shaders-cli');
      const nativeShaders = await runNativeProjectShadersCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        nativeTools,
        options.pinnedNativePreparation,
      );
      if (nativeShaders) return nativeShaders;
    }
    if (!options.prepareResidentSnapshotOnly) {
      const { runNativeProjectTestsCli } = await import('./native-project-tests-cli');
      const nativeTests = await runNativeProjectTestsCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        nativeTools,
        {
          ...(options.trustPinnedResidentSnapshot
            ? {
                pinned: options.pinnedNativePreparation ?? {
                  projectRoot: path.resolve(cwd, globals.project ?? '.'),
                  preparation: null,
                },
              }
            : {}),
          pinnedRuntimeBuildCacheInputs: options.pinnedRuntimeBuildCacheInputs,
          pinnedExternalAssets: options.pinnedExternalAssets,
          pinnedProjectTextSources: options.pinnedProjectTextSources,
          paths: options.runtimeArtifactPaths,
          fileSystem: options.fileSystem,
          abortSignal: options.abortSignal,
          forceRuntimeCacheRebuild: options.forceRuntimeCacheRebuild,
          readStdinText: () => options.stdinText ?? options.readStdinText?.(),
        },
      );
      if (nativeTests) return nativeTests;
    }
    if (!options.prepareResidentSnapshotOnly) {
      const { runNativeProjectPackageCli } = await import('./native-project-package-cli');
      const nativePackage = await runNativeProjectPackageCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        nativeTools,
        {
          ...(options.trustPinnedResidentSnapshot
            ? {
                pinned: options.pinnedNativePreparation ?? {
                  projectRoot: path.resolve(cwd, globals.project ?? '.'),
                  preparation: null,
                },
              }
            : {}),
          pinnedExternalAssets: options.pinnedExternalAssets,
          pinnedProjectTextSources: options.pinnedProjectTextSources,
          paths: options.runtimeArtifactPaths,
          fileSystem: options.fileSystem,
          abortSignal: options.abortSignal,
        },
      );
      if (nativePackage) return nativePackage;
    }
    if (!options.prepareResidentSnapshotOnly) {
      const { runNativeProjectPlatformCli } = await import('./native-project-platform-cli');
      const nativePlatform = await runNativeProjectPlatformCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        platformTools,
        {
          ...(options.trustPinnedResidentSnapshot
            ? {
                pinned: options.pinnedNativePreparation ?? {
                  projectRoot: path.resolve(cwd, globals.project ?? '.'),
                  preparation: null,
                },
              }
            : {}),
          pinnedExternalAssets: options.pinnedExternalAssets,
          pinnedProjectTextSources: options.pinnedProjectTextSources,
          paths: options.runtimeArtifactPaths,
          fileSystem: options.fileSystem,
          abortSignal: options.abortSignal,
          onProgress: options.onPlatformProgress,
        },
      );
      if (nativePlatform) return nativePlatform;
    }
    // Export workers copy only the exact source inventory captured by native owner admission;
    // the native exporter rejects live drift without parsing or substituting a newer Project.
    if (!options.prepareResidentSnapshotOnly) {
      const { runNativeProjectLifecycleCli } = await import('./native-project-lifecycle-cli');
      const nativeLifecycle = await runNativeProjectLifecycleCli(
        globals,
        cwd,
        options.nativeProjectCommands,
        options.trustPinnedResidentSnapshot
          ? (options.pinnedNativePreparation ?? {
              projectRoot: path.resolve(cwd, globals.project ?? '.'),
              preparation: null,
            })
          : undefined,
      );
      if (nativeLifecycle) return nativeLifecycle;
    }
    const { runNativeProjectReadsCli } = await import('./native-project-reads-cli');
    const nativeRead = await runNativeProjectReadsCli(globals, cwd, options.nativeProjectCommands);
    if (nativeRead) return nativeRead;
    const { runNativeProjectMutationsCli } = await import('./native-project-mutations-cli');
    const nativeMutation = await runNativeProjectMutationsCli(
      globals,
      cwd,
      options.nativeProjectCommands,
    );
    if (nativeMutation) return nativeMutation;
    const { runNativeProjectFmtCli } = await import('./native-project-fmt-cli');
    const nativeFmt = await runNativeProjectFmtCli(globals, cwd, options.nativeProjectCommands);
    if (nativeFmt) return nativeFmt;
    const { runNativeProjectLocalizationCli } = await import('./native-project-localization-cli');
    const nativeLocalization = await runNativeProjectLocalizationCli(
      globals,
      cwd,
      options.nativeProjectCommands,
    );
    if (nativeLocalization) return nativeLocalization;
    const { runNativeProjectReconcileCli } = await import('./native-project-reconcile-cli');
    const nativeReconciliation = await runNativeProjectReconcileCli(
      globals,
      cwd,
      options.nativeProjectCommands,
      () => options.stdinText ?? options.readStdinText?.(),
    );
    if (nativeReconciliation) return nativeReconciliation;
  }
  return null;
}
