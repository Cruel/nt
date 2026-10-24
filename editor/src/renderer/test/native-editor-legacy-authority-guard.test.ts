import { describe, expect, it } from 'vite-plus/test';
import { InMemoryProjectWorkspaceFileSystem } from '../../shared/project-workspace/testing';
import { guardNativeEditorProjectAuthority } from '../../shared/project-workspace/legacy-project-authority-guard';
import { createHostProjectWorkspaceService } from '../../shared/project-workspace/node-project-workspace-service';
import { ProjectWorkspaceService } from '../../shared/project-workspace/project-workspace-service';
import { ProjectWorkspaceTransactionService } from '../../shared/project-workspace/project-workspace-transaction';
import { startProjectWorkspaceWatcher } from '../../main/services/project-workspace-watcher-service';
import { EditorAuthoringValidationService } from '../../main/services/editor-authoring-validation-service';
import { EditorRuntimeCacheService } from '../../main/services/editor-runtime-cache-service';

describe('native editor Project authority tripwire', () => {
  it('rejects direct, factory, lazy writer and watcher construction, then restores legacy use', async () => {
    const fileSystem = new InMemoryProjectWorkspaceFileSystem({});
    const release = guardNativeEditorProjectAuthority();
    try {
      expect(() => new ProjectWorkspaceService(fileSystem)).toThrow(
        'Native editor reached retired TypeScript Project authority: ProjectWorkspaceService',
      );
      expect(() => createHostProjectWorkspaceService(fileSystem)).toThrow(
        'Native editor reached retired TypeScript Project authority: createHostProjectWorkspaceService',
      );
      // A late dynamic import or a cache miss must not bypass the same
      // process-wide admitted-native authority boundary.
      const lazyFactory =
        await import('../../shared/project-workspace/node-project-workspace-service');
      expect(() => lazyFactory.createNodeProjectWorkspaceService()).toThrow(
        'Native editor reached retired TypeScript Project authority: createHostProjectWorkspaceService',
      );
      expect(
        () =>
          new ProjectWorkspaceTransactionService(
            fileSystem,
            { isProcessAlive: async () => null },
            1,
          ),
      ).toThrow(
        'Native editor reached retired TypeScript Project authority: ProjectWorkspaceTransactionService',
      );
      expect(() => new EditorAuthoringValidationService()).toThrow(
        'Native editor reached retired TypeScript Project authority: EditorAuthoringValidationService',
      );
      expect(() => new EditorRuntimeCacheService()).toThrow(
        'Native editor reached retired TypeScript Project authority: EditorRuntimeCacheService',
      );
      await expect(
        startProjectWorkspaceWatcher(
          null,
          'native',
          '/tmp/unused',
          null as never,
          () => false,
          async () => {},
        ),
      ).rejects.toThrow(
        'Native editor reached retired TypeScript Project authority: startProjectWorkspaceWatcher',
      );
    } finally {
      release();
      release();
    }
    expect(() => createHostProjectWorkspaceService(fileSystem)).not.toThrow();
  });

  it('retains the native guard until the last lifetime owner releases it', () => {
    const first = guardNativeEditorProjectAuthority();
    const second = guardNativeEditorProjectAuthority();
    first();
    const files = new InMemoryProjectWorkspaceFileSystem({});
    try {
      expect(() => new ProjectWorkspaceService(files)).toThrow(
        'Native editor reached retired TypeScript Project authority',
      );
    } finally {
      second();
    }
    expect(() => new ProjectWorkspaceService(files)).not.toThrow();
  });
});
