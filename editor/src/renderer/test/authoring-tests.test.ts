import { describe, expect, it } from 'vitest';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  defaultTestAssertion,
  defaultTestData,
  defaultTestStep,
  testCharacterSubject,
  testInteractableSubject,
  testSceneRef,
  testVariableRef,
  validateTestData,
} from '../../shared/project-schema/authoring-tests';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';
import { defaultSceneData } from '../../shared/project-schema/authoring-scenes';

describe('authoring tests schema', () => {
  it('provides typed test defaults', () => {
    expect(defaultTestData('Smoke')).toMatchObject({
      kind: 'test',
      displayName: 'Smoke',
      fixedDeltaSeconds: null,
      steps: [{ id: 'start', input: 'tick', label: 'Start' }],
      preview: { selectedStepId: 'start' },
    });
  });

  it('provides stable ui-click defaults and validation', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps = [{ ...defaultTestStep('ui-click'), id: 'start-click', label: 'Start Click' }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(data.steps[0]).toMatchObject({
      input: 'ui-click',
      uiClick: {
        documentId: 'runtime_title',
        target: '#nt-title-start',
        selector: '#nt-title-start',
      },
    });

    data.steps[0]!.uiClick = { documentId: '', target: '', selector: '' };
    expect(validateTestData(project, 'smoke', project.tests.smoke)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/uiClick/documentId', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/uiClick/target', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/uiClick/selector', severity: 'error' }),
    ]));
  });

  it('validates references, duplicate IDs, and assertion requirements', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.entrypoint = testSceneRef('missing-scene');
    data.steps = [
      { ...defaultTestStep('run-interaction'), id: 'step', label: 'Interaction', runInteraction: { verb: { $ref: { collection: 'verbs', id: 'missing-verb' } }, operands: [testCharacterSubject('missing-character'), testInteractableSubject('missing-interactable')] } },
      { ...defaultTestStep('tick'), id: 'step', label: 'Duplicate', assertions: [
        { ...defaultTestAssertion('property-equals'), id: 'assertion', label: 'Property', key: '', variable: null },
        { ...defaultTestAssertion('mode'), id: 'assertion', label: 'Mode', value: '' },
      ] },
    ];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateTestData(project, 'smoke', project.tests.smoke)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/tests/smoke/data/entrypoint/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/runInteraction/verb/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/runInteraction/operands/0/character/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/0/runInteraction/operands/1/interactable/$ref', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/1/assertions/1/id', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/1/assertions/0/key', severity: 'error' }),
      expect.objectContaining({ path: '/tests/smoke/data/steps/1/assertions/1/value', severity: 'error' }),
    ]));
  });

  it('reports test diagnostics through project validation', () => {
    const project = createAuthoringProject();
    const data = defaultTestData('Smoke');
    data.steps[0]!.assertions = [{ ...defaultTestAssertion('mode'), value: '' }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateAuthoringProject(project)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Tests', path: '/tests/smoke/data/steps/0/assertions/0/value', severity: 'error' }),
    ]));
  });

  it('allows references used by tests to be indexed generically', () => {
    const project = createAuthoringProject();
    project.scenes.opening = { id: 'opening', label: 'Opening', data: defaultSceneData('Opening') };
    project.variables.flag = { id: 'flag', label: 'Flag', data: defaultVariableData('boolean') };
    const data = defaultTestData('Smoke');
    data.entrypoint = testSceneRef('opening');
    data.steps[0]!.assertions = [{ ...defaultTestAssertion('property-equals'), key: '', variable: testVariableRef('flag'), expected: true }];
    project.tests.smoke = { id: 'smoke', label: 'Smoke', data };

    expect(validateTestData(project, 'smoke', project.tests.smoke).filter((item) => item.severity === 'error')).toEqual([]);
  });
});
