import { LineCounter, parseDocument } from 'yaml';
import type { ToolDiagnostic } from './editor-tooling';

/** YAML syntax-only feedback shared by the candidate editor and native
 * candidate admission. This does not validate the NovelTea Project schema. */
export function candidateManifestSyntaxDiagnostics(text: string): ToolDiagnostic[] {
  const lines = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  return parsed.errors.map((error) => {
    const position = lines.linePos(error.pos[0]);
    return {
      severity: 'error' as const,
      path: '/project.yaml',
      sourcePath: 'project.yaml',
      line: position.line,
      column: position.col,
      category: 'Project source syntax',
      message: error.message,
    };
  });
}
