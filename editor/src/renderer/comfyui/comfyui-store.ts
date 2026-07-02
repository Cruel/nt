import { create } from 'zustand';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import type { ComfyUiConfig, ComfyUiQueueProgress, ComfyUiStatus } from '../../shared/comfyui';
import { defaultComfyUiConfig, normalizeComfyUiServerUrl } from '../../shared/comfyui';

interface CheckConnectionOptions {
  showChecking?: boolean;
}

interface ComfyUiStore {
  config: ComfyUiConfig;
  status: ComfyUiStatus;
  progress: ComfyUiQueueProgress;
  hydrateFromProject: (project: AuthoringProject | null) => void;
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

function configFromProject(project: AuthoringProject | null): ComfyUiConfig {
  if (!project) return defaultComfyUiConfig();
  const settings = projectSettingsFromProject(project).comfyui;
  return { ...settings };
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

export const useComfyUiStore = create<ComfyUiStore>()((set, get) => ({
  config: defaultComfyUiConfig(),
  status: disabledStatus(),
  progress: idleProgress(),
  hydrateFromProject: (project) => {
    const config = configFromProject(project);
    set({
      config,
      status: config.enabled
        ? { ...disabledStatus(config), state: 'checking', message: 'Checking ComfyUI...' }
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
    const status = await window.noveltea.checkComfyUiConnection(config);
    if (visibleStatusChanged(get().status, status)) set({ status });
    return status;
  },
  refreshQueue: async (overrideConfig) => {
    const config = overrideConfig ?? get().config;
    const progress = await window.noveltea.getComfyUiQueue(config);
    const nextStatus = { ...get().status, queueRemaining: progress.queueRemaining };
    if (progressChanged(get().progress, progress) || visibleStatusChanged(get().status, nextStatus)) set({ progress, status: nextStatus });
    return progress;
  },
  setProgress: (progress) => {
    const nextStatus = { ...get().status, queueRemaining: progress.queueRemaining };
    if (progressChanged(get().progress, progress) || visibleStatusChanged(get().status, nextStatus)) set({ progress, status: nextStatus });
  },
}));
