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

function literalCallPrefix(input: AuthoringSourceReferenceRecognizerInput): string {
  const start = input.occurrence.regionStartUtf16;
  if (start < 0 || start > input.region.decodedSource.length) return '';
  return input.region.decodedSource.slice(0, start);
}

function rewriteableLiteral(
  input: AuthoringSourceReferenceRecognizerInput,
  target: AuthoringDependencyNodeKey,
): AuthoringSourceReferenceRecognition {
  const { occurrence } = input;
  if (occurrence.literalKind === 'long-bracket') return { classification: 'exact-manual', target };
  return {
    classification: 'exact-rewriteable',
    target,
    rewriteRange: {
      startUtf16: occurrence.regionStartUtf16 + 1,
      endUtf16: occurrence.regionEndUtf16 - 1,
      expectedText: occurrence.decodedValue,
    },
  };
}

const scriptModuleImportRecognizer: AuthoringSourceReferenceRecognizer = {
  id: 'noveltea.script-module-import',
  recognize(input) {
    if (input.region.sourceKind !== 'lua-field') return null;
    if (!/(?:^|[^\w.])import\s*\(\s*$/.test(literalCallPrefix(input))) return null;
    return rewriteableLiteral(input, {
      kind: 'record',
      collection: 'scripts',
      id: input.occurrence.decodedValue,
    });
  },
};

const gameplayIdentityRecognizer: AuthoringSourceReferenceRecognizer = {
  id: 'noveltea.gameplay-identity',
  recognize(input) {
    if (input.region.sourceKind !== 'lua-field') return null;
    const prefix = literalCallPrefix(input);
    const match = prefix.match(/noveltea\.project\.(room|character|interactable)\s*\(\s*$/);
    if (!match) return null;
    const collection = `${match[1]}s` as 'rooms' | 'characters' | 'interactables';
    return rewriteableLiteral(input, {
      kind: 'record',
      collection,
      id: input.occurrence.decodedValue,
    });
  },
};

/** Product recognizers are registered only after their Lua/RML API contract is designed. */
export const AUTHORING_SOURCE_REFERENCE_RECOGNIZERS: readonly AuthoringSourceReferenceRecognizer[] =
  Object.freeze([scriptModuleImportRecognizer, gameplayIdentityRecognizer]);

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
