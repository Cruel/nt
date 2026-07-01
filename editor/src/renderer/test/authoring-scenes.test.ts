import { describe, expect, it } from 'vitest';
import { assetDataFromImportMetadata } from '../../shared/project-schema/authoring-assets';
import { defaultCharacterData } from '../../shared/project-schema/authoring-characters';
import { defaultDialogueData } from '../../shared/project-schema/authoring-dialogues';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  defaultSceneData,
  defaultSceneStep,
  sceneAssetRef,
  sceneCharacterRef,
  sceneDialogueRef,
  sceneLayoutRef,
  sceneMaterialRef,
  sceneVariableRef,
  validateSceneData,
} from '../../shared/project-schema/authoring-scenes';
import { buildScenePreviewDocumentData, scenePreviewRevision } from '../../shared/project-schema/scene-project';

describe('authoring scenes schema', () => {
  it('provides typed scene defaults', () => {
    expect(defaultSceneData('Opening')).toMatchObject({
      kind: 'scene',
      displayName: 'Opening',
      settings: { fullScreen: true, canFastForward: true, speedFactor: 1 },
      steps: [{ id: 'start', type: 'comment', label: 'Start' }],
      preview: { selectedStepId: 'start', playback: 'from-start' },
    });
  });

  it('validates active references and branch targets', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps = [
      { ...defaultSceneStep('background'), id: 'start', label: 'Start', background: { ...defaultSceneStep('background').background, asset: sceneAssetRef('missing-asset') } },
      { ...defaultSceneStep('dialogue'), id: 'dialogue', label: 'Dialogue', dialogue: { ...defaultSceneStep('dialogue').dialogue, dialogue: sceneDialogueRef('missing-dialogue') } },
      { ...defaultSceneStep('branch'), id: 'branch', label: 'Branch', branch: { choices: [
        { id: 'choice', label: '', targetStepId: 'missing-step', condition: { enabled: true, source: '' }, order: 0 },
        { id: 'choice', label: 'Duplicate', targetStepId: 'start', condition: { enabled: false, source: '' }, order: 0 },
      ] } },
    ];
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data };

    expect(validateSceneData(project, 'opening', project.scenes.opening)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/scenes/opening/data/steps/0/background/asset/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/1/dialogue/dialogue/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/2/branch/choices/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/2/branch/choices/0/label', severity: 'error' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/2/branch/choices/0/targetStepId', severity: 'error' }),
      expect.objectContaining({ path: '/scenes/opening/data/steps/2/branch/choices/0/condition/source', severity: 'warning' }),
    ]));
  });

  it('reports scene diagnostics through project validation', () => {
    const project = createAuthoringProject();
    const data = defaultSceneData('Opening');
    data.steps[0]!.condition = { enabled: true, source: '' };
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'authoring-scenes', path: '/scenes/opening/data/steps/0/condition/source', severity: 'warning' }),
    ]));
  });

  it('builds scene preview documents with resolved references', () => {
    const project = createAuthoringProject();
    project.assets.bg = { id: 'bg', label: 'Background', tags: [], data: assetDataFromImportMetadata({ kind: 'image', projectRelativePath: 'assets/images/bg.png', contentHash: 'bg-hash' }) };
    project.assets.music = { id: 'music', label: 'Music', tags: [], data: assetDataFromImportMetadata({ kind: 'audio', projectRelativePath: 'assets/audio/music.mp3', contentHash: 'music-hash' }) };
    project.materials.fade = { id: 'fade', label: 'Fade', tags: [], data: defaultMaterialData('Fade') };
    project.characters.iris = { id: 'iris', label: 'Iris', tags: [], data: defaultCharacterData('Iris') };
    project.dialogues.intro = { id: 'intro', label: 'Intro Dialogue', tags: [], data: defaultDialogueData('Intro Dialogue') };
    project.layouts.hud = { id: 'hud', label: 'HUD', tags: [], data: defaultLayoutData('HUD') };
    project.variables.flag = { id: 'flag', label: 'Flag', tags: [], data: defaultVariableData('boolean') };

    const data = defaultSceneData('Opening');
    data.defaults.background.asset = sceneAssetRef('bg');
    data.defaults.background.material = sceneMaterialRef('fade');
    data.defaults.layout = sceneLayoutRef('hud');
    data.steps = [
      { ...defaultSceneStep('background'), id: 'background', label: 'Background', background: { ...defaultSceneStep('background').background, asset: sceneAssetRef('bg') } },
      { ...defaultSceneStep('character'), id: 'character', label: 'Show Iris', character: { ...defaultSceneStep('character').character, character: sceneCharacterRef('iris'), poseId: 'default', expressionId: 'neutral' } },
      { ...defaultSceneStep('dialogue'), id: 'dialogue', label: 'Dialogue', dialogue: { ...defaultSceneStep('dialogue').dialogue, dialogue: sceneDialogueRef('intro'), startBlockId: 'start' } },
      { ...defaultSceneStep('audio'), id: 'audio', label: 'Music', audio: { ...defaultSceneStep('audio').audio, asset: sceneAssetRef('music') } },
      { ...defaultSceneStep('variable'), id: 'variable', label: 'Set Flag', variable: { ...defaultSceneStep('variable').variable, variable: sceneVariableRef('flag'), value: true } },
    ];
    data.preview.selectedStepId = 'dialogue';
    project.scenes.opening = { id: 'opening', label: 'Opening', tags: [], data };

    expect(scenePreviewRevision(project, 'opening')).toContain('bg-hash');
    expect(buildScenePreviewDocumentData(project, 'opening')).toMatchObject({
      schema: 'noveltea.scene-preview.v1',
      sceneId: 'opening',
      selectedStepId: 'dialogue',
      selectedStep: { activePayload: { dialogueMetadata: expect.objectContaining({ id: 'intro', blockId: 'start' }) } },
      state: { characters: [expect.objectContaining({ characterMetadata: expect.objectContaining({ id: 'iris' }) })] },
    });
  });
});
