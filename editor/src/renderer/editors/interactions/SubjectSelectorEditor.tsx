import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import {
  interactableFeatureRef,
  roomFeatureRef,
} from '../../../shared/project-schema/authoring-features';
import type { SubjectSelector } from '../../../shared/project-schema/authoring-verbs';
import { typedRef, type AuthoringEditorProject } from './InteractionProgramEditor';

function defaultExactSubject(project: AuthoringEditorProject): SubjectSelector {
  const interactable = Object.keys(project.interactableInstances)[0];
  if (interactable)
    return {
      kind: 'exact',
      subject: {
        kind: 'interactable',
        interactable: { $ref: { registry: 'interactableInstances', id: interactable } },
      },
    };
  const character = Object.keys(project.characters)[0];
  if (character)
    return {
      kind: 'exact',
      subject: { kind: 'character', character: typedRef('characters', character) },
    };
  return { kind: 'any-subject' };
}

export function defaultSubjectSelector(project: AuthoringEditorProject): SubjectSelector {
  return Object.keys(project.interactables).length
    ? { kind: 'family', family: 'interactable' }
    : { kind: 'any-subject' };
}

export function SubjectSelectorEditor({
  value,
  project,
  onChange,
  onDelete,
}: {
  value: SubjectSelector;
  project: AuthoringEditorProject;
  onChange: (next: SubjectSelector) => void;
  onDelete?: () => void;
}) {
  const firstTrait = Object.keys(project.traits)[0];
  const firstInteractableDefinition = Object.keys(project.interactables)[0];
  const firstRoom = Object.keys(project.rooms)[0];
  const firstInteractableInstance = Object.keys(project.interactableInstances)[0];
  const exactFeature =
    value.kind === 'exact' && value.subject.kind === 'feature' ? value.subject.feature : null;

  return (
    <div className="grid gap-2 rounded border p-2 md:grid-cols-[minmax(10rem,0.8fr)_1fr_auto]">
      <Select
        value={value.kind}
        onValueChange={(kind) => {
          if (kind === 'family') onChange({ kind, family: 'interactable' });
          else if (kind === 'trait' && firstTrait)
            onChange({ kind, trait: typedRef('traits', firstTrait) });
          else if (kind === 'interactable-definition' && firstInteractableDefinition)
            onChange({
              kind,
              interactableDefinition: typedRef('interactables', firstInteractableDefinition),
            });
          else if (kind === 'interactable-feature' && firstInteractableDefinition)
            onChange({
              kind,
              interactableDefinition: typedRef('interactables', firstInteractableDefinition),
              featureId:
                project.interactables[firstInteractableDefinition]?.data.kind === 'interactable'
                  ? (project.interactables[firstInteractableDefinition].data.features[0]?.id ?? '')
                  : '',
            });
          else if (kind === 'qualified-pattern')
            onChange({ kind, family: 'interactable', pattern: 'interactable:*' });
          else if (kind === 'exact') onChange(defaultExactSubject(project));
          else onChange({ kind: 'any-subject' });
        }}
      >
        <SelectItem value="any-subject">Any subject</SelectItem>
        <SelectItem value="family">Subject family</SelectItem>
        <SelectItem value="trait" disabled={!firstTrait}>
          Trait
        </SelectItem>
        <SelectItem value="interactable-definition" disabled={!firstInteractableDefinition}>
          Interactable definition
        </SelectItem>
        <SelectItem value="interactable-feature" disabled={!firstInteractableDefinition}>
          Interactable feature
        </SelectItem>
        <SelectItem value="qualified-pattern">Qualified pattern</SelectItem>
        <SelectItem value="exact">Exact subject</SelectItem>
      </Select>
      <div className="grid gap-2 md:grid-cols-2">
        {value.kind === 'family' && (
          <Select
            value={value.family}
            onValueChange={(family) =>
              onChange({ ...value, family: family as typeof value.family })
            }
          >
            <SelectItem value="character">Character</SelectItem>
            <SelectItem value="interactable">Interactable</SelectItem>
            <SelectItem value="feature">Feature</SelectItem>
          </Select>
        )}
        {value.kind === 'trait' && (
          <Select
            value={value.trait.$ref.id}
            onValueChange={(id) =>
              onChange({ kind: 'trait', trait: typedRef('traits', String(id)) })
            }
          >
            {Object.entries(project.traits).map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
        )}
        {value.kind === 'interactable-definition' && (
          <Select
            value={value.interactableDefinition.$ref.id}
            onValueChange={(id) =>
              onChange({
                kind: 'interactable-definition',
                interactableDefinition: typedRef('interactables', String(id)),
              })
            }
          >
            {Object.entries(project.interactables).map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
        )}
        {value.kind === 'interactable-feature' && (
          <>
            <Select
              value={value.interactableDefinition.$ref.id}
              onValueChange={(id) => {
                const definition = project.interactables[String(id)];
                onChange({
                  kind: 'interactable-feature',
                  interactableDefinition: typedRef('interactables', String(id)),
                  featureId:
                    definition?.data.kind === 'interactable'
                      ? (definition.data.features[0]?.id ?? '')
                      : '',
                });
              }}
            >
              {Object.entries(project.interactables).map(([id, record]) => (
                <SelectItem value={id} key={id}>
                  {record.label}
                </SelectItem>
              ))}
            </Select>
            <Input
              value={value.featureId}
              placeholder="feature-id"
              onChange={(event) => onChange({ ...value, featureId: event.currentTarget.value })}
            />
          </>
        )}
        {value.kind === 'qualified-pattern' && (
          <>
            <Select
              value={value.family}
              onValueChange={(family) =>
                onChange({ ...value, family: family as typeof value.family })
              }
            >
              <SelectItem value="character">Character</SelectItem>
              <SelectItem value="interactable">Interactable</SelectItem>
              <SelectItem value="feature">Feature</SelectItem>
            </Select>
            <Input
              value={value.pattern}
              placeholder="namespace:*"
              onChange={(event) => onChange({ ...value, pattern: event.currentTarget.value })}
            />
          </>
        )}
        {value.kind === 'exact' && (
          <>
            <Select
              value={value.subject.kind}
              onValueChange={(kind) => {
                if (kind === 'character') {
                  const id = Object.keys(project.characters)[0];
                  if (id)
                    onChange({
                      kind: 'exact',
                      subject: { kind, character: typedRef('characters', id) },
                    });
                } else if (kind === 'interactable') {
                  const id = Object.keys(project.interactableInstances)[0];
                  if (id)
                    onChange({
                      kind: 'exact',
                      subject: {
                        kind,
                        interactable: { $ref: { registry: 'interactableInstances', id } },
                      },
                    });
                } else if (firstRoom) {
                  onChange({
                    kind: 'exact',
                    subject: { kind: 'feature', feature: roomFeatureRef(firstRoom, '') },
                  });
                } else if (firstInteractableInstance) {
                  onChange({
                    kind: 'exact',
                    subject: {
                      kind: 'feature',
                      feature: interactableFeatureRef(firstInteractableInstance, ''),
                    },
                  });
                }
              }}
            >
              <SelectItem value="character" disabled={!Object.keys(project.characters).length}>
                Character
              </SelectItem>
              <SelectItem
                value="interactable"
                disabled={!Object.keys(project.interactableInstances).length}
              >
                Interactable Instance
              </SelectItem>
              <SelectItem value="feature" disabled={!firstRoom && !firstInteractableInstance}>
                Feature
              </SelectItem>
            </Select>
            {value.subject.kind === 'character' && (
              <Select
                value={value.subject.character.$ref.id}
                onValueChange={(id) =>
                  onChange({
                    kind: 'exact',
                    subject: {
                      kind: 'character',
                      character: typedRef('characters', String(id)),
                    },
                  })
                }
              >
                {Object.entries(project.characters).map(([id, record]) => (
                  <SelectItem value={id} key={id}>
                    {record.label}
                  </SelectItem>
                ))}
              </Select>
            )}
            {value.subject.kind === 'interactable' && (
              <Select
                value={value.subject.interactable.$ref.id}
                onValueChange={(id) =>
                  onChange({
                    kind: 'exact',
                    subject: {
                      kind: 'interactable',
                      interactable: {
                        $ref: { registry: 'interactableInstances', id: String(id) },
                      },
                    },
                  })
                }
              >
                {Object.entries(project.interactableInstances).map(([id, instance]) => (
                  <SelectItem value={id} key={id}>
                    {instance.editorLabel ?? id} (
                    {project.interactables[instance.definition.$ref.id]?.label ??
                      instance.definition.$ref.id}
                    )
                  </SelectItem>
                ))}
              </Select>
            )}
            {exactFeature && (
              <>
                <Select
                  value={exactFeature.ownerKind}
                  onValueChange={(ownerKind) => {
                    if (ownerKind === 'room' && firstRoom)
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: roomFeatureRef(firstRoom, exactFeature.featureId),
                        },
                      });
                    else if (firstInteractableInstance)
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: interactableFeatureRef(
                            firstInteractableInstance,
                            exactFeature.featureId,
                          ),
                        },
                      });
                  }}
                >
                  <SelectItem value="room" disabled={!firstRoom}>
                    Room feature
                  </SelectItem>
                  <SelectItem value="interactable" disabled={!firstInteractableInstance}>
                    Interactable feature
                  </SelectItem>
                </Select>
                {exactFeature.ownerKind === 'room' ? (
                  <Select
                    value={exactFeature.room.$ref.id}
                    onValueChange={(id) =>
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: roomFeatureRef(String(id), exactFeature.featureId),
                        },
                      })
                    }
                  >
                    {Object.entries(project.rooms).map(([id, record]) => (
                      <SelectItem value={id} key={id}>
                        {record.label}
                      </SelectItem>
                    ))}
                  </Select>
                ) : (
                  <Select
                    value={exactFeature.interactable.$ref.id}
                    onValueChange={(id) =>
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: interactableFeatureRef(String(id), exactFeature.featureId),
                        },
                      })
                    }
                  >
                    {Object.entries(project.interactableInstances).map(([id, instance]) => (
                      <SelectItem value={id} key={id}>
                        {instance.editorLabel ?? id} (
                        {project.interactables[instance.definition.$ref.id]?.label ??
                          instance.definition.$ref.id}
                        )
                      </SelectItem>
                    ))}
                  </Select>
                )}
                <div>
                  <Label>Feature ID</Label>
                  <Input
                    value={exactFeature.featureId}
                    onChange={(event) =>
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: { ...exactFeature, featureId: event.currentTarget.value },
                        },
                      })
                    }
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
      {onDelete && (
        <Button type="button" size="sm" variant="ghost" onClick={onDelete}>
          Remove
        </Button>
      )}
    </div>
  );
}
