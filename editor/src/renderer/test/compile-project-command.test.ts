import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  CompileProjectArgumentsError,
  compileProjectExitCodes,
  parseCompileProjectArguments,
  runCompileProjectCommand,
  type CompileProjectFileSystem,
} from '../../cli/compile-project-command';
import { publishCompiledArtifact } from '../../shared/compiled-artifact-publication';
import { defaultExportProfile } from '../../shared/project-schema/authoring-export';
import { buildCompiledRuntimeExport } from '../../shared/project-schema/compiled-runtime-export';
import {
  comprehensiveGoldenProject,
  minimalGoldenProject,
} from './fixtures/compiled-project-golden-projects';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'noveltea-project-compile-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeProject(
  directory: string,
  project: unknown,
  filename = 'project.json',
): Promise<string> {
  const projectPath = path.join(directory, filename);
  await fs.writeFile(projectPath, JSON.stringify(project), 'utf8');
  return projectPath;
}

function isolatedMinimalProject() {
  const project = minimalGoldenProject();
  project.settings = { ...project.settings, ui: { systemLayouts: {} } };
  return project;
}

function warningOnlyProject() {
  const project = isolatedMinimalProject();
  project.project.version = 'development';
  return project;
}

const fileSystem: CompileProjectFileSystem = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  stat: (filePath) => fs.stat(filePath),
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  writeFile: (filePath, data, options) => fs.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options),
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('project compiler CLI arguments', () => {
  it('parses the complete command contract', () => {
    expect(
      parseCompileProjectArguments([
        '--project',
        'a project/project.json',
        '--output',
        'compiled output/game.json',
        '--json',
      ]),
    ).toEqual({
      help: false,
      json: true,
      projectPath: 'a project/project.json',
      outputPath: 'compiled output/game.json',
    });
    expect(parseCompileProjectArguments(['--help'])).toEqual({ help: true, json: false });
  });

  it.each([
    [[], /Missing required options/],
    [['--project', 'project.json'], /--output/],
    [['--project'], /requires a value/],
    [['--project', 'a', '--project', 'b', '--output', 'out'], /only once/],
    [['--json', '--json', '--help'], /only once/],
    [['--unknown'], /Unknown option/],
    [['project.json'], /positional argument/],
  ])('rejects invalid arguments: %j', (argv, expected) => {
    expect(() => parseCompileProjectArguments(argv as string[])).toThrow(expected as RegExp);
    expect(() => parseCompileProjectArguments(argv as string[])).toThrow(
      CompileProjectArgumentsError,
    );
  });
});

describe('project compiler CLI execution', () => {
  it('prints help without reading a project', async () => {
    const result = await runCompileProjectCommand(['--help']);
    expect(result.exitCode).toBe(compileProjectExitCodes.success);
    expect(result.report.success).toBe(true);
    expect(result.stdout).toContain('Usage: pnpm project:compile');
    expect(result.stderr).toBe('');
  });

  it('returns structured JSON for argument failures when requested', async () => {
    const result = await runCompileProjectCommand(['--json']);
    expect(result.exitCode).toBe(compileProjectExitCodes.arguments);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      exitCode: compileProjectExitCodes.arguments,
      diagnostics: [{ code: 'PROJECT_COMPILE_ARGUMENTS' }],
    });
  });

  it.each([
    ['minimal', isolatedMinimalProject],
    ['comprehensive', comprehensiveGoldenProject],
  ])('writes exact canonical bytes for the %s project', async (_name, buildProject) => {
    const directory = await temporaryDirectory();
    const project = buildProject();
    const projectPath = await writeProject(directory, project);
    const outputPath = path.join(directory, 'nested output', 'compiled.json');
    const published = publishCompiledArtifact(project);
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);

    expect(result.exitCode).toBe(compileProjectExitCodes.success);
    expect(result.report.success).toBe(true);
    expect(result.report.bytesWritten).toBe(
      Buffer.byteLength(published.project.gameplayJson, 'utf8'),
    );
    expect(await fs.readFile(outputPath, 'utf8')).toBe(published.project.gameplayJson);
    expect(result.stdout).toContain('Compiled project:');
  });

  it('proves exact-byte parity with publication, runtime export, and the minimal golden', async () => {
    const directory = await temporaryDirectory();
    const project = isolatedMinimalProject();
    const projectPath = await writeProject(directory, project);
    const outputPath = path.join(directory, 'compiled.json');
    const published = publishCompiledArtifact(project);
    const runtimeExport = buildCompiledRuntimeExport(project, {
      projectRoot: directory,
      profile: { ...defaultExportProfile(project), compileShadersBeforeExport: false },
    });
    expect(published.ok, JSON.stringify(published.diagnostics, null, 2)).toBe(true);
    expect(runtimeExport.ok, JSON.stringify(runtimeExport.diagnostics, null, 2)).toBe(true);
    if (!published.ok) return;

    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);
    const commandBytes = await fs.readFile(outputPath, 'utf8');
    const goldenBytes = await fs.readFile(
      path.resolve('src/renderer/test/fixtures/compiled-project-golden/minimal.json'),
      'utf8',
    );

    expect(result.exitCode, JSON.stringify(result.report.diagnostics, null, 2)).toBe(
      compileProjectExitCodes.success,
    );
    expect(commandBytes).toBe(published.project.gameplayJson);
    expect(commandBytes).toBe(runtimeExport.gameplayJson);
    expect(commandBytes).toBe(goldenBytes.trimEnd());
  });

  it('publishes warning diagnostics without blocking output', async () => {
    const directory = await temporaryDirectory();
    const projectPath = await writeProject(directory, warningOnlyProject());
    const outputPath = path.join(directory, 'compiled.json');
    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);

    expect(result.exitCode, JSON.stringify(result.report.diagnostics, null, 2)).toBe(
      compileProjectExitCodes.success,
    );
    expect(result.report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', jsonPointer: '/project/version' }),
      ]),
    );
    expect(result.stderr).toContain('[warning]');
    expect(await fs.readFile(outputPath, 'utf8')).not.toHaveLength(0);
  });

  it('distinguishes missing input and malformed JSON', async () => {
    const directory = await temporaryDirectory();
    const outputPath = path.join(directory, 'compiled.json');
    const missing = await runCompileProjectCommand([
      '--project',
      path.join(directory, 'missing.json'),
      '--output',
      outputPath,
    ]);
    expect(missing.exitCode).toBe(compileProjectExitCodes.input);
    expect(missing.report.diagnostics[0]?.code).toBe('PROJECT_COMPILE_INPUT_READ');

    const malformedPath = path.join(directory, 'malformed.json');
    await fs.writeFile(malformedPath, '{', 'utf8');
    const malformed = await runCompileProjectCommand([
      '--project',
      malformedPath,
      '--output',
      outputPath,
    ]);
    expect(malformed.exitCode).toBe(compileProjectExitCodes.input);
    expect(malformed.report.diagnostics[0]?.code).toBe('PROJECT_COMPILE_INPUT_JSON');
  });

  it('rejects directory inputs as input-read failures', async () => {
    const directory = await temporaryDirectory();
    const result = await runCompileProjectCommand([
      '--project',
      directory,
      '--output',
      path.join(directory, 'compiled.json'),
    ]);
    expect(result.exitCode).toBe(compileProjectExitCodes.input);
    expect(result.report.diagnostics[0]?.code).toBe('PROJECT_COMPILE_INPUT_READ');
  });

  it('preserves compiler schema diagnostics and stage reports', async () => {
    const directory = await temporaryDirectory();
    const projectPath = await writeProject(directory, { schema: 'unsupported' });
    const outputPath = path.join(directory, 'compiled.json');
    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);

    expect(result.exitCode).toBe(compileProjectExitCodes.compiler);
    expect(result.report.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: expect.stringMatching(/^AUTHORING_SCHEMA_/) }),
      ]),
    );
    expect(result.report.stages[0]).toEqual({ name: 'normalize', status: 'failed' });
    await expect(fs.stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves an existing destination after semantic compiler failure', async () => {
    const directory = await temporaryDirectory();
    const project = isolatedMinimalProject();
    project.entrypoint = { kind: 'room', id: 'missing-room' };
    const projectPath = await writeProject(directory, project);
    const outputPath = path.join(directory, 'compiled.json');
    await fs.writeFile(outputPath, 'known-good', 'utf8');

    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);
    expect(result.exitCode).toBe(compileProjectExitCodes.compiler);
    expect(result.report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
    );
    expect(await fs.readFile(outputPath, 'utf8')).toBe('known-good');
  });

  it('replaces an existing destination only after successful compilation', async () => {
    const directory = await temporaryDirectory();
    const project = isolatedMinimalProject();
    const projectPath = await writeProject(directory, project);
    const outputPath = path.join(directory, 'compiled.json');
    await fs.writeFile(outputPath, 'old-output', 'utf8');

    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      outputPath,
    ]);
    const published = publishCompiledArtifact(project);
    expect(result.exitCode).toBe(compileProjectExitCodes.success);
    expect(published.ok).toBe(true);
    if (published.ok)
      expect(await fs.readFile(outputPath, 'utf8')).toBe(published.project.gameplayJson);
  });

  it('rejects an input/output path conflict before reading or writing', async () => {
    const directory = await temporaryDirectory();
    const projectPath = await writeProject(directory, isolatedMinimalProject());
    const original = await fs.readFile(projectPath, 'utf8');
    const result = await runCompileProjectCommand([
      '--project',
      projectPath,
      '--output',
      projectPath,
    ]);

    expect(result.exitCode, JSON.stringify(result.report.diagnostics, null, 2)).toBe(
      compileProjectExitCodes.output,
    );
    expect(result.report.diagnostics[0]?.code).toBe('PROJECT_COMPILE_OUTPUT_CONFLICT');
    expect(await fs.readFile(projectPath, 'utf8')).toBe(original);
  });

  it('cleans the temporary file and preserves the destination after rename failure', async () => {
    const directory = await temporaryDirectory();
    const projectPath = await writeProject(directory, isolatedMinimalProject());
    const outputPath = path.join(directory, 'compiled.json');
    const temporaryPath = path.join(directory, '.fixed-project-compile.tmp');
    await fs.writeFile(outputPath, 'known-good', 'utf8');
    const failingFileSystem: CompileProjectFileSystem = {
      ...fileSystem,
      rename: async () => {
        throw new Error('simulated rename failure');
      },
    };

    const result = await runCompileProjectCommand(
      ['--project', projectPath, '--output', outputPath],
      { fileSystem: failingFileSystem, temporaryPathFactory: () => temporaryPath },
    );

    expect(result.exitCode).toBe(compileProjectExitCodes.output);
    expect(result.report.diagnostics.at(-1)?.code).toBe('PROJECT_COMPILE_OUTPUT_WRITE');
    expect(await fs.readFile(outputPath, 'utf8')).toBe('known-good');
    await expect(fs.stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
