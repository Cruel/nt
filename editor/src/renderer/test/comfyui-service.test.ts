import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  analyzeComfyUiWorkflowImport,
  bestComfyUiErrorMessage,
  cancelComfyUiJob,
  checkComfyUiConnection,
  copyComfyUiWorkflow,
  deleteComfyUiWorkflow,
  editComfyUiImage,
  generateComfyUiImage,
  getComfyUiQueue,
  importComfyUiWorkflowToLibrary,
  listComfyUiWorkflowLibrary,
  repairComfyUiWorkflowInLibrary,
  revealComfyUiWorkflow,
  subscribeComfyUiProgress,
  verifyComfyUiWorkflowLibrary,
} from '@/comfyui/comfyui-service';
import { defaultComfyUiConfig } from '../../shared/comfyui';
import { useProjectStore } from '@/project/project-store';

const config = defaultComfyUiConfig();

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.getState().clearProject();
  useProjectStore.getState().loadProjectDocument({
    document: {},
    projectPath: '/mock/project',
    projectFilePath: '/mock/project/game.json',
    projectSessionId: '11111111-1111-4111-8111-111111111111',
  });
});

describe('comfyui-service', () => {
  it('forwards ComfyUI IPC calls through one renderer boundary', async () => {
    await checkComfyUiConnection(config);
    await getComfyUiQueue(config);
    await listComfyUiWorkflowLibrary({
      projectFilePath: '/mock/project/game.json',
      includeOverridden: true,
    });
    await copyComfyUiWorkflow({
      workflowKey: 'built-in:custom.manifest.json',
      targetSource: 'user',
    });
    await deleteComfyUiWorkflow({ workflowKey: 'user:custom.manifest.json' });
    await importComfyUiWorkflowToLibrary({
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: '{}',
      manifest: {},
      overwrite: false,
    });
    await repairComfyUiWorkflowInLibrary({
      workflowKey: 'user:custom.manifest.json',
      manifest: {},
      overwrite: true,
    });
    await revealComfyUiWorkflow('user:custom.manifest.json', '/mock/project/game.json');
    await verifyComfyUiWorkflowLibrary({ projectFilePath: '/mock/project/game.json', config });
    await analyzeComfyUiWorkflowImport({
      projectFilePath: '/mock/project/game.json',
      workflowJsonText: '{}',
    });
    await generateComfyUiImage(config, {
      projectFilePath: '/mock/project/game.json',
      workflowId: 'flux2-klein-text-to-image',
      prompt: 'tea',
    });
    await editComfyUiImage(config, {
      workflowId: 'flux2-klein-image-edit',
      sourceAssetId: 'generated',
      prompt: 'night',
    });
    await cancelComfyUiJob(config);

    expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(config);
    expect(window.noveltea.getComfyUiQueue).toHaveBeenCalledWith(config);
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { includeOverridden: true },
    );
    expect(window.noveltea.copyComfyUiWorkflow).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ workflowKey: 'built-in:custom.manifest.json' }),
    );
    expect(window.noveltea.deleteComfyUiWorkflow).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ workflowKey: 'user:custom.manifest.json' }),
    );
    expect(window.noveltea.importComfyUiWorkflowToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ workflowFileName: 'custom.workflow.json' }),
    );
    expect(window.noveltea.repairComfyUiWorkflowInLibrary).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ workflowKey: 'user:custom.manifest.json' }),
    );
    expect(window.noveltea.revealComfyUiWorkflow).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'user:custom.manifest.json',
    );
    expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ config }),
    );
    expect(window.noveltea.analyzeComfyUiWorkflowImport).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ workflowJsonText: '{}' }),
    );
    expect(window.noveltea.generateComfyUiImage).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      config,
      expect.objectContaining({ prompt: 'tea' }),
    );
    expect(window.noveltea.editComfyUiImage).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      config,
      expect.objectContaining({ prompt: 'night' }),
    );
    expect(window.noveltea.cancelComfyUiJob).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      config,
    );
  });

  it('subscribes to progress events through preload', () => {
    const callback = vi.fn();
    const unsubscribe = vi.fn();
    vi.mocked(window.noveltea.onComfyUiProgress).mockReturnValueOnce(unsubscribe);

    expect(subscribeComfyUiProgress(callback)).toBe(unsubscribe);
    expect(window.noveltea.onComfyUiProgress).toHaveBeenCalledWith(callback);
  });

  it('chooses the best available ComfyUI error message', () => {
    expect(
      bestComfyUiErrorMessage({
        diagnostics: [{ message: 'error' }, { message: 'Missing node 9' }],
        error: 'fallback',
      }),
    ).toBe('Missing node 9');
    expect(
      bestComfyUiErrorMessage({ diagnostics: [{ message: 'error' }], error: 'Connection refused' }),
    ).toBe('Connection refused');
    expect(bestComfyUiErrorMessage({ diagnostics: [{ message: 'error' }], error: 'error' })).toBe(
      'ComfyUI operation failed.',
    );
  });
});
