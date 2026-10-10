import { invokeNovelTeaNativeOperation } from '../../shared/noveltea-cli-subprocess';

export interface FontInspectionResult {
  ok: boolean;
  glyphCount?: number;
  error?: string;
}

/** The editor and CLI use the same native FreeType inspection, not a JavaScript font parser. */
export async function validateImportedFont(
  absolutePath: string,
  extension: string,
  inspect: (path: string) => Promise<FontInspectionResult> = async (path) =>
    (await invokeNovelTeaNativeOperation('font-inspect', { path })) as FontInspectionResult,
): Promise<void> {
  let result: FontInspectionResult;
  try {
    result = await inspect(absolutePath);
  } catch (error) {
    throw new Error(
      `Cannot import font '${extension}': ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (result.ok !== true)
    throw new Error(
      `Cannot import font '${extension}': ${result.error ?? 'FreeType rejected the font'}.`,
    );
}
