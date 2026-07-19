import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export interface GenerateCompiledProjectGoldensOptions {
  outputDirectory?: string;
}

export function generateCompiledProjectGoldens(
  options: GenerateCompiledProjectGoldensOptions = {},
): void {
  const outputDirectory =
    options.outputDirectory ?? resolve('src/renderer/test/fixtures/compiled-project-golden');
  mkdirSync(outputDirectory, { recursive: true });

  for (const [name, buildProject] of fixtures) {
    const result = compileAuthoringProject(buildProject());
    if (!result.ok) {
      throw new Error(`Failed to compile ${name}:\n${JSON.stringify(result.diagnostics, null, 2)}`);
    }
    writeFileSync(resolve(outputDirectory, `${name}.json`), `${result.canonicalJson}\n`, 'utf8');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) generateCompiledProjectGoldens();
