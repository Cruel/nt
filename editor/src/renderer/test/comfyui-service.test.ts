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

const config = defaultComfyUiConfig();

beforeEach(() => {
  vi.clearAllMocks();
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
      targetSource: 'editor',
    });
    await deleteComfyUiWorkflow({ workflowKey: 'editor:custom.manifest.json' });
    await importComfyUiWorkflowToLibrary({
      workflowFileName: 'custom.workflow.json',
      manifestFileName: 'custom.manifest.json',
      workflowJsonText: '{}',
      manifest: {},
      overwrite: false,
    });
    await repairComfyUiWorkflowInLibrary({
      workflowKey: 'editor:custom.manifest.json',
      manifest: {},
      overwrite: true,
    });
    await revealComfyUiWorkflow('editor:custom.manifest.json', '/mock/project/game.json');
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
      projectFilePath: '/mock/project/game.json',
      workflowId: 'flux2-klein-image-edit',
      sourceProjectRelativePath: 'assets/generated/generated.png',
      prompt: 'night',
    });
    await cancelComfyUiJob(config);

    expect(window.noveltea.checkComfyUiConnection).toHaveBeenCalledWith(config);
    expect(window.noveltea.getComfyUiQueue).toHaveBeenCalledWith(config);
    expect(window.noveltea.listComfyUiWorkflowLibrary).toHaveBeenCalledWith({
      projectFilePath: '/mock/project/game.json',
      includeOverridden: true,
    });
    expect(window.noveltea.copyComfyUiWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowKey: 'built-in:custom.manifest.json' }),
    );
    expect(window.noveltea.deleteComfyUiWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowKey: 'editor:custom.manifest.json' }),
    );
    expect(window.noveltea.importComfyUiWorkflowToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ workflowFileName: 'custom.workflow.json' }),
    );
    expect(window.noveltea.repairComfyUiWorkflowInLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ workflowKey: 'editor:custom.manifest.json' }),
    );
    expect(window.noveltea.revealComfyUiWorkflow).toHaveBeenCalledWith(
      'editor:custom.manifest.json',
      '/mock/project/game.json',
    );
    expect(window.noveltea.verifyComfyUiWorkflowLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ projectFilePath: '/mock/project/game.json' }),
    );
    expect(window.noveltea.analyzeComfyUiWorkflowImport).toHaveBeenCalledWith(
      expect.objectContaining({ workflowJsonText: '{}' }),
    );
    expect(window.noveltea.generateComfyUiImage).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ prompt: 'tea' }),
    );
    expect(window.noveltea.editComfyUiImage).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ prompt: 'night' }),
    );
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
