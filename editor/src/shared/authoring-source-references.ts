import type { AuthoringDependencyNodeKey } from './authoring-dependency-contracts';
import type {
  AuthoringLiteralOccurrence,
  EmbeddedLuaSourceRegion,
  LuaReferenceOccurrence,
} from './project-schema/authoring-lua-analysis';
import type { AuthoringProject } from './project-schema/authoring-project';

export type AuthoringSourceReferenceClassification =
  | 'exact-rewriteable'
  | 'exact-manual'
  | 'possible-lexical'
  | 'unrelated';

export interface AuthoringSourceReferenceRewriteRange {
  /** UTF-16 offsets in the complete authored source identified by sourceUrl. */
  startUtf16: number;
  endUtf16: number;
  /** Exact bytes-as-text expected at the range before a rewrite is planned. */
  expectedText: string;
}

export type AuthoringSourceReferenceRecognition =
  | {
      classification: 'exact-rewriteable';
      target: AuthoringDependencyNodeKey;
      rewriteRange: AuthoringSourceReferenceRewriteRange;
    }
  | {
      classification: 'exact-manual';
      target: AuthoringDependencyNodeKey;
    };

export interface AuthoringSourceReferenceRecognizerInput {
  project: AuthoringProject;
  occurrence: AuthoringLiteralOccurrence;
  region: EmbeddedLuaSourceRegion;
}

/**
 * Extension seam for future, explicitly designed Lua/RML semantic APIs.
 * Phase 5 intentionally registers no product recognizers.
 */
export interface AuthoringSourceReferenceRecognizer {
  readonly id: string;
  recognize(
    input: AuthoringSourceReferenceRecognizerInput,
  ): AuthoringSourceReferenceRecognition | null;
}

/** Product recognizers are registered here only after their Lua/RML API contract is designed. */
export const AUTHORING_SOURCE_REFERENCE_RECOGNIZERS: readonly AuthoringSourceReferenceRecognizer[] =
  Object.freeze([]);

export interface ClassifiedAuthoringSourceReference {
  classification: AuthoringSourceReferenceClassification;
  occurrence: LuaReferenceOccurrence<AuthoringDependencyNodeKey> | AuthoringLiteralOccurrence;
  recognizedBy?: string;
  rewriteRange?: AuthoringSourceReferenceRewriteRange;
}

export function classifyRecognizedAuthoringSourceReference(
  input: AuthoringSourceReferenceRecognizerInput,
  recognizers: readonly AuthoringSourceReferenceRecognizer[],
): ClassifiedAuthoringSourceReference | null {
  for (const recognizer of recognizers) {
    const recognized = recognizer.recognize(input);
    if (!recognized) continue;
    return {
      classification: recognized.classification,
      occurrence: {
        ...input.occurrence,
        confidence: 'api-context',
        candidateTargets: [recognized.target],
      },
      recognizedBy: recognizer.id,
      ...(recognized.classification === 'exact-rewriteable'
        ? { rewriteRange: recognized.rewriteRange }
        : {}),
    };
  }
  return null;
}
