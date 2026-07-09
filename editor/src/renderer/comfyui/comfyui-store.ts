import { create } from 'zustand';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import { defaultComfyUiConfig, normalizeComfyUiServerUrl } from '../../shared/comfyui';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useProjectStore } from '@/project/project-store';
import { checkComfyUiConnection as requestComfyUiConnection, getComfyUiQueue as requestComfyUiQueue } from './comfyui-service';
import { triggerComfyUiWorkflowVerification } from './comfyui-workflow-library-store';

interface CheckConnectionOptions {
  showChecking?: boolean;
}

interface ComfyUiStore {
  config: ComfyUiConfig;
  status: ComfyUiStatus;
  progress: ComfyUiQueueProgress;
  hydrateFromPreferences: () => void;
  checkConnection: (config?: ComfyUiConfig, options?: CheckConnectionOptions) => Promise<ComfyUiStatus>;
  refreshQueue: (config?: ComfyUiConfig) => Promise<ComfyUiQueueProgress>;
  setProgress: (progress: ComfyUiQueueProgress) => void;
}

function disabledStatus(config = defaultComfyUiConfig()): ComfyUiStatus {
  return {
    state: 'disabled',
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
    checkedAt: null,
    message: 'ComfyUI disabled',
    queueRemaining: null,
  };
}

function uncheckedStatus(config = defaultComfyUiConfig()): ComfyUiStatus {
  return {
    state: 'unchecked',
    serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
    checkedAt: null,
    message: 'ComfyUI enabled; connection has not been checked yet.',
    queueRemaining: null,
  };
}

function idleProgress(): ComfyUiQueueProgress {
  return {
    promptId: null,
    workflowId: null,
    state: 'idle',
    queueRemaining: null,
    currentNode: null,
    progressValue: null,
    progressMax: null,
    message: null,
  };
}

function visibleStatusChanged(previous: ComfyUiStatus, next: ComfyUiStatus) {
  return previous.state !== next.state
    || previous.serverUrl !== next.serverUrl
    || previous.message !== next.message
    || previous.queueRemaining !== next.queueRemaining;
}

function progressChanged(previous: ComfyUiQueueProgress, next: ComfyUiQueueProgress) {
  return previous.promptId !== next.promptId
    || previous.workflowId !== next.workflowId
    || previous.state !== next.state
    || previous.queueRemaining !== next.queueRemaining
    || previous.currentNode !== next.currentNode
    || previous.progressValue !== next.progressValue
    || previous.progressMax !== next.progressMax
    || previous.message !== next.message;
}

function requestStillCurrent(requestConfig: ComfyUiConfig, currentConfig: ComfyUiConfig) {
  return requestConfig === currentConfig;
}

function configChanged(previous: ComfyUiConfig, next: ComfyUiConfig) {
  return previous.enabled !== next.enabled
    || previous.serverUrl !== next.serverUrl
    || previous.defaultWorkflowId !== next.defaultWorkflowId
    || previous.requestTimeoutMs !== next.requestTimeoutMs
    || previous.connectionCheckIntervalMs !== next.connectionCheckIntervalMs
    || previous.defaultWorkflows['image.generate'] !== next.defaultWorkflows['image.generate']
    || previous.defaultWorkflows['image.edit'] !== next.defaultWorkflows['image.edit'];
}

export const useComfyUiStore = create<ComfyUiStore>()((set, get) => ({
  config: defaultComfyUiConfig(),
  status: disabledStatus(),
  progress: idleProgress(),
  hydrateFromPreferences: () => {
    const config = { ...usePreferencesStore.getState().comfyUiConfig };
    set({
      config,
      status: config.enabled
        ? uncheckedStatus(config)
        : disabledStatus(config),
      progress: idleProgress(),
    });
  },
  checkConnection: async (overrideConfig, options = {}) => {
    const config = overrideConfig ?? get().config;
    if (!config.enabled) {
      const status = disabledStatus(config);
      const current = get();
      if (visibleStatusChanged(current.status, status) || current.config !== config) set({ config, status });
      return status;
    }
    if (options.showChecking) {
      const checkingStatus: ComfyUiStatus = {
        ...get().status,
        state: 'checking',
        serverUrl: normalizeComfyUiServerUrl(config.serverUrl),
        message: 'Checking ComfyUI...',
      };
      set({ config, status: checkingStatus });
    } else if (get().config !== config) {
      set({ config });
    }
    const status = await requestComfyUiConnection(config);
    if (!requestStillCurrent(config, get().config)) return status;
    if (visibleStatusChanged(get().status, status)) set({ status });
    if (status.state === 'ready') void triggerComfyUiWorkflowVerification(config, useProjectStore.getState().projectFilePath);
    return status;
  },
  refreshQueue: async (overrideConfig) => {
    const config = overrideConfig ?? get().config;
    const progress = await requestComfyUiQueue(config);
    if (!requestStillCurrent(config, get().config)) return progress;
    const nextStatus = { ...get().status, queueRemaining: progress.queueRemaining };
    if (progressChanged(get().progress, progress) || visibleStatusChanged(get().status, nextStatus)) set({ progress, status: nextStatus });
    return progress;
  },
  setProgress: (progress) => {
    const nextStatus = { ...get().status, queueRemaining: progress.queueRemaining };
    if (progressChanged(get().progress, progress) || visibleStatusChanged(get().status, nextStatus)) set({ progress, status: nextStatus });
  },
}));

useComfyUiStore.getState().hydrateFromPreferences();

usePreferencesStore.subscribe((state, previousState) => {
  if (state.comfyUiConfig !== previousState.comfyUiConfig) {
    useComfyUiStore.getState().hydrateFromPreferences();
  }
});

usePreferencesStore.persist.onFinishHydration((state) => {
  if (configChanged(useComfyUiStore.getState().config, state.comfyUiConfig)) {
    useComfyUiStore.getState().hydrateFromPreferences();
  }
});
