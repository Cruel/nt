import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  CompileProjectArgumentsError,
  compileProjectExitCodes,
  parseCompileProjectArguments,
  runCompileProjectCommand,
} from '../../cli/compile-project-command';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { projectWorkspaceFiles } from '../../shared/project-workspace';

const temporaryDirectories: string[] = [];
function compilableProject() {
  const project = createAuthoringProject({ id: 'compile', name: 'Compile' });
  project.rooms.start = { id: 'start', label: 'Start', data: defaultRoomData('Start') };
  project.entrypoint = { kind: 'room', id: 'start' };
  return project;
}
async function workspaceDirectory(project = compilableProject()) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'noveltea-project-compile-'));
  temporaryDirectories.push(directory);
  for (const [relativePath, text] of Object.entries(
    projectWorkspaceFiles(project, project.editor),
  )) {
    const file = path.join(directory, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, 'utf8');
  }
  return directory;
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('project compiler workspace command', () => {
  it('parses the workspace-root command contract', () => {
    expect(
      parseCompileProjectArguments(['--project', 'project-root', '--output', 'compiled.json']),
    ).toEqual({
      help: false,
      json: false,
      projectPath: 'project-root',
      outputPath: 'compiled.json',
    });
    expect(() => parseCompileProjectArguments(['--project'])).toThrow(CompileProjectArgumentsError);
  });

  it('compiles a segmented workspace without local editor state', async () => {
    const directory = await workspaceDirectory();
    const outputPath = path.join(directory, 'compiled.json');
    const result = await runCompileProjectCommand([
      '--project',
      directory,
      '--output',
      outputPath,
      '--json',
    ]);
    expect(result.exitCode, JSON.stringify(result.report.diagnostics)).toBe(
      compileProjectExitCodes.success,
    );
    expect(result.report.projectPath).toBe(directory);
    expect(result.report.bytesWritten).toBeGreaterThan(0);
    expect(await fs.readFile(outputPath, 'utf8')).not.toHaveLength(0);
  });

  it('rejects retired monolithic authoring-project input', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'noveltea-project-compile-monolith-'));
    temporaryDirectories.push(directory);
    await fs.writeFile(
      path.join(directory, 'game.json'),
      JSON.stringify(createAuthoringProject()),
      'utf8',
    );
    const result = await runCompileProjectCommand([
      '--project',
      directory,
      '--output',
      path.join(directory, 'compiled.json'),
    ]);
    expect(result.exitCode).toBe(compileProjectExitCodes.input);
    expect(result.report.diagnostics[0]).toMatchObject({ code: 'PROJECT_COMPILE_INPUT_READ' });
  });

  it('does not overwrite the workspace manifest', async () => {
    const directory = await workspaceDirectory();
    const manifest = path.join(directory, 'project.json');
    const result = await runCompileProjectCommand(['--project', directory, '--output', manifest]);
    expect(result.exitCode).toBe(compileProjectExitCodes.output);
    expect(result.report.diagnostics[0]).toMatchObject({ code: 'PROJECT_COMPILE_OUTPUT_CONFLICT' });
  });
});
