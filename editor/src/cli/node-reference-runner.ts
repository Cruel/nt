import { runNovelTeaCli, type RunNovelTeaCliOptions } from './application';
import type { NovelTeaCliCommandResult } from './contracts';

export interface NovelTeaCliReferenceInvocation {
  readonly argv: readonly string[];
  readonly options?: RunNovelTeaCliOptions;
}

export interface NovelTeaCliReferenceRunner {
  run(invocation: NovelTeaCliReferenceInvocation): Promise<NovelTeaCliCommandResult>;
}

export const novelTeaNodeReferenceRunner: NovelTeaCliReferenceRunner = {
  run(invocation) {
    return runNovelTeaCli(invocation.argv, invocation.options);
  },
};

export const PHASE_SIX_NODE_REFERENCE_COMMANDS = Object.freeze([
  'validate',
  'entity create',
  'entity rename',
  'entity delete',
  'usages',
] as const);
