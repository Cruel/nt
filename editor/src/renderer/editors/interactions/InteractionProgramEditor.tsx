import { GameplayCommandListEditor } from '@/components/gameplay-commands/GameplayCommandEditor';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import type { InteractionProgram } from '../../../shared/project-schema/authoring-interaction-programs';
export { defaultInteractionProgram } from '../../../shared/project-schema/authoring-interaction-programs';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';

export type AuthoringEditorProject = NonNullable<ReturnType<typeof authoringProjectFromDocument>>;
export const authoringProjectFromDocument = (value: unknown) =>
  isAuthoringProject(value) ? value : null;
export const typedRef = <Collection extends string>(collection: Collection, id: string) => ({
  $ref: { collection, id },
});
export const nextNestedId = (ids: Iterable<string>, stem: string) => {
  const used = new Set(ids);
  for (let index = 1; index < 1000; index += 1) {
    const id = index === 1 ? stem : `${stem}-${index}`;
    if (!used.has(id)) return id;
  }
  return `${stem}-new`;
};

export function InteractionProgramEditor({
  value,
  project,
  onChange,
  interactionSlots = [],
}: {
  value: InteractionProgram;
  project: AuthoringEditorProject;
  onChange: (next: InteractionProgram) => void;
  interactionSlots?: readonly string[];
}) {
  const completion =
    value.completion.kind === 'end' || value.completion.kind === 'return'
      ? value.completion.kind
      : `${value.completion.kind}:${value.completion.id}`;
  return (
    <div className="space-y-3 rounded border p-3">
      <GameplayCommandListEditor
        value={value.instructions}
        project={project}
        policy={{ interactionSlots, currentRoom: true, playerInventory: true }}
        onChange={(instructions) => onChange({ ...value, instructions })}
      />
      <div className="grid gap-2 md:grid-cols-2">
        <div>
          <Label>Completion</Label>
          <Select
            value={completion}
            onValueChange={(next) => {
              const [kind, id] = String(next).split(':');
              if (kind === 'end' || kind === 'return') onChange({ ...value, completion: { kind } });
              else if (id && (kind === 'room' || kind === 'scene' || kind === 'dialogue'))
                onChange({ ...value, completion: { kind, id } });
            }}
          >
            <SelectItem value="return">Return</SelectItem>
            <SelectItem value="end">End</SelectItem>
            {Object.entries(project.rooms).map(([id, record]) => (
              <SelectItem key={`room:${id}`} value={`room:${id}`}>
                Room: {record.label}
              </SelectItem>
            ))}
            {Object.entries(project.scenes).map(([id, record]) => (
              <SelectItem key={`scene:${id}`} value={`scene:${id}`}>
                Scene: {record.label}
              </SelectItem>
            ))}
            {Object.entries(project.dialogues).map(([id, record]) => (
              <SelectItem key={`dialogue:${id}`} value={`dialogue:${id}`}>
                Dialogue: {record.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Successful outcome</Label>
          <Select
            value={value.outcome}
            onValueChange={(outcome) =>
              onChange({ ...value, outcome: outcome as InteractionProgram['outcome'] })
            }
          >
            <SelectItem value="handled">Handled</SelectItem>
            <SelectItem value="unhandled">Unhandled</SelectItem>
          </Select>
        </div>
      </div>
    </div>
  );
}
