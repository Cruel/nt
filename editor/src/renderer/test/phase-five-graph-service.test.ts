import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { ProjectTextSourceReadSessionService } from '../../main/services/project-text-source-service';
import { AuthoringDependencyGraphService } from '../project/authoring-dependency-graph-service';
import { buildAuthoringDependencyGraph } from '../../shared/authoring-dependency-graph';
import type { ProjectMutationPublication } from '../../shared/authoring-dependency-contracts';
import type { AuthoringDependencyGraph } from '../../shared/authoring-dependency-contracts';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import type { StructurallyAdmittedAuthoringProject } from '../../shared/project-schema/structurally-admitted-authoring-project';
import { defaultScriptModuleData } from '../../shared/project-schema/authoring-script-modules';
import type { ReadProjectTextSourcesRequest } from '../../shared/project-text-sources';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('Phase 5 project text source reads', () => {
  it('binds opaque sessions, preserves request ordering, verifies hashes, and isolates failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noveltea-source-read-'));
    temporaryRoots.push(root);
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    const bytes = Buffer.from('\ufeffreturn "room"', 'utf8');
    await fs.writeFile(path.join(root, 'assets', 'script.lua'), bytes);
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    const service = new ProjectTextSourceReadSessionService();
    const session = service.assignProjectFile(path.join(root, 'game.json'));

    const response = await service.read({
      projectReadSessionId: session,
      entries: [
        { readKey: 'good', projectRelativePath: 'assets/script.lua', expectedContentHash: hash },
        {
          readKey: 'bad',
          projectRelativePath: 'assets/script.lua',
          expectedContentHash: `sha256:${'0'.repeat(64)}`,
        },
      ],
    });

    expect(response.entries.map((entry) => entry.readKey)).toEqual(['good', 'bad']);
    expect(response.entries[0]).toMatchObject({
      status: 'ready',
      text: 'return "room"',
      hadUtf8Bom: true,
    });
    expect(response.entries[1]).toMatchObject({ status: 'unavailable', code: 'hash-mismatch' });
    expect(
      await service.read({
        projectReadSessionId: 'stale',
        entries: response.entries.flatMap(() => []),
      }),
    ).toEqual({ entries: [] });
  });
});

describe('Phase 5 incremental authoring graph service', () => {
  it('publishes full-build equivalence and advances graph-stable revisions without graph work', async () => {
    const project = createAuthoringProject() as StructurallyAdmittedAuthoringProject;
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      description: 'Before',
      data: defaultRoomData('Foyer'),
    };
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => null,
      readProjectTextSources: async () => ({ entries: [] }),
    });
    const load = publication(null, project, 1, 'load', ['/']);
    const first = await service.publish(load);
    expect(first?.graph).toEqual(buildAuthoringDependencyGraph(project, { mode: 'disabled' }));

    const changed = structuredClone(project) as StructurallyAdmittedAuthoringProject;
    changed.rooms.foyer.description = 'After';
    const second = await service.publish(
      publication(project, changed, 2, 'command', ['/rooms/foyer/description']),
    );
    expect(second?.projectRevision).toBe(2);
    expect(second?.graphRevision).toBe(first?.graphRevision);
    expect(second?.graph).toBe(first?.graph);
    expect(service.instrumentation()).toMatchObject({
      fullBuilds: 1,
      graphStableAdvances: 1,
      sourceReadBatches: 0,
    });
    expect(service.currentSourceAnalysis('instance', 1)).toBeNull();
    expect(service.currentSourceAnalysis('instance', 2)).toEqual([]);
  });

  it('fans one physical source read to multiple owners and reuses persistent analysis caches', async () => {
    const text = 'return "foyer"';
    const hash = `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
    const project = sourceProject(text, hash);
    const reads = vi.fn(async (request: ReadProjectTextSourcesRequest) => ({
      entries: request.entries.map((entry) => ({
        status: 'ready' as const,
        readKey: entry.readKey,
        projectRelativePath: entry.projectRelativePath,
        contentHash: hash,
        text,
        hadUtf8Bom: false,
      })),
    }));
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: reads,
    });
    const first = await service.publish(publication(null, project, 1, 'load', ['/']));
    expect(first).not.toBeNull();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls[0]?.[0].entries).toHaveLength(1);
    expect(
      service.currentSourceAnalysis('instance', 1, scriptKey('one'))?.[0]?.sourceAssetIds,
    ).toEqual(['shared']);
    expect(
      service.currentSourceAnalysis('instance', 1, scriptKey('two'))?.[0]?.sourceAssetIds,
    ).toEqual(['shared']);

    const changed = structuredClone(project) as StructurallyAdmittedAuthoringProject;
    changed.scripts.one.label = 'One renamed';
    const second = await service.publish(
      publication(project, changed, 2, 'command', ['/scripts/one/label']),
    );
    const fresh = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: hash,
          text,
          hadUtf8Bom: false,
        })),
      }),
    });
    const freshSnapshot = await fresh.publish(publication(null, changed, 2, 'load', ['/']));
    expect(canonicalGraph(second!.graph)).toBe(canonicalGraph(freshSnapshot!.graph));
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping async mutations and publishes the latest revision with accumulated work', async () => {
    const text = 'return "foyer"';
    const hash = `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
    const project = sourceProject(text, hash);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => {
        await gate;
        return {
          entries: request.entries.map((entry) => ({
            status: 'ready' as const,
            readKey: entry.readKey,
            projectRelativePath: entry.projectRelativePath,
            contentHash: hash,
            text,
            hadUtf8Bom: false,
          })),
        };
      },
    });
    const firstPromise = service.publish(publication(null, project, 1, 'load', ['/']));
    const secondProject = structuredClone(project) as StructurallyAdmittedAuthoringProject;
    secondProject.rooms.foyer.description = 'second';
    const secondPromise = service.publish(
      publication(project, secondProject, 2, 'command', ['/rooms/foyer/description']),
    );
    const thirdProject = structuredClone(secondProject) as StructurallyAdmittedAuthoringProject;
    thirdProject.scripts.one.label = 'third';
    const thirdPromise = service.publish(
      publication(secondProject, thirdProject, 3, 'command', ['/scripts/one/label']),
    );
    release();
    const [first, second, third] = await Promise.all([firstPromise, secondPromise, thirdPromise]);
    expect(first?.projectRevision).toBe(3);
    expect(second?.projectRevision).toBe(3);
    expect(third?.projectRevision).toBe(3);
    const fresh = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: hash,
          text,
          hadUtf8Bom: false,
        })),
      }),
    });
    const freshSnapshot = await fresh.publish(publication(null, thirdProject, 3, 'load', ['/']));
    expect(canonicalGraph(third!.graph)).toBe(canonicalGraph(freshSnapshot!.graph));
    expect(service.instrumentation().staleCompletions).toBeGreaterThan(0);
  });

  it('removes deleted owner contributions and cached owner analysis incrementally', async () => {
    const text = 'return "foyer"';
    const hash = `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
    const project = sourceProject(text, hash);
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: hash,
          text,
          hadUtf8Bom: false,
        })),
      }),
    });
    await service.publish(publication(null, project, 1, 'load', ['/']));

    const changed = structuredClone(project) as StructurallyAdmittedAuthoringProject;
    delete changed.scripts.one;
    const snapshot = await service.publish(
      publication(project, changed, 2, 'command', ['/scripts/one']),
    );
    const fresh = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: hash,
          text,
          hadUtf8Bom: false,
        })),
      }),
    });
    const full = await fresh.publish(publication(null, changed, 2, 'load', ['/']));
    expect(canonicalGraph(snapshot!.graph)).toBe(canonicalGraph(full!.graph));
    expect(service.currentSourceAnalysis('instance', 2, scriptKey('one'))).toEqual([]);
    expect(service.instrumentation().fullBuilds).toBe(1);
  });

  it('unions the earliest old and latest new symbol impacts across async mutations', async () => {
    const initialText = 'return "alpha"';
    const initialHash = `sha256:${createHash('sha256').update(initialText).digest('hex')}` as const;
    const nextText = 'return "alpha" -- changed source';
    const nextHash = `sha256:${createHash('sha256').update(nextText).digest('hex')}` as const;
    const project = sourceProject(initialText, initialHash);
    project.rooms.foyer.id = 'alpha';
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => {
        const expectedHash = request.entries[0]?.expectedContentHash;
        if (expectedHash === nextHash) await gate;
        const text = expectedHash === nextHash ? nextText : initialText;
        return {
          entries: request.entries.map((entry) => ({
            status: 'ready' as const,
            readKey: entry.readKey,
            projectRelativePath: entry.projectRelativePath,
            contentHash: entry.expectedContentHash,
            text,
            hadUtf8Bom: false,
          })),
        };
      },
    });
    await service.publish(publication(null, project, 1, 'load', ['/']));

    const secondProject = structuredClone(project) as StructurallyAdmittedAuthoringProject;
    secondProject.rooms.foyer.id = 'beta';
    (secondProject.assets.shared.data as { contentHash?: string }).contentHash = nextHash;
    const secondPromise = service.publish(
      publication(project, secondProject, 2, 'command', [
        '/rooms/foyer/id',
        '/assets/shared/data/contentHash',
      ]),
    );
    const thirdProject = structuredClone(secondProject) as StructurallyAdmittedAuthoringProject;
    thirdProject.rooms.foyer.id = 'gamma';
    const thirdPromise = service.publish(
      publication(secondProject, thirdProject, 3, 'command', ['/rooms/foyer/id']),
    );
    release();
    const [, latest] = await Promise.all([secondPromise, thirdPromise]);

    const fresh = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: entry.expectedContentHash,
          text: nextText,
          hadUtf8Bom: false,
        })),
      }),
    });
    const full = await fresh.publish(publication(null, thirdProject, 3, 'load', ['/']));
    expect(canonicalGraph(latest!.graph)).toBe(canonicalGraph(full!.graph));
  });

  it('keeps incremental source, symbol, localization, and property mutations equivalent to fresh builds', async () => {
    const text = 'return "foyer"';
    const hash = `sha256:${createHash('sha256').update(text).digest('hex')}` as const;
    let currentText = text;
    let currentHash = hash;
    const service = new AuthoringDependencyGraphService({
      getProjectReadSessionId: () => 'session',
      readProjectTextSources: async (request) => ({
        entries: request.entries.map((entry) => ({
          status: 'ready' as const,
          readKey: entry.readKey,
          projectRelativePath: entry.projectRelativePath,
          contentHash: currentHash,
          text: currentText,
          hadUtf8Bom: false,
        })),
      }),
    });
    let project = sourceProject(text, hash);
    await service.publish(publication(null, project, 1, 'load', ['/']));

    const mutations: Array<[string, (next: StructurallyAdmittedAuthoringProject) => void]> = [
      ['/rooms/foyer/id', (next) => (next.rooms.foyer.id = 'hall')],
      [
        '/localization/entries/title/en-US',
        (next) => {
          (next.localization as unknown as { entries: Record<string, unknown> }).entries = {
            title: { 'en-US': 'Title' },
          };
        },
      ],
      [
        '/properties/mood/defaultValue',
        (next) => {
          (next.properties as unknown as Record<string, unknown>).mood = {
            id: 'mood',
            label: 'Mood',
            type: 'string',
            defaultValue: 'calm',
          };
        },
      ],
      [
        '/assets/shared/data/contentHash',
        (next) => {
          currentText = 'return "hall"';
          currentHash = `sha256:${createHash('sha256').update(currentText).digest('hex')}` as const;
          (next.assets.shared.data as { contentHash?: string }).contentHash = currentHash;
        },
      ],
      [
        '/assets/shared/data/source/path',
        (next) => {
          (
            next.assets.shared.data as {
              source: { path: string };
            }
          ).source.path = 'assets/scripts/shared-renamed.lua';
        },
      ],
    ];
    let revision = 1;
    for (const [pathValue, mutate] of mutations) {
      const previous = project;
      project = structuredClone(project) as StructurallyAdmittedAuthoringProject;
      mutate(project);
      revision += 1;
      const snapshot = await service.publish(
        publication(previous, project, revision, 'command', [pathValue]),
      );
      const fresh = new AuthoringDependencyGraphService({
        getProjectReadSessionId: () => 'session',
        readProjectTextSources: async (request) => ({
          entries: request.entries.map((entry) => ({
            status: 'ready' as const,
            readKey: entry.readKey,
            projectRelativePath: entry.projectRelativePath,
            contentHash: currentHash,
            text: currentText,
            hadUtf8Bom: false,
          })),
        }),
      });
      const full = await fresh.publish(publication(null, project, revision, 'load', ['/']));
      expect(canonicalGraph(snapshot!.graph)).toBe(canonicalGraph(full!.graph));
    }
    expect(service.instrumentation().symbolReprojections).toBeGreaterThan(0);
  });
});

function scriptKey(id: string): string {
  return `record:${JSON.stringify(['record', 'scripts', id])}`;
}

function canonicalGraph(graph: AuthoringDependencyGraph): string {
  return JSON.stringify({
    nodes: [...graph.nodesByKey],
    edges: [...graph.edgesById],
    outgoing: [...graph.outgoingEdgeIdsByNodeKey],
    incoming: [...graph.incomingEdgeIdsByNodeKey],
    owned: [...graph.sourceNodeKeysByOwnedPath],
    diagnostics: graph.diagnostics,
  });
}

function sourceProject(
  _text: string,
  hash: `sha256:${string}`,
): StructurallyAdmittedAuthoringProject {
  const project = createAuthoringProject() as StructurallyAdmittedAuthoringProject;
  project.rooms.foyer = {
    id: 'foyer',
    label: 'Foyer',
    description: '',
    data: defaultRoomData('Foyer'),
  };
  project.assets.shared = {
    id: 'shared',
    label: 'Shared',
    data: {
      kind: 'script',
      source: { type: 'project-file', path: 'assets/scripts/shared.lua' },
      aliases: [],
      extension: '.lua',
      contentHash: hash,
      imageMetadata: null,
    },
  };
  for (const id of ['one', 'two']) {
    const data = defaultScriptModuleData();
    data.source = { kind: 'asset', asset: { $ref: { collection: 'assets', id: 'shared' } } };
    project.scripts[id] = { id, label: id, data };
  }
  return project;
}

function publication(
  previousProject: StructurallyAdmittedAuthoringProject | null,
  project: StructurallyAdmittedAuthoringProject,
  projectRevision: number,
  kind: ProjectMutationPublication<StructurallyAdmittedAuthoringProject>['changeSet']['kind'],
  affectedPaths: readonly string[],
): ProjectMutationPublication<StructurallyAdmittedAuthoringProject> {
  return {
    previousProject,
    project,
    changeSet: {
      projectInstanceId: 'instance',
      projectRevision,
      kind,
      affectedPaths,
    },
  };
}
