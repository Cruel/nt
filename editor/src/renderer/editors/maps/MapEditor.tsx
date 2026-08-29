import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RecursiveConditionEditor } from '@/components/conditions/ConditionEditor';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { useProjectStore } from '@/project/project-store';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  authoringProjectFromDocument,
  nextNestedId,
  typedRef,
  type AuthoringEditorProject,
} from '@/editors/interactions/InteractionProgramEditor';
import type { Condition } from '../../../shared/project-schema/authoring-flow';
import { parseMapData } from '../../../shared/project-schema/authoring-maps';
import { parseRoomData } from '../../../shared/project-schema/authoring-rooms';

const defaultRegion = () => ({
  points: [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.6, y: 0.6 },
    { x: 0.4, y: 0.6 },
  ],
});

const clampNormalized = (value: string) => Math.max(0, Math.min(1, Number(value) || 0));

function ConditionEditor({
  value,
  project,
  onChange,
}: {
  value: Condition;
  project: AuthoringEditorProject;
  onChange: (next: Condition) => void;
}) {
  return <RecursiveConditionEditor value={value} project={project} onChange={onChange} />;
}

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
  const availableRooms = Object.keys(project.rooms).filter(
    (roomId) => !data.locations.some((location) => location.room.$ref.id === roomId),
  );
  const exitOptions = data.locations.flatMap((source) =>
    (parseRoomData(project.rooms[source.room.$ref.id]?.data)?.exits ?? [])
      .filter((exit) =>
        data.locations.some((location) => location.room.$ref.id === exit.target.$ref.id),
      )
      .map((exit) => ({ source, exit })),
  );

  const addLocation = () => {
    const roomId = availableRooms[0];
    if (!roomId) return;
    const order = data.locations.length;
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
          regions: [defaultRegion()],
          label: null,
          icon: null,
          style: null,
          labelAnchor: null,
          connectionAnchor: null,
          visibility: { kind: 'always' },
          pickOrder: order,
          logicalOrder: order,
        },
      ],
    });
  };

  const addConnection = () => {
    const option = exitOptions.find(
      ({ source, exit }) =>
        !data.connections.some((connection) =>
          connection.exits.some(
            (reference) => reference.room === source.room.$ref.id && reference.exit === exit.id,
          ),
        ),
    );
    if (!option) return;
    onChange({
      ...data,
      connections: [
        ...data.connections,
        {
          id: nextNestedId(
            data.connections.map((connection) => connection.id),
            'connection',
          ),
          exits: [{ room: option.source.room.$ref.id, exit: option.exit.id }],
          label: null,
          icon: null,
          style: null,
          visibility: { kind: 'always' },
          logicalOrder: data.connections.length,
          path: [],
          hitRegions: [],
        },
      ],
    });
  };

  return (
    <div className="space-y-5">
      <section className="grid gap-3 rounded border p-3 md:grid-cols-4">
        <div className="md:col-span-2">
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
            onValueChange={(assetId) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  background: assetId === 'none' ? null : typedRef('assets', String(assetId)),
                },
              })
            }
          >
            <SelectItem value="none">None</SelectItem>
            {Object.entries(project.assets).map(([assetId, asset]) => (
              <SelectItem value={assetId} key={assetId}>
                {asset.label}
              </SelectItem>
            ))}
          </Select>
        </div>
        <div>
          <Label>Default Layout</Label>
          <Select
            value={data.presentation.layout?.$ref.id ?? 'none'}
            onValueChange={(layoutId) =>
              onChange({
                ...data,
                presentation: {
                  ...data.presentation,
                  layout: layoutId === 'none' ? null : typedRef('layouts', String(layoutId)),
                },
              })
            }
          >
            <SelectItem value="none">None</SelectItem>
            {Object.entries(project.layouts).map(([layoutId, layout]) => (
              <SelectItem value={layoutId} key={layoutId}>
                {layout.label}
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
            <SelectItem value="minimap">Minimap</SelectItem>
            <SelectItem value="full-map">Full map</SelectItem>
          </Select>
        </div>
      </section>

      <MapGeometryPreview data={data} />

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">Map Locations</h3>
            <p className="text-xs text-muted-foreground">
              Each Room appears once. Regions use normalized 0–1 coordinates and may be
              disconnected.
            </p>
          </div>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!availableRooms.length}
            onClick={addLocation}
          >
            Add Room Location
          </Button>
        </div>
        {data.locations.map((location, locationIndex) => (
          <div className="space-y-3 rounded border p-3" key={location.id}>
            <div className="grid gap-2 md:grid-cols-5">
              <Input
                aria-label="Location ID"
                value={location.id}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, id: event.currentTarget.value }
                        : current,
                    ),
                  })
                }
              />
              <Select
                value={location.room.$ref.id}
                onValueChange={(roomId) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, room: typedRef('rooms', String(roomId)) }
                        : current,
                    ),
                  })
                }
              >
                {Object.entries(project.rooms)
                  .filter(
                    ([roomId]) =>
                      roomId === location.room.$ref.id ||
                      !data.locations.some((candidate) => candidate.room.$ref.id === roomId),
                  )
                  .map(([roomId, room]) => (
                    <SelectItem key={roomId} value={roomId}>
                      {room.label}
                    </SelectItem>
                  ))}
              </Select>
              <Input
                aria-label="Location label"
                placeholder="Map-specific label"
                value={location.label?.source.kind === 'inline' ? location.label.source.text : ''}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
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
              <Input
                aria-label="Pick order"
                type="number"
                value={location.pickOrder}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, pickOrder: Number(event.currentTarget.value) || 0 }
                        : current,
                    ),
                  })
                }
              />
              <Input
                aria-label="Logical order"
                type="number"
                value={location.logicalOrder}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, logicalOrder: Number(event.currentTarget.value) || 0 }
                        : current,
                    ),
                  })
                }
              />
            </div>

            <div className="grid gap-2 md:grid-cols-4">
              <Input
                aria-label="Location style"
                placeholder="Style ID"
                value={location.style ?? ''}
                onChange={(event) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, style: event.currentTarget.value || null }
                        : current,
                    ),
                  })
                }
              />
              <Select
                value={location.icon?.$ref.id ?? 'none'}
                onValueChange={(assetId) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? {
                            ...current,
                            icon: assetId === 'none' ? null : typedRef('assets', String(assetId)),
                          }
                        : current,
                    ),
                  })
                }
              >
                <SelectItem value="none">No icon</SelectItem>
                {Object.entries(project.assets).map(([assetId, asset]) => (
                  <SelectItem value={assetId} key={assetId}>
                    {asset.label}
                  </SelectItem>
                ))}
              </Select>
              <div className="grid grid-cols-2 gap-1">
                <Input
                  aria-label="Label anchor x"
                  placeholder="Label X"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={location.labelAnchor?.x ?? ''}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    onChange({
                      ...data,
                      locations: data.locations.map((current, index) =>
                        index === locationIndex
                          ? {
                              ...current,
                              labelAnchor:
                                text === ''
                                  ? null
                                  : {
                                      x: clampNormalized(text),
                                      y: current.labelAnchor?.y ?? 0.5,
                                    },
                            }
                          : current,
                      ),
                    });
                  }}
                />
                <Input
                  aria-label="Label anchor y"
                  placeholder="Label Y"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={location.labelAnchor?.y ?? ''}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    onChange({
                      ...data,
                      locations: data.locations.map((current, index) =>
                        index === locationIndex
                          ? {
                              ...current,
                              labelAnchor:
                                text === ''
                                  ? null
                                  : {
                                      x: current.labelAnchor?.x ?? 0.5,
                                      y: clampNormalized(text),
                                    },
                            }
                          : current,
                      ),
                    });
                  }}
                />
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Input
                  aria-label="Connection anchor x"
                  placeholder="Route X"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={location.connectionAnchor?.x ?? ''}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    onChange({
                      ...data,
                      locations: data.locations.map((current, index) =>
                        index === locationIndex
                          ? {
                              ...current,
                              connectionAnchor:
                                text === ''
                                  ? null
                                  : {
                                      x: clampNormalized(text),
                                      y: current.connectionAnchor?.y ?? 0.5,
                                    },
                            }
                          : current,
                      ),
                    });
                  }}
                />
                <Input
                  aria-label="Connection anchor y"
                  placeholder="Route Y"
                  type="number"
                  min={0}
                  max={1}
                  step="0.01"
                  value={location.connectionAnchor?.y ?? ''}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    onChange({
                      ...data,
                      locations: data.locations.map((current, index) =>
                        index === locationIndex
                          ? {
                              ...current,
                              connectionAnchor:
                                text === ''
                                  ? null
                                  : {
                                      x: current.connectionAnchor?.x ?? 0.5,
                                      y: clampNormalized(text),
                                    },
                            }
                          : current,
                      ),
                    });
                  }}
                />
              </div>
            </div>
            <div>
              <Label>Visibility</Label>
              <ConditionEditor
                value={location.visibility}
                project={project}
                onChange={(visibility) =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex ? { ...current, visibility } : current,
                    ),
                  })
                }
              />
            </div>

            <div className="space-y-2">
              {location.regions.map((region, regionIndex) => (
                <div
                  className="rounded bg-muted/30 p-2"
                  key={`${location.id}-region-${regionIndex}`}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium">Region {regionIndex + 1}</span>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        onChange({
                          ...data,
                          locations: data.locations.map((current, index) =>
                            index === locationIndex
                              ? {
                                  ...current,
                                  regions: current.regions.filter(
                                    (_, item) => item !== regionIndex,
                                  ),
                                }
                              : current,
                          ),
                        })
                      }
                    >
                      Delete Region
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {region.points.map((point, pointIndex) => (
                      <div className="grid grid-cols-2 gap-1" key={pointIndex}>
                        <Input
                          aria-label={`Region ${regionIndex + 1} point ${pointIndex + 1} x`}
                          type="number"
                          min={0}
                          max={1}
                          step="0.01"
                          value={point.x}
                          onChange={(event) =>
                            onChange({
                              ...data,
                              locations: data.locations.map((current, index) =>
                                index === locationIndex
                                  ? {
                                      ...current,
                                      regions: current.regions.map((currentRegion, item) =>
                                        item === regionIndex
                                          ? {
                                              ...currentRegion,
                                              points: currentRegion.points.map(
                                                (currentPoint, vertex) =>
                                                  vertex === pointIndex
                                                    ? {
                                                        ...currentPoint,
                                                        x: clampNormalized(
                                                          event.currentTarget.value,
                                                        ),
                                                      }
                                                    : currentPoint,
                                              ),
                                            }
                                          : currentRegion,
                                      ),
                                    }
                                  : current,
                              ),
                            })
                          }
                        />
                        <Input
                          aria-label={`Region ${regionIndex + 1} point ${pointIndex + 1} y`}
                          type="number"
                          min={0}
                          max={1}
                          step="0.01"
                          value={point.y}
                          onChange={(event) =>
                            onChange({
                              ...data,
                              locations: data.locations.map((current, index) =>
                                index === locationIndex
                                  ? {
                                      ...current,
                                      regions: current.regions.map((currentRegion, item) =>
                                        item === regionIndex
                                          ? {
                                              ...currentRegion,
                                              points: currentRegion.points.map(
                                                (currentPoint, vertex) =>
                                                  vertex === pointIndex
                                                    ? {
                                                        ...currentPoint,
                                                        y: clampNormalized(
                                                          event.currentTarget.value,
                                                        ),
                                                      }
                                                    : currentPoint,
                                              ),
                                            }
                                          : currentRegion,
                                      ),
                                    }
                                  : current,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                  <Button
                    className="mt-2"
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onChange({
                        ...data,
                        locations: data.locations.map((current, index) =>
                          index === locationIndex
                            ? {
                                ...current,
                                regions: current.regions.map((currentRegion, item) =>
                                  item === regionIndex
                                    ? {
                                        ...currentRegion,
                                        points: [
                                          ...currentRegion.points,
                                          currentRegion.points.at(-1) ?? { x: 0.5, y: 0.5 },
                                        ],
                                      }
                                    : currentRegion,
                                ),
                              }
                            : current,
                        ),
                      })
                    }
                  >
                    Add Vertex
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                type="button"
                variant="outline"
                onClick={() =>
                  onChange({
                    ...data,
                    locations: data.locations.map((current, index) =>
                      index === locationIndex
                        ? { ...current, regions: [...current.regions, defaultRegion()] }
                        : current,
                    ),
                  })
                }
              >
                Add Region
              </Button>
            </div>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => {
                const roomId = location.room.$ref.id;
                onChange({
                  ...data,
                  locations: data.locations.filter((_, item) => item !== locationIndex),
                  connections: data.connections.filter(
                    (connection) =>
                      !connection.exits.some((reference) => reference.room === roomId),
                  ),
                });
              }}
            >
              Delete Location
            </Button>
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium">Connections</h3>
            <p className="text-xs text-muted-foreground">
              Endpoints are derived from authoritative Room Exits. Add a reciprocal Exit only when
              both directions represent one route.
            </p>
          </div>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={!exitOptions.length}
            onClick={addConnection}
          >
            Add Exit Connection
          </Button>
        </div>
        {data.connections.map((connection, connectionIndex) => {
          const first = connection.exits[0];
          const firstRoom = project.rooms[first?.room ?? ''];
          const firstExit = parseRoomData(firstRoom?.data)?.exits.find(
            (exit) => exit.id === first?.exit,
          );
          const reciprocalOptions = firstExit
            ? (parseRoomData(project.rooms[firstExit.target.$ref.id]?.data)?.exits ?? []).filter(
                (exit) => exit.target.$ref.id === first.room,
              )
            : [];
          return (
            <div className="space-y-3 rounded border p-3" key={connection.id}>
              <div className="grid gap-2 md:grid-cols-4">
                <Input
                  aria-label="Connection ID"
                  value={connection.id}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
                          ? { ...current, id: event.currentTarget.value }
                          : current,
                      ),
                    })
                  }
                />
                <Select
                  value={first ? `${first.room}:${first.exit}` : ''}
                  onValueChange={(value) => {
                    const [room, exit] = String(value).split(':');
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
                          ? { ...current, exits: [{ room, exit }] }
                          : current,
                      ),
                    });
                  }}
                >
                  {exitOptions.map(({ source, exit }) => (
                    <SelectItem
                      key={`${source.room.$ref.id}:${exit.id}`}
                      value={`${source.room.$ref.id}:${exit.id}`}
                    >
                      {project.rooms[source.room.$ref.id]?.label ?? source.room.$ref.id} →{' '}
                      {project.rooms[exit.target.$ref.id]?.label ?? exit.target.$ref.id}
                    </SelectItem>
                  ))}
                </Select>
                <Select
                  value={connection.exits[1]?.exit ?? 'none'}
                  onValueChange={(exitId) => {
                    const targetRoom = firstExit?.target.$ref.id;
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index !== connectionIndex || !first
                          ? current
                          : {
                              ...current,
                              exits:
                                exitId === 'none' || !targetRoom
                                  ? [first]
                                  : [first, { room: targetRoom, exit: String(exitId) }],
                            },
                      ),
                    });
                  }}
                >
                  <SelectItem value="none">One-way</SelectItem>
                  {reciprocalOptions.map((exit) => (
                    <SelectItem key={exit.id} value={exit.id}>
                      Reciprocal: {exit.label}
                    </SelectItem>
                  ))}
                </Select>
                <Input
                  aria-label="Connection logical order"
                  type="number"
                  value={connection.logicalOrder}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
                          ? { ...current, logicalOrder: Number(event.currentTarget.value) || 0 }
                          : current,
                      ),
                    })
                  }
                />
              </div>

              <div className="grid gap-2 md:grid-cols-3">
                <Input
                  aria-label="Connection label"
                  placeholder="Map-specific label"
                  value={
                    connection.label?.source.kind === 'inline' ? connection.label.source.text : ''
                  }
                  onChange={(event) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
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
                <Input
                  aria-label="Connection style"
                  placeholder="Style ID"
                  value={connection.style ?? ''}
                  onChange={(event) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
                          ? { ...current, style: event.currentTarget.value || null }
                          : current,
                      ),
                    })
                  }
                />
                <Select
                  value={connection.icon?.$ref.id ?? 'none'}
                  onValueChange={(assetId) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex
                          ? {
                              ...current,
                              icon: assetId === 'none' ? null : typedRef('assets', String(assetId)),
                            }
                          : current,
                      ),
                    })
                  }
                >
                  <SelectItem value="none">No icon</SelectItem>
                  {Object.entries(project.assets).map(([assetId, asset]) => (
                    <SelectItem value={assetId} key={assetId}>
                      {asset.label}
                    </SelectItem>
                  ))}
                </Select>
              </div>

              <div>
                <Label>Visibility</Label>
                <ConditionEditor
                  value={connection.visibility}
                  project={project}
                  onChange={(visibility) =>
                    onChange({
                      ...data,
                      connections: data.connections.map((current, index) =>
                        index === connectionIndex ? { ...current, visibility } : current,
                      ),
                    })
                  }
                />
              </div>

              <div className="space-y-2 rounded bg-muted/20 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Visual path</span>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onChange({
                        ...data,
                        connections: data.connections.map((current, index) =>
                          index === connectionIndex
                            ? {
                                ...current,
                                path: [...current.path, current.path.at(-1) ?? { x: 0.5, y: 0.5 }],
                              }
                            : current,
                        ),
                      })
                    }
                  >
                    Add Path Point
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {connection.path.map((point, pointIndex) => (
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-1" key={pointIndex}>
                      <Input
                        aria-label={`Connection path point ${pointIndex + 1} x`}
                        type="number"
                        min={0}
                        max={1}
                        step="0.01"
                        value={point.x}
                        onChange={(event) =>
                          onChange({
                            ...data,
                            connections: data.connections.map((current, index) =>
                              index === connectionIndex
                                ? {
                                    ...current,
                                    path: current.path.map((candidate, item) =>
                                      item === pointIndex
                                        ? {
                                            ...candidate,
                                            x: clampNormalized(event.currentTarget.value),
                                          }
                                        : candidate,
                                    ),
                                  }
                                : current,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label={`Connection path point ${pointIndex + 1} y`}
                        type="number"
                        min={0}
                        max={1}
                        step="0.01"
                        value={point.y}
                        onChange={(event) =>
                          onChange({
                            ...data,
                            connections: data.connections.map((current, index) =>
                              index === connectionIndex
                                ? {
                                    ...current,
                                    path: current.path.map((candidate, item) =>
                                      item === pointIndex
                                        ? {
                                            ...candidate,
                                            y: clampNormalized(event.currentTarget.value),
                                          }
                                        : candidate,
                                    ),
                                  }
                                : current,
                            ),
                          })
                        }
                      />
                      <Button
                        aria-label={`Delete connection path point ${pointIndex + 1}`}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          onChange({
                            ...data,
                            connections: data.connections.map((current, index) =>
                              index === connectionIndex
                                ? {
                                    ...current,
                                    path: current.path.filter((_, item) => item !== pointIndex),
                                  }
                                : current,
                            ),
                          })
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2 rounded bg-muted/20 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Pointer hit regions</span>
                  <Button
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      onChange({
                        ...data,
                        connections: data.connections.map((current, index) =>
                          index === connectionIndex
                            ? { ...current, hitRegions: [...current.hitRegions, defaultRegion()] }
                            : current,
                        ),
                      })
                    }
                  >
                    Add Hit Region
                  </Button>
                </div>
                {connection.hitRegions.map((region, regionIndex) => (
                  <div className="space-y-2 rounded border p-2" key={regionIndex}>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {region.points.map((point, pointIndex) => (
                        <div className="grid grid-cols-2 gap-1" key={pointIndex}>
                          <Input
                            aria-label={`Connection hit region ${regionIndex + 1} point ${pointIndex + 1} x`}
                            type="number"
                            min={0}
                            max={1}
                            step="0.01"
                            value={point.x}
                            onChange={(event) =>
                              onChange({
                                ...data,
                                connections: data.connections.map((current, index) =>
                                  index === connectionIndex
                                    ? {
                                        ...current,
                                        hitRegions: current.hitRegions.map((candidate, item) =>
                                          item === regionIndex
                                            ? {
                                                ...candidate,
                                                points: candidate.points.map(
                                                  (vertex, vertexIndex) =>
                                                    vertexIndex === pointIndex
                                                      ? {
                                                          ...vertex,
                                                          x: clampNormalized(
                                                            event.currentTarget.value,
                                                          ),
                                                        }
                                                      : vertex,
                                                ),
                                              }
                                            : candidate,
                                        ),
                                      }
                                    : current,
                                ),
                              })
                            }
                          />
                          <Input
                            aria-label={`Connection hit region ${regionIndex + 1} point ${pointIndex + 1} y`}
                            type="number"
                            min={0}
                            max={1}
                            step="0.01"
                            value={point.y}
                            onChange={(event) =>
                              onChange({
                                ...data,
                                connections: data.connections.map((current, index) =>
                                  index === connectionIndex
                                    ? {
                                        ...current,
                                        hitRegions: current.hitRegions.map((candidate, item) =>
                                          item === regionIndex
                                            ? {
                                                ...candidate,
                                                points: candidate.points.map(
                                                  (vertex, vertexIndex) =>
                                                    vertexIndex === pointIndex
                                                      ? {
                                                          ...vertex,
                                                          y: clampNormalized(
                                                            event.currentTarget.value,
                                                          ),
                                                        }
                                                      : vertex,
                                                ),
                                              }
                                            : candidate,
                                        ),
                                      }
                                    : current,
                                ),
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={() =>
                          onChange({
                            ...data,
                            connections: data.connections.map((current, index) =>
                              index === connectionIndex
                                ? {
                                    ...current,
                                    hitRegions: current.hitRegions.map((candidate, item) =>
                                      item === regionIndex
                                        ? {
                                            ...candidate,
                                            points: [
                                              ...candidate.points,
                                              candidate.points.at(-1) ?? { x: 0.5, y: 0.5 },
                                            ],
                                          }
                                        : candidate,
                                    ),
                                  }
                                : current,
                            ),
                          })
                        }
                      >
                        Add Vertex
                      </Button>
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          onChange({
                            ...data,
                            connections: data.connections.map((current, index) =>
                              index === connectionIndex
                                ? {
                                    ...current,
                                    hitRegions: current.hitRegions.filter(
                                      (_, item) => item !== regionIndex,
                                    ),
                                  }
                                : current,
                            ),
                          })
                        }
                      >
                        Delete Hit Region
                      </Button>
                    </div>
                  </div>
                ))}
              </div>

              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...data,
                    connections: data.connections.filter((_, item) => item !== connectionIndex),
                  })
                }
              >
                Delete Connection
              </Button>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function MapGeometryPreview({ data }: { data: NonNullable<ReturnType<typeof parseMapData>> }) {
  return (
    <section className="rounded border p-3">
      <div className="mb-2 text-sm font-medium">Geometry Preview</div>
      <svg
        aria-label="Map geometry preview"
        className="aspect-video w-full rounded bg-muted/20"
        role="img"
        viewBox="0 0 1000 562.5"
      >
        {data.connections.flatMap((connection) => [
          ...(connection.path.length > 1
            ? [
                <polyline
                  className="fill-none stroke-foreground/70"
                  key={`${connection.id}-path`}
                  points={connection.path
                    .map((point) => `${point.x * 1000},${point.y * 562.5}`)
                    .join(' ')}
                  strokeWidth="3"
                />,
              ]
            : []),
          ...connection.hitRegions.map((region, regionIndex) => (
            <polygon
              className="fill-muted-foreground/10 stroke-muted-foreground/50"
              key={`${connection.id}-hit-${regionIndex}`}
              points={region.points
                .map((point) => `${point.x * 1000},${point.y * 562.5}`)
                .join(' ')}
              strokeDasharray="6 6"
              strokeWidth="1"
            />
          )),
        ])}
        {[...data.locations]
          .sort((a, b) => a.pickOrder - b.pickOrder || a.id.localeCompare(b.id))
          .flatMap((location) =>
            location.regions.map((region, regionIndex) => (
              <polygon
                className="fill-muted-foreground/15 stroke-muted-foreground"
                key={`${location.id}-${regionIndex}`}
                points={region.points
                  .map((point) => `${point.x * 1000},${point.y * 562.5}`)
                  .join(' ')}
                strokeWidth="2"
              />
            )),
          )}
      </svg>
    </section>
  );
}
