import type { NovelTeaCliDiagnostic, NovelTeaCliExitCode } from './contracts';

// Shared command outcome contract: neither native CLI commands nor retained
// host-only tools should depend on the retired TypeScript semantic Project.
export interface CliSemanticResult {
  readonly ok: boolean;
  readonly diagnostics: readonly NovelTeaCliDiagnostic[];
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly humanSuccess?: string;
  readonly exitCode?: NovelTeaCliExitCode;
}
