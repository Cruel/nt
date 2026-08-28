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
  const interactable = Object.keys(project.interactables)[0];
  if (interactable)
    return {
      kind: 'exact',
      subject: {
        kind: 'interactable',
        interactable: typedRef('interactables', interactable),
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
  const firstRoom = Object.keys(project.rooms)[0];
  const firstInteractable = Object.keys(project.interactables)[0];
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
        {value.kind === 'item-definition' && (
          <div className="text-sm text-muted-foreground">Retired Item Definition selector</div>
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
                  const id = Object.keys(project.interactables)[0];
                  if (id)
                    onChange({
                      kind: 'exact',
                      subject: { kind, interactable: typedRef('interactables', id) },
                    });
                } else if (firstRoom) {
                  onChange({
                    kind: 'exact',
                    subject: { kind: 'feature', feature: roomFeatureRef(firstRoom, '') },
                  });
                } else if (firstInteractable) {
                  onChange({
                    kind: 'exact',
                    subject: {
                      kind: 'feature',
                      feature: interactableFeatureRef(firstInteractable, ''),
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
                disabled={!Object.keys(project.interactables).length}
              >
                Interactable
              </SelectItem>
              <SelectItem value="feature" disabled={!firstRoom && !firstInteractable}>
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
                      interactable: typedRef('interactables', String(id)),
                    },
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
            {value.subject.kind === 'item-stack' && (
              <div className="text-sm text-muted-foreground">Retired Item Stack subject</div>
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
                    else if (firstInteractable)
                      onChange({
                        kind: 'exact',
                        subject: {
                          kind: 'feature',
                          feature: interactableFeatureRef(
                            firstInteractable,
                            exactFeature.featureId,
                          ),
                        },
                      });
                  }}
                >
                  <SelectItem value="room" disabled={!firstRoom}>
                    Room feature
                  </SelectItem>
                  <SelectItem value="interactable" disabled={!firstInteractable}>
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
                    {Object.entries(project.interactables).map(([id, record]) => (
                      <SelectItem value={id} key={id}>
                        {record.label}
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
