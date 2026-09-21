import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { MaterialPreview } from '@/material-preview/MaterialPreview';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import {
  buildMaterialDetailTabForRecord,
  type WorkbenchEditorProps,
} from '@/workbench/editor-registry';
import { NewEntityWizardDialog } from '@/wizard/new-entity/NewEntityWizardDialog';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';

export function MaterialsLibraryEditor(_props: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const openTab = useWorkbenchStore((state) => state.openTab);
  const livePreviews = usePreferencesStore((state) => state.materialLibraryLivePreviews);
  const setLivePreviews = usePreferencesStore((state) => state.setMaterialLibraryLivePreviews);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const materials = useMemo(() => {
    if (!project) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return Object.entries(project.materials)
      .map(([id, record]) => ({ id, record, resolved: resolveMaterialData(project, id).data }))
      .filter(({ id, record }) => {
        if (!normalized) return true;
        return [id, record.label, record.description ?? '']
          .join('\n')
          .toLocaleLowerCase()
          .includes(normalized);
      })
      .sort((left, right) => left.record.label.localeCompare(right.record.label));
  }, [project, query]);

  if (!project)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('materialsLibrary.noProject')}
      </div>
    );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t('materialsLibrary.searchLabel')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t('materialsLibrary.searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="material-library-live-previews"
            checked={livePreviews}
            onCheckedChange={setLivePreviews}
          />
          <Label htmlFor="material-library-live-previews" className="text-xs">
            {t('materialsLibrary.livePreviews')}
          </Label>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="h-4 w-4" />
          {t('materialsLibrary.newMaterial')}
        </Button>
      </div>

      {materials.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {query ? t('materialsLibrary.noMatches') : t('materialsLibrary.empty')}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 auto-rows-[15rem] grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 overflow-auto p-3">
          {materials.map(({ id, record, resolved }) => (
            <button
              key={id}
              type="button"
              className="group flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => openTab(buildMaterialDetailTabForRecord(id, record.label))}
            >
              <div className="min-h-0 flex-1 bg-muted/20">
                {livePreviews ? (
                  <MaterialPreview materialId={id} compact className="min-h-0" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {t('materialsLibrary.previewDisabled')}
                  </div>
                )}
              </div>
              <div className="shrink-0 space-y-1 border-t p-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {record.label}
                  </span>
                  {resolved ? <Badge variant="outline">{resolved.role}</Badge> : null}
                </div>
                <div className="truncate font-mono text-[10px] text-muted-foreground">{id}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <NewEntityWizardDialog
        open={creating}
        project={project}
        initialCollection="materials"
        onOpenChange={setCreating}
      />
    </div>
  );
}
