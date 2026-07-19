import type { ComponentType, ReactNode } from 'react';
import type { CreateEntityRecordPayload } from '@/project/entity-operations';
import type { AuthoringCollectionKey } from '../../../../shared/project-schema/authoring-collections';
import type { AuthoringProject } from '../../../../shared/project-schema/authoring-project';

export type WizardSupportLevel = 'typed' | 'metadata-only' | 'external-flow';

export interface NewEntityWizardBasics {
  collection: AuthoringCollectionKey;
  entityId: string;
  label: string;
  description: string;
  tags: string[];
  color: string;
}

export interface NewEntityWizardDraft {
  basics: NewEntityWizardBasics;
  options: Record<string, string | boolean | number | null>;
}

export interface NewEntityWizardBuildContext {
  project: AuthoringProject;
  draft: NewEntityWizardDraft;
}

export interface NewEntityWizardTypeDefinition {
  collection: AuthoringCollectionKey;
  category: 'story' | 'world' | 'presentation' | 'logic' | 'assets' | 'testing';
  supportLevel: WizardSupportLevel;
  summary: string;
  currentScope: string;
  icon: ComponentType<{ className?: string }>;
  iconClassName: string;
  defaultOptions?: (project: AuthoringProject) => Record<string, string | boolean | number | null>;
  renderOptions?: (props: {
    project: AuthoringProject;
    draft: NewEntityWizardDraft;
    setOption: (key: string, value: string | boolean | number | null) => void;
  }) => ReactNode;
  buildPayload: (
    context: NewEntityWizardBuildContext,
  ) => Omit<
    CreateEntityRecordPayload,
    'collection' | 'entityId' | 'label' | 'description' | 'tags' | 'color'
  >;
}

export function selected(value: unknown): string | null {
  return typeof value === 'string' && value !== '__none__' ? value : null;
}

export function ref<Collection extends AuthoringCollectionKey>(
  collection: Collection,
  id: string,
): { $ref: { collection: Collection; id: string } } {
  return { $ref: { collection, id } };
}
