import { useMemo, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectItem } from '@/components/ui/select';
import { InventoryDeclarationsEditor } from '@/components/inventories/InventoryControls';
import { useCommandStore } from '@/commands/command-store';
import { GameplayArchetypeControls } from '@/components/GameplayArchetypeControls';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import { DerivedPreviewPane } from '@/preview/DerivedPreviewPane';
import { useProjectStore } from '@/project/project-store';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import { resolveGameplayInstanceRecord } from '../../../shared/project-schema/authoring-archetypes';
import {
  characterAssetRef,
  characterIdleKindValues,
  characterMaterialRef,
  defaultCharacterData,
  parseCharacterData,
  presentationClockValues,
  validateCharacterData,
  type CharacterData,
  type CharacterAppearanceData,
  type CharacterExpressionData,
  type CharacterIdleData,
  type CharacterLayerCompositionData,
  type CharacterLayerOverrideData,
  type CharacterPoseData,
  type CharacterPresentationProfileData,
} from '../../../shared/project-schema/authoring-characters';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  buildCharacterPreviewDocumentData,
  characterPreviewRevision,
  resolveCharacterPresentationLayers,
} from '../../../shared/project-schema/character-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import {
  captureScrollViewState,
  restoreScrollViewState,
  useWorkbenchEditorTabState,
  type ScrollViewState,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const CHARACTER_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.character';

interface CharacterEditorTabStatePayload {
  scroll?: ScrollViewState;
}

type CharacterEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof CHARACTER_EDITOR_TAB_STATE_SCHEMA;
  payload?: CharacterEditorTabStatePayload;
};

function isScrollViewState(value: unknown): value is ScrollViewState {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as ScrollViewState).scrollTop === 'number' &&
    typeof (value as ScrollViewState).scrollLeft === 'number'
  );
}

function parseCharacterEditorTabState(
  value: WorkbenchTabStatePayload,
): CharacterEditorTabStatePayload | null {
  if (
    value.schema !== CHARACTER_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  return {
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
  };
}

function commitCharacter(characterId: string, next: CharacterData, label: string) {
  return useCommandStore.getState().executeCommand({
    type: 'character.replaceData',
    label,
    payload: { characterId, data: next },
    originSaveUnitId: recordSaveUnitId('characters', characterId),
    persistencePolicy: 'manual-save',
  });
}

function nextUniqueId(existing: Iterable<string>, base: string) {
  const used = new Set(existing);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function toNumber(value: string, fallback: number) {
  const next = Number.parseFloat(value);
  return Number.isFinite(next) ? next : fallback;
}

function refValue(ref: { $ref: { id: string } } | null | undefined) {
  return ref?.$ref.id ?? '__none__';
}

function profileForPreview(data: CharacterData) {
  return (
    data.profiles.find((profile) => profile.id === data.defaults.profileId) ??
    data.profiles[0] ??
    null
  );
}

function poseForPreview(data: CharacterData) {
  const profile = profileForPreview(data);
  if (!profile) return null;
  return (
    profile.poses.find((pose) => pose.id === profile.defaultPoseId) ?? profile.poses[0] ?? null
  );
}

function expressionForPreview(data: CharacterData) {
  return (
    data.expressions.find((expression) => expression.id === data.defaults.expressionId) ??
    data.expressions[0] ??
    null
  );
}

export function CharacterEditor({ tab }: WorkbenchEditorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const projectDocument = useProjectStore((state) => state.document);
  const characterId = tab.resource?.entityId;
  const project = isAuthoringProject(projectDocument) ? projectDocument : null;
  const record = characterId && project ? project.characters[characterId] : null;
  const effectiveRecord =
    project && record ? resolveGameplayInstanceRecord(project, 'character', record) : record;
  const parsedData = parseCharacterData(effectiveRecord?.data);
  const data = parsedData ?? defaultCharacterData(record?.label ?? characterId ?? 'Character');
  const diagnostics = useMemo(
    () =>
      project && effectiveRecord && characterId
        ? validateCharacterData(project, characterId, effectiveRecord)
        : [],
    [project, effectiveRecord, characterId],
  );
  const diagnosticItems = useMemo(
    () =>
      diagnostics.map((item) => ({
        ...item,
        target: project ? resolveProjectDiagnosticTarget(project, item.path) : null,
      })),
    [project, diagnostics],
  );
  const imageAssets = project
    ? Object.entries(project.assets)
        .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
        .map(([id, asset]) => ({ id, label: asset.label }))
    : [];
  const materials = project
    ? Object.entries(project.materials).map(([id, material]) => ({ id, label: material.label }))
    : [];
  const rooms = project
    ? Object.entries(project.rooms).map(([roomId, room]) => ({ roomId, roomLabel: room.label }))
    : [];

  useWorkbenchEditorTabState<CharacterEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: CHARACTER_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: CHARACTER_EDITOR_TAB_STATE_SCHEMA,
          payload: {
            scroll: captureScrollViewState(scrollRef.current),
          },
        }),
        restoreTabState: (state: CharacterEditorTabState) => {
          const parsed = parseCharacterEditorTabState(state);
          if (!parsed) return;
          window.requestAnimationFrame(() =>
            restoreScrollViewState(scrollRef.current, parsed.scroll),
          );
        },
      }),
      [],
    ),
  );

  if (!characterId || !record || !project)
    return <div className="p-4 text-sm text-muted-foreground">Character record not found.</div>;

  const activeCharacterId = characterId;
  const activeRecord = record;
  const activeProject = project;
  const revision = characterPreviewRevision(activeProject, activeCharacterId);
  const previewDocument = {
    kind: 'character-preview' as const,
    recordId: activeCharacterId,
    revision,
    data: buildCharacterPreviewDocumentData(activeProject, activeCharacterId),
  };
  const previewProfile = profileForPreview(data);
  const previewPose = poseForPreview(data);
  const previewExpression = expressionForPreview(data);
  const previewLayers = resolveCharacterPresentationLayers(data);

  function commit(next: CharacterData, label = 'Update character') {
    commitCharacter(activeCharacterId, next, label);
  }

  function patchDialogue(patch: Partial<CharacterData['dialogue']>) {
    commit(
      { ...data, dialogue: { ...data.dialogue, ...patch } },
      'Update character dialogue style',
    );
  }

  function patchDefaults(patch: Partial<CharacterData['defaults']>) {
    commit({ ...data, defaults: { ...data.defaults, ...patch } }, 'Update character defaults');
  }

  function replaceProfile(profileId: string, patch: Partial<CharacterPresentationProfileData>) {
    commit(
      {
        ...data,
        profiles: data.profiles.map((profile) =>
          profile.id === profileId ? { ...profile, ...patch } : profile,
        ),
      },
      'Update character presentation profile',
    );
  }

  function replacePose(profileId: string, poseId: string, patch: Partial<CharacterPoseData>) {
    const profile = data.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    replaceProfile(profileId, {
      poses: profile.poses.map((pose) => (pose.id === poseId ? { ...pose, ...patch } : pose)),
    });
  }

  function replacePoseLayer(
    profileId: string,
    poseId: string,
    layerId: string,
    patch: Partial<CharacterLayerCompositionData>,
  ) {
    const profile = data.profiles.find((item) => item.id === profileId);
    const pose = profile?.poses.find((item) => item.id === poseId);
    if (!profile || !pose) return;
    replacePose(profileId, poseId, {
      layers: pose.layers.map((layer) =>
        layer.layerId === layerId ? { ...layer, ...patch } : layer,
      ),
    });
  }

  function replaceExpression(expressionId: string, patch: Partial<CharacterExpressionData>) {
    commit(
      {
        ...data,
        expressions: data.expressions.map((expression) =>
          expression.id === expressionId ? { ...expression, ...patch } : expression,
        ),
      },
      'Update character expression',
    );
  }

  function replaceAppearance(appearanceId: string, patch: Partial<CharacterAppearanceData>) {
    commit(
      {
        ...data,
        appearances: data.appearances.map((appearance) =>
          appearance.id === appearanceId ? { ...appearance, ...patch } : appearance,
        ),
      },
      'Update character appearance',
    );
  }

  function replaceSemanticOverride(
    kind: 'expression' | 'appearance',
    entryId: string,
    profileId: string,
    layerId: string,
    patch: Partial<CharacterLayerOverrideData>,
  ) {
    const entries = kind === 'expression' ? data.expressions : data.appearances;
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry) return;
    const currentProfile = entry.profiles.find((candidate) => candidate.profileId === profileId);
    const currentLayer = currentProfile?.layers.find((candidate) => candidate.layerId === layerId);
    const nextLayer = { layerId, ...currentLayer, ...patch };
    const layers = currentProfile
      ? currentProfile.layers.some((candidate) => candidate.layerId === layerId)
        ? currentProfile.layers.map((candidate) =>
            candidate.layerId === layerId ? nextLayer : candidate,
          )
        : [...currentProfile.layers, nextLayer]
      : [nextLayer];
    const profiles = currentProfile
      ? entry.profiles.map((candidate) =>
          candidate.profileId === profileId ? { ...candidate, layers } : candidate,
        )
      : [...entry.profiles, { profileId, layers }];
    if (kind === 'expression') replaceExpression(entryId, { profiles });
    else replaceAppearance(entryId, { profiles });
  }

  function replaceIdle(idleId: string, patch: Partial<CharacterIdleData>) {
    commit(
      {
        ...data,
        idles: data.idles.map((idle) => (idle.id === idleId ? { ...idle, ...patch } : idle)),
      },
      'Update character idle',
    );
  }

  function addProfile() {
    const id = nextUniqueId(
      data.profiles.map((profile) => profile.id),
      'profile',
    );
    commit(
      {
        ...data,
        profiles: [
          ...data.profiles,
          {
            id,
            label: 'Profile',
            layers: [{ id: 'body', label: 'Body', role: 'body' }],
            defaultPoseId: 'default',
            poses: [
              {
                id: 'default',
                label: 'Default',
                layers: [
                  {
                    layerId: 'body',
                    sprite: null,
                    material: null,
                    offset: { x: 0, y: 0 },
                    scale: 1,
                    anchor: { x: 0.5, y: 1 },
                    visible: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      'Add character presentation profile',
    );
  }

  function deleteProfile(profileId: string) {
    const remaining = data.profiles.filter((profile) => profile.id !== profileId);
    if (remaining.length === 0) return;
    const fallback = remaining[0]!.id;
    const removeProfileOverrides = <T extends { profiles: Array<{ profileId: string }> }>(
      entry: T,
    ) => ({
      ...entry,
      profiles: entry.profiles.filter((profile) => profile.profileId !== profileId),
    });
    commit(
      {
        ...data,
        profiles: remaining,
        defaults: {
          ...data.defaults,
          profileId: data.defaults.profileId === profileId ? fallback : data.defaults.profileId,
        },
        expressions: data.expressions.map(removeProfileOverrides),
        appearances: data.appearances.map(removeProfileOverrides),
      },
      'Delete character presentation profile',
    );
  }

  function addLayer(profileId: string) {
    const profile = data.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const id = nextUniqueId(
      profile.layers.map((layer) => layer.id),
      'layer',
    );
    replaceProfile(profileId, {
      layers: [...profile.layers, { id, label: 'Layer', role: null }],
      poses: profile.poses.map((pose) => ({
        ...pose,
        layers: [
          ...pose.layers,
          {
            layerId: id,
            sprite: null,
            material: null,
            offset: { x: 0, y: 0 },
            scale: 1,
            anchor: { x: 0.5, y: 1 },
            visible: true,
          },
        ],
      })),
    });
  }

  function deleteLayer(profileId: string, layerId: string) {
    const profile = data.profiles.find((item) => item.id === profileId);
    if (!profile || profile.layers.length <= 1) return;
    const stripOverrides = <
      T extends { profiles: Array<{ profileId: string; layers: CharacterLayerOverrideData[] }> },
    >(
      entry: T,
    ) => ({
      ...entry,
      profiles: entry.profiles.map((candidate) =>
        candidate.profileId === profileId
          ? { ...candidate, layers: candidate.layers.filter((layer) => layer.layerId !== layerId) }
          : candidate,
      ),
    });
    commit(
      {
        ...data,
        profiles: data.profiles.map((candidate) =>
          candidate.id === profileId
            ? {
                ...candidate,
                layers: candidate.layers.filter((layer) => layer.id !== layerId),
                poses: candidate.poses.map((pose) => ({
                  ...pose,
                  layers: pose.layers.filter((layer) => layer.layerId !== layerId),
                })),
              }
            : candidate,
        ),
        expressions: data.expressions.map(stripOverrides),
        appearances: data.appearances.map(stripOverrides),
      },
      'Delete character presentation layer',
    );
  }

  function addPose(profileId: string) {
    const profile = data.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const id = nextUniqueId(
      profile.poses.map((pose) => pose.id),
      'pose',
    );
    replaceProfile(profileId, {
      poses: [
        ...profile.poses,
        {
          id,
          label: 'Pose',
          layers: profile.layers.map((layer) => ({
            layerId: layer.id,
            sprite: null,
            material: null,
            offset: { x: 0, y: 0 },
            scale: 1,
            anchor: { x: 0.5, y: 1 },
            visible: true,
          })),
        },
      ],
    });
  }

  function deletePose(profileId: string, poseId: string) {
    const profile = data.profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const remaining = profile.poses.filter((pose) => pose.id !== poseId);
    if (remaining.length === 0) return;
    const fallback = remaining[0]!.id;
    replaceProfile(profileId, {
      poses: remaining,
      defaultPoseId: profile.defaultPoseId === poseId ? fallback : profile.defaultPoseId,
    });
  }

  function addExpression() {
    const id = nextUniqueId(
      data.expressions.map((expression) => expression.id),
      'expression',
    );
    commit(
      {
        ...data,
        expressions: [...data.expressions, { id, label: 'Expression', profiles: [] }],
      },
      'Add character expression',
    );
  }

  function addAppearance() {
    const id = nextUniqueId(
      data.appearances.map((appearance) => appearance.id),
      'appearance',
    );
    commit(
      { ...data, appearances: [...data.appearances, { id, label: 'Appearance', profiles: [] }] },
      'Add character appearance',
    );
  }

  function deleteAppearance(appearanceId: string) {
    commit(
      {
        ...data,
        appearances: data.appearances.filter((appearance) => appearance.id !== appearanceId),
        defaults: {
          ...data.defaults,
          appearanceId:
            data.defaults.appearanceId === appearanceId ? null : data.defaults.appearanceId,
        },
      },
      'Delete character appearance',
    );
  }

  function deleteExpression(expressionId: string) {
    const remaining = data.expressions.filter((expression) => expression.id !== expressionId);
    if (remaining.length === 0) return;
    const fallback = remaining[0]!.id;
    commit(
      {
        ...data,
        expressions: remaining,
        defaults: {
          ...data.defaults,
          expressionId:
            data.defaults.expressionId === expressionId ? fallback : data.defaults.expressionId,
        },
      },
      'Delete character expression',
    );
  }

  function addIdle() {
    const id = nextUniqueId(
      data.idles.map((idle) => idle.id),
      'idle',
    );
    commit(
      {
        ...data,
        idles: [
          ...data.idles,
          {
            id,
            label: 'Idle',
            kind: 'bob',
            amplitude: 0.01,
            periodMs: 2000,
            clock: 'gameplay',
          },
        ],
      },
      'Add character idle',
    );
  }

  function deleteIdle(idleId: string) {
    commit(
      {
        ...data,
        idles: data.idles.filter((idle) => idle.id !== idleId),
        defaults: {
          ...data.defaults,
          idleId: data.defaults.idleId === idleId ? null : data.defaults.idleId,
        },
      },
      'Delete character idle',
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col overflow-auto bg-background p-4"
      data-character-editor-scroll
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold">{activeRecord.label}</h2>
            <Badge variant="outline">{activeCharacterId}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Character dialogue style, poses, expressions, sprites, material overrides, and live
            preview.
          </p>
        </div>
      </div>

      {!parsedData ? (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Character data was invalid; showing editable defaults until you apply a change.
        </div>
      ) : null}

      <div className="mt-4">
        <GameplayArchetypeControls
          project={project}
          collection="characters"
          entityId={characterId}
          record={record}
          kind="character"
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <section
            className="grid gap-3 rounded border p-3 md:grid-cols-2"
            data-workbench-anchor="character.summary"
          >
            <div className="space-y-1">
              <Label>Display name</Label>
              <Input
                value={data.displayName}
                onChange={(event) =>
                  commit(
                    { ...data, displayName: event.currentTarget.value },
                    'Update character display name',
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label>Dialogue name</Label>
              <Input
                value={data.dialogue.name}
                onChange={(event) => patchDialogue({ name: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label>Name color</Label>
              <Input
                value={data.dialogue.nameColor ?? ''}
                onChange={(event) =>
                  patchDialogue({ nameColor: event.currentTarget.value.trim() || null })
                }
                placeholder="#f8fafc or empty"
              />
            </div>
            <div className="space-y-1">
              <Label>Text color</Label>
              <Input
                value={data.dialogue.textColor ?? ''}
                onChange={(event) =>
                  patchDialogue({ textColor: event.currentTarget.value.trim() || null })
                }
                placeholder="#f8fafc or empty"
              />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Style class</Label>
              <Input
                value={data.dialogue.styleClass}
                onChange={(event) => patchDialogue({ styleClass: event.currentTarget.value })}
                placeholder="dialogue-speaker"
              />
            </div>
          </section>

          <section
            className="grid gap-3 rounded border p-3 md:grid-cols-2"
            data-workbench-anchor="character.defaults"
          >
            <div className="space-y-1">
              <Label>Default profile</Label>
              <Select
                value={data.defaults.profileId}
                onValueChange={(value) => patchDefaults({ profileId: String(value) })}
              >
                {data.profiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.label} ({profile.id})
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default expression</Label>
              <Select
                value={data.defaults.expressionId}
                onValueChange={(value) => patchDefaults({ expressionId: String(value) })}
              >
                {data.expressions.map((expression) => (
                  <SelectItem key={expression.id} value={expression.id}>
                    {expression.label} ({expression.id})
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default appearance</Label>
              <Select
                value={data.defaults.appearanceId ?? '__none__'}
                onValueChange={(value) =>
                  patchDefaults({ appearanceId: value === '__none__' ? null : String(value) })
                }
              >
                <SelectItem value="__none__">No appearance</SelectItem>
                {data.appearances.map((appearance) => (
                  <SelectItem key={appearance.id} value={appearance.id}>
                    {appearance.label} ({appearance.id})
                  </SelectItem>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Default idle</Label>
              <Select
                value={data.defaults.idleId ?? '__none__'}
                onValueChange={(value) =>
                  patchDefaults({ idleId: value === '__none__' ? null : String(value) })
                }
              >
                <SelectItem value="__none__">No idle</SelectItem>
                {data.idles.map((idle) => (
                  <SelectItem key={idle.id} value={idle.id}>
                    {idle.label} ({idle.id})
                  </SelectItem>
                ))}
              </Select>
            </div>
          </section>

          <section
            className="grid gap-3 rounded border p-3 md:grid-cols-2"
            data-workbench-anchor="character.initialWorldState"
          >
            <h3 className="text-sm font-medium md:col-span-2">Initial world state</h3>
            <div className="space-y-1 md:col-span-2">
              <Label>Location</Label>
              <Select
                value={
                  data.initialWorldState.location.kind === 'unplaced'
                    ? '__unplaced__'
                    : data.initialWorldState.location.room.$ref.id
                }
                onValueChange={(value) =>
                  commit(
                    {
                      ...data,
                      initialWorldState: {
                        ...data.initialWorldState,
                        location:
                          value === '__unplaced__'
                            ? { kind: 'unplaced' }
                            : {
                                kind: 'room',
                                room: { $ref: { collection: 'rooms', id: String(value) } },
                              },
                      },
                    },
                    'Update character initial location',
                  )
                }
              >
                <SelectItem value="__unplaced__">Unplaced</SelectItem>
                {rooms.map((item) => (
                  <SelectItem key={item.roomId} value={item.roomId}>
                    {item.roomLabel} ({item.roomId})
                  </SelectItem>
                ))}
              </Select>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={data.initialWorldState.enabled}
                onChange={(event) =>
                  commit(
                    {
                      ...data,
                      initialWorldState: {
                        ...data.initialWorldState,
                        enabled: event.currentTarget.checked,
                      },
                    },
                    'Update character initial enabled state',
                  )
                }
              />
              Enabled
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={data.initialWorldState.visible}
                onChange={(event) =>
                  commit(
                    {
                      ...data,
                      initialWorldState: {
                        ...data.initialWorldState,
                        visible: event.currentTarget.checked,
                      },
                    },
                    'Update character initial visibility',
                  )
                }
              />
              Visible
            </label>
          </section>

          <InventoryDeclarationsEditor
            inventories={data.inventories}
            onChange={(inventories, label) => commit({ ...data, inventories }, label)}
            title="Character Inventories"
          />

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="character.profiles"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Presentation profiles</h3>
                <p className="text-xs text-muted-foreground">
                  Each occurrence chooses one profile. Profiles own their ordered layers and poses.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addProfile}>
                Add Profile
              </Button>
            </div>
            {data.profiles.map((profile, profileIndex) => (
              <div
                key={profile.id}
                className="space-y-3 rounded border p-3"
                data-workbench-anchor={`character.profile.${profile.id || profileIndex}`}
              >
                <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
                  <div className="space-y-1">
                    <Label>ID</Label>
                    <Input value={profile.id} readOnly />
                  </div>
                  <div className="space-y-1">
                    <Label>Label</Label>
                    <Input
                      value={profile.label}
                      onChange={(event) =>
                        replaceProfile(profile.id, { label: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>Default pose</Label>
                    <Select
                      value={profile.defaultPoseId}
                      onValueChange={(value) =>
                        replaceProfile(profile.id, { defaultPoseId: String(value) })
                      }
                    >
                      {profile.poses.map((pose) => (
                        <SelectItem key={pose.id} value={pose.id}>
                          {pose.label} ({pose.id})
                        </SelectItem>
                      ))}
                    </Select>
                  </div>
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={data.profiles.length <= 1}
                      onClick={() => deleteProfile(profile.id)}
                    >
                      Delete Profile
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">Layers</h4>
                    <Button size="sm" variant="ghost" onClick={() => addLayer(profile.id)}>
                      Add Layer
                    </Button>
                  </div>
                  {profile.layers.map((layer) => (
                    <div
                      key={layer.id}
                      className="grid gap-2 rounded bg-muted/30 p-2 md:grid-cols-[1fr_1fr_1fr_auto]"
                    >
                      <div className="space-y-1">
                        <Label>Layer ID</Label>
                        <Input value={layer.id} readOnly />
                      </div>
                      <div className="space-y-1">
                        <Label>Label</Label>
                        <Input
                          value={layer.label}
                          onChange={(event) =>
                            replaceProfile(profile.id, {
                              layers: profile.layers.map((candidate) =>
                                candidate.id === layer.id
                                  ? { ...candidate, label: event.currentTarget.value }
                                  : candidate,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Semantic role</Label>
                        <Input
                          value={layer.role ?? ''}
                          placeholder="body, face, outfit…"
                          onChange={(event) =>
                            replaceProfile(profile.id, {
                              layers: profile.layers.map((candidate) =>
                                candidate.id === layer.id
                                  ? {
                                      ...candidate,
                                      role: event.currentTarget.value.trim() || null,
                                    }
                                  : candidate,
                              ),
                            })
                          }
                        />
                      </div>
                      <div className="flex items-end">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={profile.layers.length <= 1}
                          onClick={() => deleteLayer(profile.id, layer.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium">Poses</h4>
                    <Button size="sm" variant="ghost" onClick={() => addPose(profile.id)}>
                      Add Pose
                    </Button>
                  </div>
                  {profile.poses.map((pose, poseIndex) => (
                    <div
                      key={pose.id}
                      className="space-y-2 rounded border p-2"
                      data-workbench-anchor={`character.profile.${profile.id}.pose.${pose.id || poseIndex}`}
                    >
                      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
                        <div className="space-y-1">
                          <Label>ID</Label>
                          <Input value={pose.id} readOnly />
                        </div>
                        <div className="space-y-1">
                          <Label>Label</Label>
                          <Input
                            value={pose.label}
                            onChange={(event) =>
                              replacePose(profile.id, pose.id, { label: event.currentTarget.value })
                            }
                          />
                        </div>
                        <div className="flex items-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => deletePose(profile.id, pose.id)}
                            disabled={profile.poses.length <= 1}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                      {pose.layers.map((layer) => (
                        <div
                          key={layer.layerId}
                          className="grid gap-2 rounded bg-muted/20 p-2 md:grid-cols-2 xl:grid-cols-5"
                        >
                          <div className="space-y-1">
                            <Label>Layer</Label>
                            <Input value={layer.layerId} readOnly />
                          </div>
                          <div className="space-y-1">
                            <Label>Sprite</Label>
                            <Select
                              value={refValue(layer.sprite)}
                              onValueChange={(value) =>
                                replacePoseLayer(profile.id, pose.id, layer.layerId, {
                                  sprite:
                                    value === '__none__' ? null : characterAssetRef(String(value)),
                                })
                              }
                            >
                              <SelectItem value="__none__">No sprite</SelectItem>
                              {imageAssets.map((asset) => (
                                <SelectItem key={asset.id} value={asset.id}>
                                  {asset.label} ({asset.id})
                                </SelectItem>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Material</Label>
                            <Select
                              value={refValue(layer.material)}
                              onValueChange={(value) =>
                                replacePoseLayer(profile.id, pose.id, layer.layerId, {
                                  material:
                                    value === '__none__'
                                      ? null
                                      : characterMaterialRef(String(value)),
                                })
                              }
                            >
                              <SelectItem value="__none__">No override</SelectItem>
                              {materials.map((material) => (
                                <SelectItem key={material.id} value={material.id}>
                                  {material.label} ({material.id})
                                </SelectItem>
                              ))}
                            </Select>
                          </div>
                          <div className="space-y-1">
                            <Label>Scale</Label>
                            <Input
                              value={String(layer.scale)}
                              onChange={(event) =>
                                replacePoseLayer(profile.id, pose.id, layer.layerId, {
                                  scale: Math.max(
                                    0.01,
                                    toNumber(event.currentTarget.value, layer.scale),
                                  ),
                                })
                              }
                            />
                          </div>
                          <label className="flex items-end gap-2 pb-2 text-xs">
                            <input
                              type="checkbox"
                              checked={layer.visible}
                              onChange={(event) =>
                                replacePoseLayer(profile.id, pose.id, layer.layerId, {
                                  visible: event.currentTarget.checked,
                                })
                              }
                            />
                            Visible
                          </label>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="character.expressions"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Expressions</h3>
              <Button size="sm" variant="outline" onClick={addExpression}>
                Add Expression
              </Button>
            </div>
            {data.expressions.map((expression, index) => (
              <div
                key={expression.id}
                className="grid gap-2 rounded border p-2 md:grid-cols-2"
                data-workbench-anchor={`character.expression.${expression.id || index}`}
              >
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input
                    value={expression.id}
                    onChange={(event) =>
                      replaceExpression(expression.id, { id: event.currentTarget.value })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={expression.label}
                    onChange={(event) =>
                      replaceExpression(expression.id, { label: event.currentTarget.value })
                    }
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <div className="text-xs text-muted-foreground">
                    Profile overrides are optional. Missing overrides deliberately fall back to this
                    Character&apos;s default Expression for the selected profile.
                  </div>
                  {data.profiles.map((profile) => (
                    <div key={profile.id} className="space-y-2 rounded bg-muted/20 p-2">
                      <div className="text-xs font-medium">{profile.label}</div>
                      {profile.layers.map((layer) => {
                        const override = expression.profiles
                          .find((candidate) => candidate.profileId === profile.id)
                          ?.layers.find((candidate) => candidate.layerId === layer.id);
                        return (
                          <div key={layer.id} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr]">
                            <div className="self-end pb-2 text-xs">{layer.label}</div>
                            <div className="space-y-1">
                              <Label>Sprite</Label>
                              <Select
                                value={
                                  override?.sprite === undefined
                                    ? '__inherit__'
                                    : refValue(override.sprite)
                                }
                                onValueChange={(value) =>
                                  replaceSemanticOverride(
                                    'expression',
                                    expression.id,
                                    profile.id,
                                    layer.id,
                                    {
                                      sprite:
                                        value === '__inherit__'
                                          ? undefined
                                          : value === '__none__'
                                            ? null
                                            : characterAssetRef(String(value)),
                                    },
                                  )
                                }
                              >
                                <SelectItem value="__inherit__">Inherit</SelectItem>
                                <SelectItem value="__none__">Hide sprite</SelectItem>
                                {imageAssets.map((asset) => (
                                  <SelectItem key={asset.id} value={asset.id}>
                                    {asset.label} ({asset.id})
                                  </SelectItem>
                                ))}
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <Label>Material</Label>
                              <Select
                                value={
                                  override?.material === undefined
                                    ? '__inherit__'
                                    : refValue(override.material)
                                }
                                onValueChange={(value) =>
                                  replaceSemanticOverride(
                                    'expression',
                                    expression.id,
                                    profile.id,
                                    layer.id,
                                    {
                                      material:
                                        value === '__inherit__'
                                          ? undefined
                                          : value === '__none__'
                                            ? null
                                            : characterMaterialRef(String(value)),
                                    },
                                  )
                                }
                              >
                                <SelectItem value="__inherit__">Inherit</SelectItem>
                                <SelectItem value="__none__">No material</SelectItem>
                                {materials.map((material) => (
                                  <SelectItem key={material.id} value={material.id}>
                                    {material.label} ({material.id})
                                  </SelectItem>
                                ))}
                              </Select>
                            </div>
                            <div className="space-y-1">
                              <Label>Visibility</Label>
                              <Select
                                value={
                                  override?.visible === undefined
                                    ? '__inherit__'
                                    : override.visible
                                      ? 'visible'
                                      : 'hidden'
                                }
                                onValueChange={(value) =>
                                  replaceSemanticOverride(
                                    'expression',
                                    expression.id,
                                    profile.id,
                                    layer.id,
                                    {
                                      visible:
                                        value === '__inherit__' ? undefined : value === 'visible',
                                    },
                                  )
                                }
                              >
                                <SelectItem value="__inherit__">Inherit</SelectItem>
                                <SelectItem value="visible">Visible</SelectItem>
                                <SelectItem value="hidden">Hidden</SelectItem>
                              </Select>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="flex items-end md:col-span-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deleteExpression(expression.id)}
                    disabled={data.expressions.length <= 1}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </section>

          <section
            className="space-y-3 rounded border p-3"
            data-workbench-anchor="character.appearances"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Appearances</h3>
                <p className="text-xs text-muted-foreground">
                  Optional independent visual axis for outfits, damage states, and similar variants.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addAppearance}>
                Add Appearance
              </Button>
            </div>
            {data.appearances.map((appearance, index) => (
              <div
                key={appearance.id}
                className="grid gap-2 rounded border p-2 md:grid-cols-2"
                data-workbench-anchor={`character.appearance.${appearance.id || index}`}
              >
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input value={appearance.id} readOnly />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={appearance.label}
                    onChange={(event) =>
                      replaceAppearance(appearance.id, { label: event.currentTarget.value })
                    }
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  {data.profiles.map((profile) => (
                    <div key={profile.id} className="space-y-2 rounded bg-muted/20 p-2">
                      <div className="text-xs font-medium">{profile.label}</div>
                      {profile.layers.map((layer) => {
                        const override = appearance.profiles
                          .find((candidate) => candidate.profileId === profile.id)
                          ?.layers.find((candidate) => candidate.layerId === layer.id);
                        return (
                          <div key={layer.id} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr]">
                            <div className="self-end pb-2 text-xs">{layer.label}</div>
                            <Select
                              value={
                                override?.sprite === undefined
                                  ? '__inherit__'
                                  : refValue(override.sprite)
                              }
                              onValueChange={(value) =>
                                replaceSemanticOverride(
                                  'appearance',
                                  appearance.id,
                                  profile.id,
                                  layer.id,
                                  {
                                    sprite:
                                      value === '__inherit__'
                                        ? undefined
                                        : value === '__none__'
                                          ? null
                                          : characterAssetRef(String(value)),
                                  },
                                )
                              }
                            >
                              <SelectItem value="__inherit__">Inherit sprite</SelectItem>
                              <SelectItem value="__none__">No sprite</SelectItem>
                              {imageAssets.map((asset) => (
                                <SelectItem key={asset.id} value={asset.id}>
                                  {asset.label} ({asset.id})
                                </SelectItem>
                              ))}
                            </Select>
                            <Select
                              value={
                                override?.material === undefined
                                  ? '__inherit__'
                                  : refValue(override.material)
                              }
                              onValueChange={(value) =>
                                replaceSemanticOverride(
                                  'appearance',
                                  appearance.id,
                                  profile.id,
                                  layer.id,
                                  {
                                    material:
                                      value === '__inherit__'
                                        ? undefined
                                        : value === '__none__'
                                          ? null
                                          : characterMaterialRef(String(value)),
                                  },
                                )
                              }
                            >
                              <SelectItem value="__inherit__">Inherit material</SelectItem>
                              <SelectItem value="__none__">No material</SelectItem>
                              {materials.map((material) => (
                                <SelectItem key={material.id} value={material.id}>
                                  {material.label} ({material.id})
                                </SelectItem>
                              ))}
                            </Select>
                            <Select
                              value={
                                override?.visible === undefined
                                  ? '__inherit__'
                                  : override.visible
                                    ? 'visible'
                                    : 'hidden'
                              }
                              onValueChange={(value) =>
                                replaceSemanticOverride(
                                  'appearance',
                                  appearance.id,
                                  profile.id,
                                  layer.id,
                                  {
                                    visible:
                                      value === '__inherit__' ? undefined : value === 'visible',
                                  },
                                )
                              }
                            >
                              <SelectItem value="__inherit__">Inherit visibility</SelectItem>
                              <SelectItem value="visible">Visible</SelectItem>
                              <SelectItem value="hidden">Hidden</SelectItem>
                            </Select>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="md:col-span-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => deleteAppearance(appearance.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </section>

          <section className="space-y-3 rounded border p-3" data-workbench-anchor="character.idles">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Idle loops</h3>
                <p className="text-xs text-muted-foreground">
                  Backend-local looping motion reconstructed from the selected definition.
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={addIdle}>
                Add Idle
              </Button>
            </div>
            {data.idles.map((idle, index) => (
              <div
                key={idle.id}
                className="grid gap-2 rounded border p-2 md:grid-cols-2 xl:grid-cols-6"
                data-workbench-anchor={`character.idle.${idle.id || index}`}
              >
                <div className="space-y-1">
                  <Label>ID</Label>
                  <Input
                    value={idle.id}
                    onChange={(event) => replaceIdle(idle.id, { id: event.currentTarget.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Label</Label>
                  <Input
                    value={idle.label}
                    onChange={(event) => replaceIdle(idle.id, { label: event.currentTarget.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Kind</Label>
                  <Select
                    value={idle.kind}
                    onValueChange={(value) =>
                      replaceIdle(idle.id, { kind: value as CharacterIdleData['kind'] })
                    }
                  >
                    {characterIdleKindValues.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {kind}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Amplitude</Label>
                  <Input
                    value={String(idle.amplitude)}
                    onChange={(event) =>
                      replaceIdle(idle.id, {
                        amplitude: Math.max(0, toNumber(event.currentTarget.value, idle.amplitude)),
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>Period (ms)</Label>
                  <Input
                    value={String(idle.periodMs)}
                    onChange={(event) =>
                      replaceIdle(idle.id, {
                        periodMs: Math.max(
                          1,
                          Math.round(toNumber(event.currentTarget.value, idle.periodMs)),
                        ),
                      })
                    }
                  />
                </div>
                <div className="space-y-1">
                  <Label>Clock</Label>
                  <Select
                    value={idle.clock}
                    onValueChange={(value) =>
                      replaceIdle(idle.id, { clock: value as CharacterIdleData['clock'] })
                    }
                  >
                    {presentationClockValues.map((clock) => (
                      <SelectItem key={clock} value={clock}>
                        {clock}
                      </SelectItem>
                    ))}
                  </Select>
                </div>
                <div className="flex items-end xl:col-span-6">
                  <Button size="sm" variant="outline" onClick={() => deleteIdle(idle.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </section>
        </div>

        <aside className="rounded border bg-muted/20 p-4" data-workbench-anchor="character.preview">
          <div className="h-72 overflow-hidden rounded border bg-background">
            <DerivedPreviewPane
              ownerTabId={tab.id}
              previewMode="character"
              previewDocument={previewDocument}
            />
          </div>
          <div className="mt-3 space-y-2 text-xs text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">Profile:</span>{' '}
              {previewProfile?.label ?? 'None'}
            </div>
            <div>
              <span className="font-medium text-foreground">Pose:</span>{' '}
              {previewPose?.label ?? 'None'}
            </div>
            <div>
              <span className="font-medium text-foreground">Expression:</span>{' '}
              {previewExpression?.label ?? 'None'}
            </div>
            <div>
              <span className="font-medium text-foreground">Appearance:</span>{' '}
              {data.defaults.appearanceId ?? 'None'}
            </div>
            {previewLayers.map((layer) => (
              <div key={layer.id}>
                <span className="font-medium text-foreground">{layer.id}:</span>{' '}
                {layer.visible ? (layer.sprite?.$ref.id ?? 'No sprite') : 'Hidden'}
              </div>
            ))}
          </div>
          {diagnostics.length > 0 ? (
            <div
              className="mt-4 rounded border p-2 text-xs text-muted-foreground"
              data-workbench-anchor="character.diagnostics"
            >
              <div className="font-medium text-foreground">Diagnostics</div>
              <div className="mt-1">
                <DiagnosticList items={diagnosticItems.slice(0, 4)} />
              </div>
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden font-mono text-[10px] text-muted-foreground">
            revision {revision.slice(0, 80)}
          </div>
        </aside>
      </div>
    </div>
  );
}
