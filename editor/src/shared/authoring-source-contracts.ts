import type {
  AuthoringDependencyContributionKey,
  AuthoringDependencyNodeKey,
} from './authoring-dependency-contracts';
import type { AuthoringLuaExecutionSurface } from './project-schema/authoring-lua-source-registry';

export type AuthoringLuaSourceDescriptor = {
  executionSurface: AuthoringLuaExecutionSurface;
  contributionKey: AuthoringDependencyContributionKey;
  semanticOwner: AuthoringDependencyNodeKey;
  sourcePath: string;
  sourceKind: 'lua' | 'rml' | 'rcss';
  sourceUrl: string;
  inlineText?: string;
  sourceAssetId?: string;
  focusedAdmission: boolean;
  focusedFacet?: 'preview-visual' | 'preview-ui';
  supportsExplicitFallback: boolean;
  explicitDependenciesPath?: string;
  explicitDependencies?: readonly unknown[];
  layoutId?: string;
  dependencyScriptPaths?: readonly string[];
  dependencyTemplateIds?: readonly string[];
};
