import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  gameplayInstanceKindValues,
  parseArchetypeData,
  resolveArchetypeConfiguration,
} from '../../../shared/project-schema/authoring-archetypes';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';

export function ArchetypeEditor({ tab }: WorkbenchEditorProps) {
  const projectDocument = useProjectStore((state) => state.document);
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const archetypeId = tab.resource?.entityId ?? null;
  const record = project && archetypeId ? project.archetypes[archetypeId] : null;
  const data = parseArchetypeData(record?.data);
  const effective =
    project && archetypeId && data ? resolveArchetypeConfiguration(project, archetypeId) : null;
  const [source, setSource] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const effectiveSource = useMemo(
    () => (effective ? JSON.stringify(effective, null, 2) : ''),
    [effective],
  );

  useEffect(() => {
    setSource(effectiveSource);
    setParseError(null);
  }, [archetypeId, effectiveSource]);

  if (!project || !record || !data || !archetypeId)
    return <div className="p-4 text-sm text-muted-foreground">Archetype record not found.</div>;

  const sameKindBases = Object.entries(project.archetypes)
    .filter(([id, candidate]) => {
      if (id === archetypeId) return false;
      return parseArchetypeData(candidate.data)?.instanceKind === data.instanceKind;
    })
    .sort(([, left], [, right]) => left.label.localeCompare(right.label));

  const execute = (type: string, label: string, payload: unknown) =>
    useCommandStore.getState().executeCommand({
      type,
      label,
      payload,
      originSaveUnitId: recordSaveUnitId('archetypes', archetypeId),
      persistencePolicy: 'manual-save',
    });

  const saveConfiguration = () => {
    try {
      const configuration = JSON.parse(source) as unknown;
      setParseError(null);
      const result = execute('archetype.replaceConfiguration', 'Update Archetype configuration', {
        archetypeId,
        configuration,
      });
      if (result && 'diagnostics' in result) {
        const failure = result.diagnostics?.find((item) => item.severity === 'error');
        if (failure) setParseError(failure.message);
      }
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Configuration must be valid JSON.');
    }
  };

  return (
    <div className="h-full overflow-auto bg-background p-6">
      <div className="mx-auto max-w-4xl space-y-5">
        <div>
          <h2 className="text-lg font-semibold">{record.label}</h2>
          <p className="text-sm text-muted-foreground">
            Archetypes are immutable configuration blueprints. They never become gameplay identities
            and do not own Location or mutable state.
          </p>
        </div>

        <div className="grid gap-4 rounded-md border p-4 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Gameplay Instance kind</Label>
            <Select
              value={data.instanceKind}
              onValueChange={(value) =>
                void execute('archetype.setKind', 'Set Archetype kind', {
                  archetypeId,
                  instanceKind: value,
                })
              }
            >
              {gameplayInstanceKindValues.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kind[0].toUpperCase() + kind.slice(1)}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Base Archetype</Label>
            <Select
              value={data.base?.$ref.id ?? '__none__'}
              onValueChange={(value) =>
                void execute('archetype.setBase', 'Set base Archetype', {
                  archetypeId,
                  baseArchetypeId: value === '__none__' ? null : value,
                })
              }
            >
              <SelectItem value="__none__">None</SelectItem>
              {sameKindBases.map(([id, candidate]) => (
                <SelectItem key={id} value={id}>
                  {candidate.label}
                </SelectItem>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>Effective configuration</Label>
              <p className="text-xs text-muted-foreground">
                Editing this resolved configuration stores only differences from the selected base
                Archetype.
              </p>
            </div>
            <Button type="button" onClick={saveConfiguration}>
              Apply configuration
            </Button>
          </div>
          <textarea
            value={source}
            onChange={(event) => setSource(event.currentTarget.value)}
            className="min-h-[28rem] w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            spellCheck={false}
          />
          {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}
        </div>
      </div>
    </div>
  );
}
