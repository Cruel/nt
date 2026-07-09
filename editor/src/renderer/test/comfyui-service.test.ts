import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeComfyUiWorkflowImport,
  bestComfyUiErrorMessage,
  cancelComfyUiJob,
  checkComfyUiConnection,
  editComfyUiImage,
  generateComfyUiImage,
  getComfyUiQueue,
  installComfyUiStarterWorkflows,
  listComfyUiWorkflowLibrary,
  listComfyUiWorkflows,
  repairComfyUiWorkflowManifest,
  saveImportedComfyUiWorkflow,
  subscribeComfyUiProgress,
} from '@/comfyui/comfyui-service';
import { defaultComfyUiConfig } from '../../shared/comfyui';

const config = defaultComfyUiConfig();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('comfyui-service', () => {
  it('forwards ComfyUI IPC calls through one renderer boundary', async () => {
    await checkComfyUiConnection(config);
    await getComfyUiQueue(config);
    await listComfyUiWorkflowLibrary({ projectFilePath: '/mock/project/game.json', includeOverridden: true });
    await listComfyUiWorkflows('/mock/project/game.json');
    await installComfyUiStarterWorkflows('/mock/project/game.json');
    await analyzeComfyUiWorkflowImport({ projectFilePath: '/mock/project/game.json', workflowJsonText: '{}' });
    await saveImportedComfyUiWorkflow({ projectFilePath: '/mock/project/game.json', workflowFileName: 'custom.workflow.json', manifestFileName: 'custom.manifest.json', workflowJsonText: '{}', manifest: {}, overwrite: false });
    await repairComfyUiWorkflowManifest({ projectFilePath: '/mock/project/game.json', manifestFileName: 'custom.manifest.json', manifest: {}, overwrite: true });
    await generateComfyUiImage(config, { projectFilePath: '/mock/project/game.json', workflowId: 'flux2-klein-text-to-image', prompt: 'tea' });
    await editComfyUiImage(config, { projectFilePath: '/mock/project/game.json', workflowId: 'flux2-klein-image-edit', sourceProjectRelativePath: 'assets/generated/generated.png', prompt: 'night' });
    await cancelComfyUiJob(config);

    expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(config);
    expect(window.noveltea.getComfyUiQueue).toHaveBeenCalledWith(config);
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenCalledWith({ projectFilePath: '/mock/project/game.json', includeOverridden: true });
    expect(window.noveltea.listComfyUiWorkflows).toHaveBeenCalledWith('/mock/project/game.json');
    expect(window.noveltea.installComfyUiStarterWorkflows).toHaveBeenCalledWith('/mock/project/game.json');
    expect(window.noveltea.analyzeComfyUiWorkflowImport).toHaveBeenCalledWith(expect.objectContaining({ workflowJsonText: '{}' }));
    expect(window.noveltea.saveImportedComfyUiWorkflow).toHaveBeenCalledWith(expect.objectContaining({ workflowFileName: 'custom.workflow.json' }));
    expect(window.noveltea.repairComfyUiWorkflowManifest).toHaveBeenCalledWith(expect.objectContaining({ manifestFileName: 'custom.manifest.json' }));
    expect(window.noveltea.generateComfyUiImage).toHaveBeenCalledWith(config, expect.objectContaining({ prompt: 'tea' }));
    expect(window.noveltea.editComfyUiImage).toHaveBeenCalledWith(config, expect.objectContaining({ prompt: 'night' }));
    expect(window.noveltea.cancelComfyUiJob).toHaveBeenCalledWith(config);
  });

  it('subscribes to progress events through preload', () => {
    const callback = vi.fn();
    const unsubscribe = vi.fn();
    vi.mocked(window.noveltea.onComfyUiProgress).mockReturnValueOnce(unsubscribe);

    expect(subscribeComfyUiProgress(callback)).toBe(unsubscribe);
    expect(window.noveltea.onComfyUiProgress).toHaveBeenCalledWith(callback);
  });

  it('chooses the best available ComfyUI error message', () => {
    expect(bestComfyUiErrorMessage({ diagnostics: [{ message: 'error' }, { message: 'Missing node 9' }], error: 'fallback' })).toBe('Missing node 9');
    expect(bestComfyUiErrorMessage({ diagnostics: [{ message: 'error' }], error: 'Connection refused' })).toBe('Connection refused');
    expect(bestComfyUiErrorMessage({ diagnostics: [{ message: 'error' }], error: 'error' })).toBe('ComfyUI operation failed.');
  });
});
