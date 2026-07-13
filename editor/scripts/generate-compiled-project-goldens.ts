import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileAuthoringProject } from '../src/shared/authoring-compiler';
import {
  comprehensiveGoldenProject,
  dialogueProgramGoldenProject,
  inheritancePropertiesLocalizationGoldenProject,
  interactionProgramGoldenProject,
  minimalGoldenProject,
  resourceGoldenProject,
  sceneProgramGoldenProject,
} from '../src/renderer/test/fixtures/compiled-project-golden-projects';

const fixtures = [
  ['minimal', minimalGoldenProject],
  ['comprehensive', comprehensiveGoldenProject],
  ['inheritance-properties-localization', inheritancePropertiesLocalizationGoldenProject],
  ['resources', resourceGoldenProject],
  ['scene-program', sceneProgramGoldenProject],
  ['dialogue-program', dialogueProgramGoldenProject],
  ['interaction-program', interactionProgramGoldenProject],
] as const;

const outputDirectory = resolve('src/renderer/test/fixtures/compiled-project-golden');
mkdirSync(outputDirectory, { recursive: true });

for (const [name, buildProject] of fixtures) {
  const result = compileAuthoringProject(buildProject());
  if (!result.ok) {
    throw new Error(`Failed to compile ${name}:\n${JSON.stringify(result.diagnostics, null, 2)}`);
  }
  writeFileSync(resolve(outputDirectory, `${name}.json`), `${result.canonicalJson}\n`, 'utf8');
}
