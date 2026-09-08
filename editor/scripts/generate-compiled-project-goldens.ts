import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAuthoringProject } from '../src/shared/authoring-compiler';
import { projectWorkspaceFiles } from '../src/shared/project-workspace';
import {
  canonicalExplorationGoldenProject,
  canonicalFastForwardGoldenProject,
  canonicalLinearGoldenProject,
  canonicalFlowGoldenProject,
  canonicalLayoutSignalGoldenProject,
  canonicalVocabularyGoldenProject,
  comprehensiveGoldenProject,
  dialogueProgramGoldenProject,
  traitPropertiesLocalizationGoldenProject,
  interactionProgramGoldenProject,
  minimalGoldenProject,
  resourceGoldenProject,
  runtimePresentationDemoProject,
  sceneProgramGoldenProject,
} from '../src/renderer/test/fixtures/compiled-project-golden-projects';

const fixtures = [
  ['minimal', minimalGoldenProject],
  ['canonical-exploration', canonicalExplorationGoldenProject],
  ['canonical-fast-forward', canonicalFastForwardGoldenProject],
  ['canonical-linear', canonicalLinearGoldenProject],
  ['canonical-flow', canonicalFlowGoldenProject],
  ['canonical-layout-signal', canonicalLayoutSignalGoldenProject],
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
  runtimeFixtureDirectory?: string;
}

function prettyJson(json: string): string {
  return `${JSON.stringify(JSON.parse(json), null, 2)}\n`;
}

export function generateCompiledProjectGoldens(
  options: GenerateCompiledProjectGoldensOptions = {},
): void {
  const outputDirectory =
    options.outputDirectory ?? resolve('src/renderer/test/fixtures/compiled-project-golden');
  const projectFixtureDirectory =
    options.projectFixtureDirectory ??
    resolve('src/renderer/test/fixtures/project-compiler-cli/minimal-project');
  const runtimeFixtureDirectory =
    options.runtimeFixtureDirectory ??
    resolve('src/renderer/test/fixtures/compiled-project-runtime');
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(runtimeFixtureDirectory, { recursive: true });

  for (const [name, buildProject] of fixtures) {
    const result = compileAuthoringProject(buildProject());
    if (!result.ok) {
      throw new Error(`Failed to compile ${name}:\n${JSON.stringify(result.diagnostics, null, 2)}`);
    }
    writeFileSync(
      resolve(outputDirectory, `${name}.json`),
      prettyJson(result.canonicalJson),
      'utf8',
    );
  }

  const runtimePresentation = compileAuthoringProject(runtimePresentationDemoProject());
  if (!runtimePresentation.ok) {
    throw new Error(
      `Failed to compile runtime presentation demo:\n${JSON.stringify(runtimePresentation.diagnostics, null, 2)}`,
    );
  }
  writeFileSync(
    resolve(runtimeFixtureDirectory, 'runtime-presentation-demo.json'),
    prettyJson(runtimePresentation.canonicalJson),
    'utf8',
  );

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
