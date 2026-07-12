import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { TagInput } from '@/components/tags/TagInput';
import { useCommandStore } from '@/commands/command-store';
import { buildDefaultRecordTab } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { collectProjectTags } from '../../../shared/project-schema/authoring-tags';
import {
  authoringCollectionMetadata,
  type AuthoringCollectionKey,
} from '../../../shared/project-schema/authoring-collections';
import { isValidEntityId, type AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  defaultNewEntityWizardCollection,
  isNewEntityWizardCollection,
  newEntityWizardDefinition,
  newEntityWizardDefinitions,
} from './registry';
import type { NewEntityWizardDraft } from './types/common';

export interface NewEntityWizardDialogProps {
  open: boolean;
  project: AuthoringProject | null;
  initialCollection?: AuthoringCollectionKey | null;
  onOpenChange: (open: boolean) => void;
  onCreated?: (target: { collection: AuthoringCollectionKey; entityId: string }) => void;
}

function kebabIdFromLabel(label: string, fallback: string) {
  const normalized = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const candidate = /^[a-z]/.test(normalized) ? normalized : normalized ? `${fallback}-${normalized}` : fallback;
  return candidate || fallback;
}

function defaultLabel(collection: AuthoringCollectionKey) {
  return `New ${authoringCollectionMetadata[collection].singularLabel}`;
}

function supportLabel(level: string) {
  if (level === 'typed') return 'Typed';
  if (level === 'external-flow') return 'External flow';
  return 'Metadata only';
}

function initialDraft(project: AuthoringProject, collection: AuthoringCollectionKey): NewEntityWizardDraft {
  const definition = newEntityWizardDefinition(collection);
  const label = defaultLabel(collection);
  return {
    basics: {
      collection,
      entityId: kebabIdFromLabel(label, authoringCollectionMetadata[collection].nodeType),
      label,
      description: '',
      tags: [],
      color: '',
    },
    options: definition.defaultOptions?.(project) ?? {},
  };
}

function FieldRow({ children }: { children: ReactNode }) {
  return <div className="space-y-1.5">{children}</div>;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</Label>;
}

export function NewEntityWizardDialog({
  open,
  project,
  initialCollection,
  onOpenChange,
  onCreated,
}: NewEntityWizardDialogProps) {
  const executeCommand = useCommandStore((store) => store.executeCommand);
  const openTab = useWorkbenchStore((store) => store.openTab);
  const [collection, setCollection] = useState<AuthoringCollectionKey>(() => {
    if (initialCollection && isNewEntityWizardCollection(initialCollection)) return initialCollection;
    return defaultNewEntityWizardCollection();
  });
  const [draft, setDraft] = useState<NewEntityWizardDraft | null>(null);
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !project) return;
    const nextCollection = initialCollection && isNewEntityWizardCollection(initialCollection)
      ? initialCollection
      : defaultNewEntityWizardCollection();
    setCollection(nextCollection);
    setDraft(initialDraft(project, nextCollection));
    setIdManuallyEdited(false);
    setError(null);
  }, [initialCollection, open, project]);

  const definition = newEntityWizardDefinition(collection);
  const metadata = authoringCollectionMetadata[collection];
  const tagSuggestions = useMemo(() => project && draft ? collectProjectTags(project, draft.basics.tags) : [], [draft, project]);

  if (!project || !draft) return null;

  function replaceDraft(next: NewEntityWizardDraft) {
    setDraft(next);
    setError(null);
  }

  function changeCollection(nextCollection: AuthoringCollectionKey) {
    setCollection(nextCollection);
    replaceDraft(initialDraft(project!, nextCollection));
    setIdManuallyEdited(false);
  }

  function updateBasics(values: Partial<NewEntityWizardDraft['basics']>) {
    replaceDraft({ ...draft!, basics: { ...draft!.basics, ...values } });
  }

  function updateLabel(label: string) {
    const nextBasics = { ...draft!.basics, label };
    if (!idManuallyEdited) nextBasics.entityId = kebabIdFromLabel(label, metadata.nodeType);
    replaceDraft({ ...draft!, basics: nextBasics });
  }

  function setOption(key: string, value: string | boolean | number | null) {
    replaceDraft({ ...draft!, options: { ...draft!.options, [key]: value } });
  }

  function submit() {
    if (!project) return;
    const activeProject = project;
    const activeDraft = draft!;
    const entityId = activeDraft.basics.entityId.trim();
    const label = activeDraft.basics.label.trim();
    if (!isValidEntityId(entityId)) {
      setError('ID must be lowercase kebab-case, start with a letter, and contain only letters, numbers, and hyphens.');
      return;
    }
    const extra = definition.buildPayload({ project: activeProject, draft: activeDraft });
    const result = executeCommand({
      type: 'entity.createRecord',
      label: `Create ${metadata.singularLabel}`,
      payload: {
        collection,
        entityId,
        label: label || undefined,
        description: activeDraft.basics.description.trim() || undefined,
        tags: activeDraft.basics.tags,
        color: activeDraft.basics.color.trim() || null,
        ...extra,
      },
    });
    const failure = result.diagnostics.find((diagnostic) => diagnostic.severity === 'error');
    if (!result.ok || failure) {
      setError(failure?.message ?? 'Create command failed.');
      return;
    }
    if (collection === 'rooms' && activeDraft.options.setEntrypoint) {
      executeCommand({
        type: 'project.setEntrypoint',
        label: 'Set project entrypoint',
        payload: { target: { kind: 'room', id: entityId } },
      });
    }
    const tab = buildDefaultRecordTab({ id: `${collection}:${entityId}`, label: label || entityId, type: metadata.nodeType, collection, entityId });
    if (tab) openTab(tab);
    onCreated?.({ collection, entityId });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="!flex h-[calc(100vh-4rem)] max-h-[52rem] !w-[calc(100vw-3rem)] !max-w-none sm:!max-w-6xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b bg-muted/20 px-6 py-5 pr-12">
          <DialogTitle className="text-base font-semibold">New Entity Wizard</DialogTitle>
          <DialogDescription className="max-w-3xl">
            Choose a project record type, set the base metadata, and apply the current type-specific defaults.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[20rem_minmax(0,1fr)]">
          <div className="min-h-0 overflow-y-auto overscroll-contain border-r bg-muted/10 p-3">
            <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Entity type
            </div>
            {newEntityWizardDefinitions.map((item) => {
              const Icon = item.icon;
              const selected = item.collection === collection;
              return (
                <button
                  key={item.collection}
                  type="button"
                  className={`mb-2 flex w-full gap-3 rounded-lg border p-3 text-left text-xs transition-colors ${selected ? 'border-primary/70 bg-primary/10 text-foreground shadow-sm' : 'border-border/70 bg-card/35 text-foreground hover:bg-accent/70'}`}
                  onClick={() => changeCollection(item.collection)}
                >
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${item.iconClassName}`} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium leading-none">
                      {authoringCollectionMetadata[item.collection].singularLabel}
                    </span>
                    <span className="mt-2 block line-clamp-3 leading-relaxed text-muted-foreground">
                      {item.summary}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5">
            <div className="mx-auto max-w-3xl space-y-4">
              {error ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  {error}
                </div>
              ) : null}
              <Card className="border-border/70 bg-card/60 shadow-none">
                <CardContent className="space-y-4 p-5">
                  <div className="flex items-start gap-4">
                  {(() => {
                    const Icon = definition.icon;
                    return (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background/60">
                        <Icon className={`h-5 w-5 ${definition.iconClassName}`} />
                      </div>
                    );
                  })()}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="text-base font-semibold leading-none">{metadata.singularLabel}</div>
                        <Badge variant={definition.supportLevel === 'typed' ? 'default' : 'outline'}>
                          {supportLabel(definition.supportLevel)}
                        </Badge>
                    </div>
                      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                        {definition.currentScope}
                      </p>
                  </div>
                </div>
                <Separator />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FieldRow>
                      <FieldLabel>Label</FieldLabel>
                      <Input aria-label="Entity label" value={draft.basics.label} onChange={(event) => updateLabel(event.currentTarget.value)} />
                    </FieldRow>
                    <FieldRow>
                      <FieldLabel>ID</FieldLabel>
                      <Input aria-label="Entity ID" value={draft.basics.entityId} onChange={(event) => { setIdManuallyEdited(true); updateBasics({ entityId: event.currentTarget.value }); }} placeholder="lowercase-kebab-id" />
                    </FieldRow>
                    <FieldRow>
                      <FieldLabel>Tags</FieldLabel>
                      <TagInput value={draft.basics.tags} onChange={(tags) => updateBasics({ tags })} suggestions={tagSuggestions} placeholder="Add tag" />
                    </FieldRow>
                    <FieldRow>
                      <FieldLabel>Color</FieldLabel>
                      <Input aria-label="Entity color" value={draft.basics.color} onChange={(event) => updateBasics({ color: event.currentTarget.value })} placeholder="#64748b or empty" />
                    </FieldRow>
                    <FieldRow>
                      <FieldLabel>Parent</FieldLabel>
                    </FieldRow>
                    <FieldRow>
                      <FieldLabel>Description</FieldLabel>
                      <Input aria-label="Entity description" value={draft.basics.description} onChange={(event) => updateBasics({ description: event.currentTarget.value })} placeholder="Optional description" />
                    </FieldRow>
                </div>
              </CardContent>
            </Card>
            {definition.renderOptions ? (
                <Card className="border-border/70 bg-card/60 shadow-none">
                  <CardContent className="space-y-4 p-5">
                  <div>
                    <div className="text-sm font-semibold">{metadata.singularLabel} setup</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Bare-bones defaults now; this section is where richer presets will grow.
                      </p>
                  </div>
                  {definition.renderOptions({ project, draft, setOption })}
                </CardContent>
              </Card>
            ) : null}
            </div>
          </div>
        </div>
        <DialogFooter className="border-t bg-muted/20 px-6 py-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={definition.supportLevel === 'external-flow'}>{definition.supportLevel === 'external-flow' ? 'Use asset import flow' : `Create ${metadata.singularLabel}`}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
