import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAuthoringProject } from '../src/shared/authoring-compiler';
import { projectWorkspaceFiles } from '../src/shared/project-workspace';
import {
  canonicalExplorationGoldenProject,
  canonicalLinearGoldenProject,
  canonicalFlowGoldenProject,
  canonicalVocabularyGoldenProject,
  comprehensiveGoldenProject,
  dialogueProgramGoldenProject,
  traitPropertiesLocalizationGoldenProject,
  interactionProgramGoldenProject,
  minimalGoldenProject,
  resourceGoldenProject,
  sceneProgramGoldenProject,
} from '../src/renderer/test/fixtures/compiled-project-golden-projects';

const fixtures = [
  ['minimal', minimalGoldenProject],
  ['canonical-exploration', canonicalExplorationGoldenProject],
  ['canonical-linear', canonicalLinearGoldenProject],
  ['canonical-flow', canonicalFlowGoldenProject],
  ['canonical-vocabulary', canonicalVocabularyGoldenProject],
  ['comprehensive', comprehensiveGoldenProject],
  ['trait-properties-localization', traitPropertiesLocalizationGoldenProject],
  ['resources', resourceGoldenProject],
  ['scene-program', sceneProgramGoldenProject],
  ['dialogue-program', dialogueProgramGoldenProject],
  ['interaction-program', interactionProgramGoldenProject],
] as const;

export interface GenerateCompiledProjectGoldensOptions {
  outputDirectory?: string;
  projectFixtureDirectory?: string;
}

export function generateCompiledProjectGoldens(
  options: GenerateCompiledProjectGoldensOptions = {},
): void {
  const outputDirectory =
    options.outputDirectory ?? resolve('src/renderer/test/fixtures/compiled-project-golden');
  const projectFixtureDirectory =
    options.projectFixtureDirectory ??
    resolve('src/renderer/test/fixtures/project-compiler-cli/minimal-project');
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });

  for (const [name, buildProject] of fixtures) {
    const result = compileAuthoringProject(buildProject());
    if (!result.ok) {
      throw new Error(`Failed to compile ${name}:\n${JSON.stringify(result.diagnostics, null, 2)}`);
    }
    writeFileSync(resolve(outputDirectory, `${name}.json`), `${result.canonicalJson}\n`, 'utf8');
  }

  const project = minimalGoldenProject();
  rmSync(projectFixtureDirectory, { recursive: true, force: true });
  for (const [relativePath, contents] of Object.entries(
    projectWorkspaceFiles(project, project.editor),
  )) {
    const outputPath = resolve(projectFixtureDirectory, relativePath);
    mkdirSync(resolve(outputPath, '..'), { recursive: true });
    writeFileSync(outputPath, contents, 'utf8');
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) generateCompiledProjectGoldens();
