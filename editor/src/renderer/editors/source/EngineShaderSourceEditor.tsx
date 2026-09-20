import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { SourceEditor } from '@/components/source/SourceEditor';
import { useProjectSourceStore } from '@/project/project-source-store';
import { useProjectStore } from '@/project/project-store';
import { useWorkbenchStore } from '@/workbench/workbench-store';
import { buildProjectSourceTab, type WorkbenchEditorProps } from '@/workbench/editor-registry';
import { builtInMaterialShaderSource } from '../../../shared/project-schema/authoring-material-preset-sources';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { resolveMaterialData } from '../../../shared/project-schema/authoring-materials';

export function EngineShaderSourceEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const sourceId = tab.resource?.sourceId ?? null;
  const materialId = tab.resource?.collection === 'materials' ? tab.resource.entityId : undefined;
  const document = useProjectStore((state) => state.document);
  const project = isAuthoringProject(document) ? document : null;
  const mutate = useProjectSourceStore((state) => state.mutate);
  const openTab = useWorkbenchStore((state) => state.openTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = sourceId ? builtInMaterialShaderSource(sourceId) : null;
  const stage = useMemo(() => {
    if (!project || !materialId || !sourceId) return null;
    const effective = resolveMaterialData(project, materialId).data;
    if (!effective) return null;
    if (effective.vertexSource === sourceId) return 'vertex' as const;
    if (effective.fragmentSource === sourceId) return 'fragment' as const;
    if (effective.varyingDefinition === sourceId) return 'varying' as const;
    return null;
  }, [materialId, project, sourceId]);

  if (!sourceId || text === null)
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t('materialEditor.builtInSourceUnavailable')}
      </div>
    );

  async function customize() {
    if (!materialId || !stage) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        kind: 'material-shader-copy',
        materialId,
        stage,
        sourceIdentity: sourceId!,
      });
      if (!result.success || !result.createdSourceIds?.[0]) {
        setError(result.error ?? t('materialEditor.customizeFailed'));
        return;
      }
      const createdId = result.createdSourceIds[0];
      const created = useProjectSourceStore
        .getState()
        .files.find((candidate) => candidate.id === createdId);
      if (created) openTab(buildProjectSourceTab(created));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {sourceId}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t('materialEditor.builtInReadOnly')}
        </span>
        {materialId && stage ? (
          <Button size="sm" className="h-7" disabled={busy} onClick={() => void customize()}>
            {t('materialEditor.customizeShader')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <SourceEditor value={text} readOnly language="shader" className="min-h-0 flex-1" />
    </div>
  );
}
