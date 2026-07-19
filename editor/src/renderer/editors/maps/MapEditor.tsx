import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import { parseMapData } from '../../../shared/project-schema/authoring-maps';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';
import {
  authoringProjectFromDocument,
  nextNestedId,
  typedRef,
  type AuthoringEditorProject,
} from '@/editors/interactions/InteractionProgramEditor';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';

export function MapEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const project = authoringProjectFromDocument(document);
  const id = tab.resource?.entityId;
  const record = id && project ? project.maps[id] : null;
  const data = parseMapData(record?.data);
  if (!project || !id || !record || !data)
    return <div className="p-4 text-sm text-muted-foreground">Map record not found.</div>;
  const commit = (next: typeof data) =>
    useCommandStore.getState().executeCommand({
      type: 'map.replaceData',
      label: 'Update map',
      payload: { mapId: id, data: next },
      originSaveUnitId: recordSaveUnitId('maps', id),
      persistencePolicy: 'manual-save',
    });
  return (
    <div className="h-full overflow-auto bg-background p-4">
      <div className="mb-4 flex gap-2">
        <h2 className="text-lg font-semibold">{record.label}</h2>
        <Badge variant="outline">{id}</Badge>
      </div>
      <MapForm data={data} project={project} onChange={commit} />
    </div>
  );
}

function MapForm({
  data,
  project,
  onChange,
}: {
  data: NonNullable<ReturnType<typeof parseMapData>>;
  project: AuthoringEditorProject;
  onChange: (next: NonNullable<ReturnType<typeof parseMapData>>) => void;
}) {
  const addLocation = () => {
    const roomId = Object.keys(project.rooms).find(
      (id) => !data.locations.some((location) => location.room.$ref.id === id),
    );
    if (!roomId) return;
    onChange({
      ...data,
      locations: [
        ...data.locations,
        {
          id: nextNestedId(
            data.locations.map((location) => location.id),
            'location',
          ),
          room: typedRef('rooms', roomId),
          position: { x: 0, y: 0 },
          shape: { kind: 'point' },
          label: null,
        },
      ],
    });
  };
  const exitOptions = data.locations.flatMap((source) =>
    (parseRoomData(project.rooms[source.room.$ref.id]?.data)?.exits ?? []).map((exit) => ({
      source,
      exit,
    })),
  );
  const addConnection = () => {
    const option = exitOptions[0];
    if (!option) return;
    const target = data.locations.find(
      (location) => location.room.$ref.id === option.exit.target.$ref.id,
    );
    if (!target) return;
    onChange({
      ...data,
      connections: [
        ...data.connections,
        {
          id: nextNestedId(
            data.connections.map((connection) => connection.id),
            'connection',
          ),
          exit: { room: option.source.room.$ref.id, exit: option.exit.id },
          sourceLocation: option.source.id,
          targetLocation: target.id,
        },
      ],
    });
  };
  return (
    <div className="space-y-4">
      <section className="grid gap-3 rounded border p-3 md:grid-cols-3">
        <div>
          <Label>Title</Label>
          <Input
            value={
              data.presentation.title?.source.kind === 'inline'
                ? data.presentation.title.source.text
                : ''
            }
            onChange={(event) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  title: event.currentTarget.value
                    ? {
                        source: { kind: 'inline', text: event.currentTarget.value },
                        markup: 'plain',
                      }
                    : null,
                },
              })
            }
          />
        </div>
        <div>
          <Label>Background asset</Label>
          <Select
            value={data.presentation.background?.$ref.id ?? 'none'}
            onValueChange={(id) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  background: id === 'none' ? null : typedRef('assets', String(id)),
                },
              })
            }
          >
            <SelectItem value="none">None</SelectItem>
            {Object.entries(project.assets).map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Layout</Label>
          <Select
            value={data.presentation.layout?.$ref.id ?? 'none'}
            onValueChange={(id) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  layout: id === 'none' ? null : typedRef('layouts', String(id)),
                },
              })
            }
          >
            <SelectItem value="none">None</SelectItem>
            {Object.entries(project.layouts).map(([id, record]) => (
              <SelectItem value={id} key={id}>
                {record.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Initial mode</Label>
          <Select
            value={data.presentation.initialMode}
            onValueChange={(initialMode) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  initialMode: initialMode as typeof data.presentation.initialMode,
                },
              })
            }
          >
            <SelectItem value="full-map">Full map</SelectItem>
            <SelectItem value="minimap">Minimap</SelectItem>
          </Select>
        </div>
      </section>
      <section className="space-y-3">
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!Object.keys(project.rooms).length}
          onClick={addLocation}
        >
          Add room location
        </Button>
        {data.locations.map((location, index) => (
          <div className="grid gap-2 rounded border p-3 md:grid-cols-4" key={location.id}>
            <Input
              value={location.id}
              onChange={(event) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index ? { ...current, id: event.currentTarget.value } : current,
                  ),
                })
              }
            />
            <Select
              value={location.room.$ref.id}
              onValueChange={(roomId) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index
                      ? { ...current, room: typedRef('rooms', String(roomId)) }
                      : current,
                  ),
                })
              }
            >
              {Object.entries(project.rooms).map(([roomId, room]) => (
                <SelectItem key={roomId} value={roomId}>
                  {room.label}
                </SelectItem>
              ))}
            </Select>
            <Input
              placeholder="Label"
              value={location.label?.source.kind === 'inline' ? location.label.source.text : ''}
              onChange={(event) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index
                      ? {
                          ...current,
                          label: event.currentTarget.value
                            ? {
                                source: { kind: 'inline', text: event.currentTarget.value },
                                markup: 'plain',
                              }
                            : null,
                        }
                      : current,
                  ),
                })
              }
            />
            <Select
              value={location.shape.kind}
              onValueChange={(kind) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index
                      ? {
                          ...current,
                          shape:
                            kind === 'circle'
                              ? { kind, radius: 1 }
                              : kind === 'rect'
                                ? { kind, width: 1, height: 1 }
                                : { kind: 'point' },
                        }
                      : current,
                  ),
                })
              }
            >
              <SelectItem value="point">Point</SelectItem>
              <SelectItem value="circle">Circle</SelectItem>
              <SelectItem value="rect">Rectangle</SelectItem>
            </Select>
            <Input
              value={String(location.position.x)}
              onChange={(event) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index
                      ? {
                          ...current,
                          position: {
                            ...current.position,
                            x: Number(event.currentTarget.value) || 0,
                          },
                        }
                      : current,
                  ),
                })
              }
            />
            <Input
              value={String(location.position.y)}
              onChange={(event) =>
                onChange({
                  ...data,
                  locations: data.locations.map((current, item) =>
                    item === index
                      ? {
                          ...current,
                          position: {
                            ...current.position,
                            y: Number(event.currentTarget.value) || 0,
                          },
                        }
                      : current,
                  ),
                })
              }
            />
            {location.shape.kind === 'circle' && (
              <Input
                value={String(location.shape.radius)}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, item) =>
                      item === index && current.shape.kind === 'circle'
                        ? {
                            ...current,
                            shape: {
                              ...current.shape,
                              radius: Number(event.currentTarget.value) || 1,
                            },
                          }
                        : current,
                    ),
                  })
                }
              />
            )}
            {location.shape.kind === 'rect' && (
              <>
                <Input
                  value={String(location.shape.width)}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      locations: data.locations.map((current, item) =>
                        item === index && current.shape.kind === 'rect'
                          ? {
                              ...current,
                              shape: {
                                ...current.shape,
                                width: Number(event.currentTarget.value) || 1,
                              },
                            }
                          : current,
                      ),
                    })
                  }
                />
                <Input
                  value={String(location.shape.height)}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      locations: data.locations.map((current, item) =>
                        item === index && current.shape.kind === 'rect'
                          ? {
                              ...current,
                              shape: {
                                ...current.shape,
                                height: Number(event.currentTarget.value) || 1,
                              },
                            }
                          : current,
                      ),
                    })
                  }
                />
              </>
            )}
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...data,
                  locations: data.locations.filter((_, item) => item !== index),
                  connections: data.connections.filter(
                    (connection) =>
                      connection.sourceLocation !== location.id &&
                      connection.targetLocation !== location.id,
                  ),
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={
            !exitOptions.some(({ exit }) =>
              data.locations.some((location) => location.room.$ref.id === exit.target.$ref.id),
            )
          }
          onClick={addConnection}
        >
          Add exit connection
        </Button>
        {data.connections.map((connection, index) => (
          <div className="grid gap-2 rounded border p-3 md:grid-cols-4" key={connection.id}>
            <Input
              value={connection.id}
              onChange={(event) =>
                onChange({
                  ...data,
                  connections: data.connections.map((current, item) =>
                    item === index ? { ...current, id: event.currentTarget.value } : current,
                  ),
                })
              }
            />
            <Select
              value={`${connection.exit.room}:${connection.exit.exit}`}
              onValueChange={(value) => {
                const [room, exit] = String(value).split(':');
                const source = data.locations.find((location) => location.room.$ref.id === room);
                const targetRoom = parseRoomData(project.rooms[room]?.data)?.exits.find(
                  (candidate) => candidate.id === exit,
                )?.target.$ref.id;
                const target = data.locations.find(
                  (location) => location.room.$ref.id === targetRoom,
                );
                if (source && target)
                  onChange({
                    ...data,
                    connections: data.connections.map((current, item) =>
                      item === index
                        ? {
                            ...current,
                            exit: { room, exit },
                            sourceLocation: source.id,
                            targetLocation: target.id,
                          }
                        : current,
                    ),
                  });
              }}
            >
              {exitOptions.map(({ source, exit }) => (
                <SelectItem
                  key={`${source.id}:${exit.id}`}
                  value={`${source.room.$ref.id}:${exit.id}`}
                >
                  {source.id}: {exit.label}
                </SelectItem>
              ))}
            </Select>
            <Select
              value={connection.sourceLocation}
              onValueChange={(id) =>
                onChange({
                  ...data,
                  connections: data.connections.map((current, item) =>
                    item === index ? { ...current, sourceLocation: String(id) } : current,
                  ),
                })
              }
            >
              {data.locations.map((location) => (
                <SelectItem value={location.id} key={location.id}>
                  {location.id}
                </SelectItem>
              ))}
            </Select>
            <Select
              value={connection.targetLocation}
              onValueChange={(id) =>
                onChange({
                  ...data,
                  connections: data.connections.map((current, item) =>
                    item === index ? { ...current, targetLocation: String(id) } : current,
                  ),
                })
              }
            >
              {data.locations.map((location) => (
                <SelectItem value={location.id} key={location.id}>
                  {location.id}
                </SelectItem>
              ))}
            </Select>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                onChange({
                  ...data,
                  connections: data.connections.filter((_, item) => item !== index),
                })
              }
            >
              Delete
            </Button>
          </div>
        ))}
      </section>
    </div>
  );
}
