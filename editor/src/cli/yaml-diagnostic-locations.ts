import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node } from 'yaml';
import {
  assertProjectWorkspacePathContained,
  type ProjectWorkspaceFileSystem,
} from '../shared/project-workspace/project-workspace-file-system';
import {
  parseRestrictedYamlDocument,
  RestrictedYamlSourceError,
} from '../shared/project-workspace/restricted-yaml-source';
import type { NovelTeaCliDiagnostic } from './contracts';

/** Source coordinates are presentation metadata; the logical diagnostic path remains stable. */
export async function locateYamlCliDiagnostics(
  fs: ProjectWorkspaceFileSystem,
  root: string,
  diagnostics: readonly NovelTeaCliDiagnostic[],
): Promise<NovelTeaCliDiagnostic[]> {
  const cache = new Map<string, Promise<string | undefined>>();
  const read = (file: string) => {
    let pending = cache.get(file);
    if (!pending) {
      const absolute = fs.joinPath(root, file);
      pending = assertProjectWorkspacePathContained(fs, root, absolute)
        .then(() => fs.readText(absolute))
        .catch(() => undefined);
      cache.set(file, pending);
    }
    return pending;
  };
  return Promise.all(
    diagnostics.map(async (diagnostic) => {
      // Recompute cached YAML coordinates: comments can move source lines without
      // changing the semantic source fingerprint used by validation.
      if (diagnostic.line !== undefined && !diagnostic.sourceUrl?.endsWith('.yaml'))
        return diagnostic;
      const segments = diagnostic.path
        .split('/')
        .slice(1)
        .map((s) => s.replace(/~1/gu, '/').replace(/~0/gu, '~'));
      let file: string | undefined;
      let sourcePath = segments;
      if (diagnostic.sourceUrl?.startsWith('project:/')) {
        file = diagnostic.sourceUrl.slice('project:/'.length);
        const record = /^records\/([^/]+)\/([^/]+)(?:\.yaml|\/layout\.yaml)$/u.exec(file);
        if (record && segments[0] === record[1] && segments[1] === record[2])
          sourcePath = segments.slice(2);
      } else if (['project.yaml', 'editor.yaml', 'traits.yaml'].includes(segments[0] ?? '')) {
        file = segments[0];
        sourcePath = segments.slice(1);
      } else if (segments[0] === 'records' && segments[1] && segments[2]?.endsWith('.yaml')) {
        file = segments.slice(0, 3).join('/');
        sourcePath = segments.slice(3);
      } else if (segments[0] === 'records' && segments[1] === 'layouts' && segments[2]) {
        file = `records/layouts/${segments[2]}/layout.yaml`;
        sourcePath = segments.slice(4);
      } else if (
        segments[0] &&
        segments[1] &&
        /^(rooms|maps|variables|layouts|assets|animations|materials|archetypes|scripts|characters|interactables|verbs|interactions|dialogues|scenes|tests)$/u.test(
          segments[0],
        )
      ) {
        file =
          segments[0] === 'layouts'
            ? `records/layouts/${segments[1]}/layout.yaml`
            : `records/${segments[0]}/${segments[1]}.yaml`;
        sourcePath = segments.slice(2);
      }
      if (
        !file?.endsWith('.yaml') ||
        file.startsWith('/') ||
        file.split('/').some((segment) => segment === '..')
      )
        return diagnostic;
      const text = await read(file);
      if (text === undefined) return diagnostic;
      const lines = new LineCounter();
      const document = parseDocument(text, { lineCounter: lines, strict: true, uniqueKeys: true });
      let offset: number | undefined;
      if (document.errors.length) {
        offset = document.errors[0]!.pos[0];
      } else {
        if (diagnostic.code.startsWith('WORKSPACE_')) {
          try {
            parseRestrictedYamlDocument(text);
          } catch (error) {
            if (error instanceof RestrictedYamlSourceError) offset = error.offset;
          }
        }
        let node: Node | null | undefined = document.contents;
        let last: Node | null | undefined = node;
        for (const part of sourcePath) {
          if (isMap(node)) {
            const pair = node.items.find(
              (item) => isScalar(item.key) && String(item.key.value) === part,
            );
            if (!pair) break;
            // For shortened references, the scalar itself is the authored source field.
            node = pair.value as Node | null;
            last = node ?? (pair.key as Node);
          } else if (isSeq(node) && /^\d+$/u.test(part)) {
            node = node.items[Number(part)] as Node | undefined;
            if (!node) break;
            last = node;
          } else break;
        }
        offset ??= last?.range?.[0];
      }
      if (offset === undefined) return { ...diagnostic, sourceUrl: `project:/${file}` };
      const { line, col } = lines.linePos(offset);
      return { ...diagnostic, sourceUrl: `project:/${file}`, line, column: col };
    }),
  );
}
