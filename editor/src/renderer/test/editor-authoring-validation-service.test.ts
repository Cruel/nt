import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { runNovelTeaCli } from '../../cli/application';
import type { NovelTeaCliNativeToolService } from '../../cli/native-tool-service';
import { EditorAuthoringValidationService } from '../../main/services/editor-authoring-validation-service';
import { ActiveProjectWorkspaceSession } from '../../main/services/active-project-workspace-session';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import {
  createNodeProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { createDefaultAuthoringRecord } from '../project/entity-operations';

const roots: string[] = [];

function tools(): NovelTeaCliNativeToolService {
  return {
    async compileShaders() {
      return { ok: true, success: true, diagnostics: [], outputs: [] };
    },
    async validateFontCoverage() {
      return { ok: true, success: true, diagnostics: [] };
    },
    async runHeadlessTest() {
      return { ok: true, success: true };
    },
    async runUiTest() {
      return { ok: true, success: true };
    },
    async exportPackage() {
      return { ok: true, success: true };
    },
    shaderc() {
      return 0;
    },
    texturec() {
      return 0;
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'noveltea-editor-authoring-cache-'));
  roots.push(root);
  const project = createAuthoringProject({ id: 'editor-cache', name: 'Editor cache' });
  project.rooms.start = createDefaultAuthoringRecord(
    'rooms',
    'start',
  ) as typeof project.rooms.start;
  project.entrypoint = { kind: 'room', id: 'start' };
  for (const [relative, text] of Object.entries(projectWorkspaceFiles(project, project.editor))) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const opened = await createNodeProjectWorkspaceService().open(root);
  if (!opened.ok) throw new Error(opened.diagnostics[0]?.message ?? 'Fixture failed to open.');
  return {
    root,
    project: opened.snapshot.project,
    workspace: ActiveProjectWorkspaceSession.fromOpened(opened),
  };
}

async function currentGeneration(root: string) {
  return (
    JSON.parse(await readFile(path.join(root, '.noveltea/cache/authoring/current'), 'utf8')) as {
      generation: string;
    }
  ).generation;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('editor authoring validation cache sharing', () => {
  it('consumes a clean validation generation warmed by the CLI', async () => {
    const { root, project, workspace } = await fixture();
    const nativeTools = tools();
    const warmed = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });
    expect(warmed.exitCode).toBe(0);
    const generation = await currentGeneration(root);
    const sessionLocal = vi.fn(async () => ({ ok: true, success: true, diagnostics: [] }));
    const service = new EditorAuthoringValidationService({ nativeTools });

    const result = await service.validate({
      workspace,
      project,
      authority: 'disk-authoritative',
      validateSessionLocal: sessionLocal,
    });

    expect(result).toMatchObject({
      ok: true,
      success: true,
      diagnostics: warmed.envelope.diagnostics,
    });
    expect(sessionLocal).not.toHaveBeenCalled();
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('publishes clean editor validation for a later CLI cache hit', async () => {
    const { root, project, workspace } = await fixture();
    const nativeTools = tools();
    const service = new EditorAuthoringValidationService({ nativeTools });

    const editorResult = await service.validate({
      workspace,
      project,
      authority: 'disk-authoritative',
      validateSessionLocal: async () => ({ ok: true, success: true, diagnostics: [] }),
    });
    const generation = await currentGeneration(root);
    const cliResult = await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });

    expect(cliResult.envelope.diagnostics).toEqual(editorResult.diagnostics);
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('keeps dirty or disk-mismatched validation session-local without replacing the disk generation', async () => {
    const { root, project, workspace } = await fixture();
    const nativeTools = tools();
    await runNovelTeaCli(['--json', 'validate'], { cwd: root, nativeTools });
    const generation = await currentGeneration(root);
    const dirty = structuredClone(project);
    dirty.project.name = 'Unsaved editor name';
    const sessionLocal = vi.fn(async () => ({
      ok: true,
      success: false,
      diagnostics: [
        {
          code: 'editor.draft',
          severity: 'error' as const,
          path: '/project/name',
          message: 'draft',
        },
      ],
    }));
    const service = new EditorAuthoringValidationService({ nativeTools });

    const explicitDirty = await service.validate({
      workspace,
      project: dirty,
      authority: 'session-local',
      validateSessionLocal: sessionLocal,
    });
    const mismatchedCleanClaim = await service.validate({
      workspace,
      project: dirty,
      authority: 'disk-authoritative',
      validateSessionLocal: sessionLocal,
    });

    expect(explicitDirty.success).toBe(false);
    expect(mismatchedCleanClaim.success).toBe(false);
    expect(sessionLocal).toHaveBeenCalledTimes(2);
    expect(await currentGeneration(root)).toBe(generation);
  });

  it('keeps clean validation semantics when cache persistence is unavailable', async () => {
    const { root, project, workspace } = await fixture();
    const nativeTools = tools();
    await mkdir(path.join(root, '.noveltea/cache'), { recursive: true });
    await writeFile(path.join(root, '.noveltea/cache/authoring'), 'blocked');
    const sessionLocal = vi.fn(async () => ({ ok: true, success: false, diagnostics: [] }));
    const service = new EditorAuthoringValidationService({ nativeTools });

    const result = await service.validate({
      workspace,
      project,
      authority: 'disk-authoritative',
      validateSessionLocal: sessionLocal,
    });

    expect(result.ok).toBe(true);
    expect(result.success).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'warning')).toBe(true);
    expect(sessionLocal).not.toHaveBeenCalled();
    await expect(currentGeneration(root)).rejects.toBeTruthy();
  });

  it('becomes cache-eligible only after the active workspace reconciles the saved disk generation', async () => {
    const { root, project, workspace } = await fixture();
    const nativeTools = tools();
    const service = new EditorAuthoringValidationService({ nativeTools });
    const dirty = structuredClone(project);
    dirty.project.name = 'Saved editor name';

    await service.validate({
      workspace,
      project: dirty,
      authority: 'disk-authoritative',
      validateSessionLocal: async () => ({ ok: true, success: true, diagnostics: [] }),
    });
    await expect(currentGeneration(root)).rejects.toMatchObject({ code: 'ENOENT' });

    const projectJsonPath = path.join(root, 'project.json');
    const projectJson = JSON.parse(await readFile(projectJsonPath, 'utf8')) as {
      project: Record<string, unknown>;
    };
    projectJson.project.name = 'Saved editor name';
    await writeFile(projectJsonPath, JSON.stringify(projectJson));
    const reconciled = await workspace.reassemble(['project.json']);
    expect(reconciled.ok).toBe(true);

    await service.validate({
      workspace,
      project: workspace.project(),
      authority: 'disk-authoritative',
      validateSessionLocal: async () => ({ ok: true, success: true, diagnostics: [] }),
    });
    await expect(currentGeneration(root)).resolves.toBeTruthy();
  });
});
