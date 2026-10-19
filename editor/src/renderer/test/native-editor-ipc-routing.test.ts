import { describe, expect, it } from 'vite-plus/test';
import { IPC_CHANNELS } from '../../shared/ipc-channels';
import { incompatibleLegacyNativeEditChannels } from '../../main/services/native-editor-ipc-routing';

describe('native editor IPC certification gate', () => {
  it('admits migrated Asset, file, compilation and export workflows', () => {
    for (const channel of [
      IPC_CHANNELS.IMPORT_ASSETS,
      IPC_CHANNELS.REIMPORT_ASSET,
      IPC_CHANNELS.IMPORT_UNTRACKED_PROJECT_ASSETS,
      IPC_CHANNELS.ORGANIZE_UNTRACKED_PROJECT_ASSET,
      IPC_CHANNELS.IMPORT_PROJECT_ATTACHMENT_FILES,
      IPC_CHANNELS.TRASH_PROJECT_ASSET_FILES,
      IPC_CHANNELS.RESTORE_PROJECT_ASSET_FILES,
      IPC_CHANNELS.COMPILE_SHADERS,
      IPC_CHANNELS.EXPORT_PACKAGE,
      IPC_CHANNELS.STAGE_PLATFORM_EXPORT,
      IPC_CHANNELS.EXPORT_PROJECT_TO_PLATFORM,
    ])
      expect(incompatibleLegacyNativeEditChannels.has(channel), channel).toBe(false);
  });

  it('still blocks unported tracked-source writers and legacy runtime preparation', () => {
    for (const channel of [
      IPC_CHANNELS.SAVE_PROJECT_CONTENT,
      IPC_CHANNELS.SAVE_PROJECT_COPY_AS,
      IPC_CHANNELS.MUTATE_PROJECT_SOURCES,
      IPC_CHANNELS.WRITE_PROJECT_SOURCE,
      IPC_CHANNELS.PURGE_PROJECT_TRASH,
      IPC_CHANNELS.PREPARE_EDITOR_RUNTIME,
    ])
      expect(incompatibleLegacyNativeEditChannels.has(channel), channel).toBe(true);
  });
});
