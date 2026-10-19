import { IPC_CHANNELS } from '../../shared/ipc-channels';

/** Only legacy, unported authoring writers and readers are rejected by the
 * certification gate. Migrated Asset operations, native export and auxiliary
 * build-only shader compilation must remain callable from the workbench. */
export const incompatibleLegacyNativeEditChannels = new Set<string>([
  IPC_CHANNELS.SAVE_PROJECT_CONTENT,
  IPC_CHANNELS.WRITE_PROJECT_SOURCE,
  IPC_CHANNELS.PURGE_PROJECT_TRASH,
  IPC_CHANNELS.VALIDATE_PROJECT,
  IPC_CHANNELS.PREPARE_EDITOR_RUNTIME,
  IPC_CHANNELS.RUN_PLAYBACK_TEST,
  IPC_CHANNELS.RUN_PLAYBACK_SUITE,
  IPC_CHANNELS.RUN_PLAYBACK_SPEC,
  IPC_CHANNELS.RUN_UI_PLAYBACK_SPEC,
]);
