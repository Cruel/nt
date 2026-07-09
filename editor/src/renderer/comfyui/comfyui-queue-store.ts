import { create } from 'zustand';
import type { ComfyUiConfig, ComfyUiQueueProgress } from '../../shared/comfyui';
import type { ComfyUiEditImageRequest, ComfyUiGenerateImageRequest } from '../../shared/comfyui-generation';
import type { ComfyUiWorkflowRole } from '../../shared/comfyui-workflows';

export type ComfyUiQueueItemState = 'queued' | 'running' | 'finalizing' | 'error' | 'interrupted';

export type ComfyUiLocalJobRequest =
  | { kind: 'generate'; request: ComfyUiGenerateImageRequest }
  | { kind: 'edit'; request: ComfyUiEditImageRequest };

export type ComfyUiLocalJob = ComfyUiLocalJobRequest & {
  promptId: string;
  tabId: string;
  config: ComfyUiConfig;
};

export interface ComfyUiQueueItem {
  promptId: string;
  projectFilePath: string | null;
  workflowId: string | null;
  workflowLabel: string;
  role: ComfyUiWorkflowRole | null;
  mode: 'generate' | 'edit' | null;
  promptSummary: string;
  state: ComfyUiQueueItemState;
  currentNode: string | null;
  progressValue: number | null;
  progressMax: number | null;
  queueNumber: number | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

type EnqueueComfyUiJobOptions = ComfyUiLocalJobRequest & {
  tabId: string;
  config: ComfyUiConfig;
  workflowLabel: string;
  role: ComfyUiWorkflowRole;
  promptSummary: string;
};

interface ComfyUiQueueStore {
  jobsByPromptId: Record<string, ComfyUiQueueItem>;
  localJobsByPromptId: Record<string, ComfyUiLocalJob>;
  order: string[];
  enqueueJob: (options: EnqueueComfyUiJobOptions) => string;
  nextQueuedJob: () => ComfyUiLocalJob | null;
  beginJob: (promptId: string) => void;
  updateProgress: (progress: ComfyUiQueueProgress) => void;
  markInterrupted: (promptId: string, message?: string) => void;
  failJob: (promptId: string, message: string) => void;
  removeJob: (promptId: string) => void;
  clearFinished: () => void;
  clearProject: (projectFilePath: string | null) => void;
}

function now() {
  return new Date().toISOString();
}

function createJobId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function activeState(state: ComfyUiQueueProgress['state']): ComfyUiQueueItemState | null {
  if (state === 'queued') return 'queued';
  if (state === 'running') return 'running';
  if (state === 'error') return 'error';
  if (state === 'interrupted') return 'interrupted';
  if (state === 'completed') return null;
  return null;
}

function isFinishedState(state: ComfyUiQueueItemState) {
  return state === 'error' || state === 'interrupted';
}

function itemFromProgress(progress: ComfyUiQueueProgress, previous?: ComfyUiQueueItem): ComfyUiQueueItem | null {
  if (!progress.promptId) return null;
  const state = activeState(progress.state);
  if (!state) return null;
  const updatedAt = progress.updatedAt ?? now();
  let resolvedState = previous && isFinishedState(previous.state) ? previous.state : state;
  // ComfyUI emits normal status/queue frames after a prompt has already started.
  // Do not let those downgrade a locally running job back to queued, or the local
  // runner can submit the same prompt repeatedly.
  if (previous?.state === 'running' && state === 'queued') resolvedState = 'running';
  if (previous?.state === 'finalizing' && state === 'queued') resolvedState = 'finalizing';
  const finished = isFinishedState(resolvedState);
  return {
    promptId: progress.promptId,
    projectFilePath: progress.projectFilePath ?? previous?.projectFilePath ?? null,
    workflowId: progress.workflowId ?? previous?.workflowId ?? null,
    workflowLabel: progress.workflowLabel ?? previous?.workflowLabel ?? progress.workflowId ?? 'ComfyUI workflow',
    role: progress.role ?? previous?.role ?? null,
    mode: progress.mode ?? previous?.mode ?? null,
    promptSummary: progress.promptSummary ?? previous?.promptSummary ?? '(unknown prompt)',
    state: resolvedState,
    currentNode: finished ? null : progress.currentNode ?? previous?.currentNode ?? null,
    progressValue: finished ? null : progress.progressValue ?? previous?.progressValue ?? null,
    progressMax: finished ? null : progress.progressMax ?? previous?.progressMax ?? null,
    queueNumber: progress.queueNumber ?? progress.queueRemaining ?? previous?.queueNumber ?? null,
    message: previous && isFinishedState(previous.state) ? previous.message : resolvedState === 'interrupted' ? 'Canceled' : progress.message ?? previous?.message ?? null,
    createdAt: progress.createdAt ?? previous?.createdAt ?? updatedAt,
    updatedAt,
  };
}

export const useComfyUiQueueStore = create<ComfyUiQueueStore>()((set, get) => ({
  jobsByPromptId: {},
  localJobsByPromptId: {},
  order: [],
  enqueueJob: (options) => {
    const promptId = createJobId();
    const createdAt = now();
    const localJob: ComfyUiLocalJob = options.kind === 'generate'
      ? { kind: 'generate', promptId, tabId: options.tabId, config: options.config, request: { ...options.request, clientJobId: promptId } }
      : { kind: 'edit', promptId, tabId: options.tabId, config: options.config, request: { ...options.request, clientJobId: promptId } };
    const itemRequest = localJob.request;
    const item: ComfyUiQueueItem = {
      promptId,
      projectFilePath: itemRequest.projectFilePath,
      workflowId: itemRequest.workflowId ?? itemRequest.workflowKey ?? null,
      workflowLabel: options.workflowLabel,
      role: options.role,
      mode: options.kind,
      promptSummary: options.promptSummary,
      state: 'queued',
      currentNode: null,
      progressValue: null,
      progressMax: null,
      queueNumber: null,
      message: 'Queued locally',
      createdAt,
      updatedAt: createdAt,
    };
    set((state) => ({
      jobsByPromptId: { ...state.jobsByPromptId, [promptId]: item },
      localJobsByPromptId: { ...state.localJobsByPromptId, [promptId]: localJob },
      order: [...state.order, promptId],
    }));
    return promptId;
  },
  nextQueuedJob: () => {
    const state = get();
    const hasRunning = state.order.some((promptId) => state.jobsByPromptId[promptId]?.state === 'running' || state.jobsByPromptId[promptId]?.state === 'finalizing');
    if (hasRunning) return null;
    const queuedId = state.order.find((promptId) => state.jobsByPromptId[promptId]?.state === 'queued' && state.localJobsByPromptId[promptId]);
    return queuedId ? state.localJobsByPromptId[queuedId] ?? null : null;
  },
  beginJob: (promptId) => set((state) => {
    const existing = state.jobsByPromptId[promptId];
    if (!existing || existing.state !== 'queued') return state;
    return {
      jobsByPromptId: {
        ...state.jobsByPromptId,
        [promptId]: { ...existing, state: 'running', message: 'Starting ComfyUI job', updatedAt: now() },
      },
      localJobsByPromptId: state.localJobsByPromptId,
      order: state.order,
    };
  }),
  updateProgress: (progress) => {
    if (!progress.promptId) return;
    const existing = get().jobsByPromptId[progress.promptId];
    if (progress.state === 'completed') {
      if (!existing || !isFinishedState(existing.state)) get().removeJob(progress.promptId);
      return;
    }
    const item = itemFromProgress(progress, existing);
    if (!item) return;
    set((state) => ({
      jobsByPromptId: { ...state.jobsByPromptId, [item.promptId]: item },
      localJobsByPromptId: state.localJobsByPromptId,
      order: state.order.includes(item.promptId) ? state.order : [...state.order, item.promptId],
    }));
  },
  markInterrupted: (promptId, message = 'Canceled') => set((state) => {
    const existing = state.jobsByPromptId[promptId];
    if (!existing) return state;
    const { [promptId]: _removedLocalJob, ...localJobsByPromptId } = state.localJobsByPromptId;
    return {
      jobsByPromptId: {
        ...state.jobsByPromptId,
        [promptId]: {
          ...existing,
          state: 'interrupted',
          currentNode: null,
          progressValue: null,
          progressMax: null,
          message,
          updatedAt: now(),
        },
      },
      localJobsByPromptId,
      order: state.order,
    };
  }),
  failJob: (promptId, message) => set((state) => {
    const existing = state.jobsByPromptId[promptId];
    if (!existing) return state;
    const { [promptId]: _removedLocalJob, ...localJobsByPromptId } = state.localJobsByPromptId;
    return {
      jobsByPromptId: {
        ...state.jobsByPromptId,
        [promptId]: { ...existing, state: 'error', message, currentNode: null, progressValue: null, progressMax: null, updatedAt: now() },
      },
      localJobsByPromptId,
      order: state.order,
    };
  }),
  removeJob: (promptId) => set((state) => {
    if (!state.jobsByPromptId[promptId] && !state.localJobsByPromptId[promptId]) return state;
    const { [promptId]: _removed, ...jobsByPromptId } = state.jobsByPromptId;
    const { [promptId]: _removedLocalJob, ...localJobsByPromptId } = state.localJobsByPromptId;
    return { jobsByPromptId, localJobsByPromptId, order: state.order.filter((id) => id !== promptId) };
  }),
  clearFinished: () => set((state) => {
    const jobsByPromptId: Record<string, ComfyUiQueueItem> = {};
    const localJobsByPromptId: Record<string, ComfyUiLocalJob> = {};
    const order: string[] = [];
    for (const promptId of state.order) {
      const job = state.jobsByPromptId[promptId];
      if (!job || isFinishedState(job.state)) continue;
      jobsByPromptId[promptId] = job;
      const localJob = state.localJobsByPromptId[promptId];
      if (localJob) localJobsByPromptId[promptId] = localJob;
      order.push(promptId);
    }
    return { jobsByPromptId, localJobsByPromptId, order };
  }),
  clearProject: (projectFilePath) => set((state) => {
    if (!projectFilePath) return { jobsByPromptId: {}, localJobsByPromptId: {}, order: [] };
    const jobsByPromptId: Record<string, ComfyUiQueueItem> = {};
    const localJobsByPromptId: Record<string, ComfyUiLocalJob> = {};
    const order: string[] = [];
    for (const promptId of state.order) {
      const job = state.jobsByPromptId[promptId];
      if (!job || job.projectFilePath === projectFilePath) continue;
      jobsByPromptId[promptId] = job;
      const localJob = state.localJobsByPromptId[promptId];
      if (localJob) localJobsByPromptId[promptId] = localJob;
      order.push(promptId);
    }
    return { jobsByPromptId, localJobsByPromptId, order };
  }),
}));
