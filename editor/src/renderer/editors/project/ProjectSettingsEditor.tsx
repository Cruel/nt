import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CategorizedEditorLayout,
  type CategorizedEditorCategory,
} from '@/components/CategorizedEditorLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ColorField } from '@/components/ui/color-field';
import { DiagnosticList } from '@/diagnostics/DiagnosticList';
import { resolveProjectDiagnosticTarget } from '@/diagnostics/diagnostic-navigation';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCommandStore } from '@/commands/command-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { PROJECT_SETTINGS_SAVE_UNIT_ID } from '@/project/save-unit-registry';
import { listComfyUiWorkflowLibrary } from '@/comfyui/comfyui-service';
import { useProjectStore } from '@/project/project-store';
import { SearchSelectorDialog } from '@/workspace/SearchSelectorDialog';
import { buildCommandPaletteItems, filterSelectorItems } from '@/workspace/command-palette-search';
import { parseAssetData } from '../../../shared/project-schema/authoring-assets';
import {
  audioPurposeValues,
  type AudioPurpose,
  type ProjectAudioSettings,
} from '../../../shared/project-schema/authoring-audio';
import {
  getSystemLayoutSetting,
  systemLayoutRoleValues,
  type SystemLayoutRole,
} from '../../../shared/project-schema/authoring-layouts';
import { type AuthoringProject } from '../../../shared/project-schema/authoring-project';
import {
  defaultInteractableInstanceData,
  parseInteractableData,
} from '../../../shared/project-schema/authoring-interactables';
import {
  PROJECT_INVENTORY_ID,
  PROJECT_INVENTORY_LABEL,
  projectInventoryRef,
} from '../../../shared/project-schema/authoring-inventories';
import { decodeAuthoringProject } from '../../../shared/project-schema/decode-authoring-project';
import { stripEditorProjectState } from '../../../shared/project-schema/editor-project-state';
import {
  assetMemoryBuiltinPresetValues,
  resolveAssetMemoryPolicy,
  type AssetMemoryPolicyDefinition,
  type AssetMemoryBuiltinPreset,
} from '../../../shared/project-schema/platform-export-contracts';
import {
  deriveProjectDisplayGeometry,
  projectSettingsForEditing,
  validateProjectSettingsAuthoringState,
  type ProjectAccessibilityScalePolicy,
  type ProjectAppSettings,
  type ProjectDisplaySettings,
} from '../../../shared/project-schema/authoring-project-settings';
import { MAX_REFERENCE_RESOLUTION_DIMENSION } from '../../../shared/project-schema/project-display-contract';
import {
  defaultInteractionProgram,
  type InteractionProgram,
} from '../../../shared/project-schema/authoring-interaction-programs';
import { InteractionProgramEditor } from '../interactions/InteractionProgramEditor';
import {
  collectPendingInputDiagnostics,
  usePendingInputStore,
} from '@/workbench/pending-input-store';
import { buildComfyUiWorkflowsTab, type WorkbenchEditorProps } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import { registerWorkbenchTargetHandler } from '@/workbench/workbench-navigation';
import {
  AppWindow,
  BadgeInfo,
  Blocks,
  Gauge,
  Image,
  LayoutTemplate,
  MonitorCog,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';
import {
  captureScrollViewState,
  captureSourceEditorViewStates,
  isScrollViewState,
  parseSourceEditorViewStates,
  restoreScrollViewState,
  restoreSourceEditorViewStates,
  useSourceEditorViewStateRefs,
  useWorkbenchEditorTabState,
  useWorkbenchTabStateStore,
  type ScrollViewState,
  type SourceEditorViewStates,
  type WorkbenchTabStatePayload,
} from '@/workbench/workbench-tab-state';

const PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA = 'noveltea.editor.tab-state.project-settings';

const AUDIO_PURPOSE_LABELS: Record<AudioPurpose, string> = {
  music: 'Music',
  ambience: 'Ambience',
  voice: 'Voice',
  'sound-effect': 'Sound Effects',
  'ui-sound': 'UI Sound',
};

type ProjectSettingsCategory =
  | 'general'
  | 'runtime'
  | 'asset-memory'
  | 'display'
  | 'audio'
  | 'title-screen'
  | 'app-identity'
  | 'integrations'
  | 'transitions'
  | 'status';

const projectSettingsCategories: readonly CategorizedEditorCategory<ProjectSettingsCategory>[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Project metadata, entrypoint, and startup behavior.',
    icon: AppWindow,
  },
  {
    id: 'runtime',
    label: 'Runtime',
    description: 'Built-in layouts and default runtime resources.',
    icon: LayoutTemplate,
  },
  {
    id: 'asset-memory',
    label: 'Asset Memory',
    description: 'Reusable target-relative asset residency policies.',
    icon: Gauge,
  },
  {
    id: 'display',
    label: 'Display',
    description: 'Canvas, raster, presentation, and accessibility scaling.',
    icon: MonitorCog,
  },
  {
    id: 'audio',
    label: 'Audio',
    description: 'Purpose mixing, mute defaults, and Voice ducking.',
    icon: Volume2,
  },
  {
    id: 'title-screen',
    label: 'Title Screen',
    description: 'Content shown by the built-in title and menu layout.',
    icon: Image,
  },
  {
    id: 'app-identity',
    label: 'App Identity',
    description: 'Package identity, localization, branding, and platform overrides.',
    icon: BadgeInfo,
  },
  {
    id: 'integrations',
    label: 'Integrations',
    description: 'Project-visible editor integrations and workflow summaries.',
    icon: Blocks,
  },
  {
    id: 'transitions',
    label: 'Transitions',
    description: 'Project-wide navigation presentation defaults.',
    icon: Sparkles,
  },
  {
    id: 'status',
    label: 'Status',
    description: 'Export readiness and project-settings diagnostics.',
    icon: ShieldCheck,
  },
];

function isProjectSettingsCategory(value: unknown): value is ProjectSettingsCategory {
  return projectSettingsCategories.some((category) => category.id === value);
}

function projectSettingsCategoryForTarget(targetId: string): ProjectSettingsCategory {
  if (
    targetId.startsWith('projectSettings.metadata') ||
    targetId.startsWith('projectSettings.startup') ||
    targetId === PROJECT_SETTINGS_FIELD_ANCHORS['/entrypoint'] ||
    targetId === PROJECT_SETTINGS_FIELD_ANCHORS['/bootstrapModule'] ||
    targetId === PROJECT_SETTINGS_FIELD_ANCHORS['/project/name'] ||
    targetId === PROJECT_SETTINGS_FIELD_ANCHORS['/project/version']
  )
    return 'general';
  if (
    targetId.startsWith('projectSettings.runtime') ||
    targetId.startsWith('projectSettings.field.systemLayout') ||
    targetId === PROJECT_SETTINGS_FIELD_ANCHORS['/settings/text/defaultFont']
  )
    return 'runtime';
  if (targetId.startsWith('projectSettings.assetMemory')) return 'asset-memory';
  if (
    targetId.startsWith('projectSettings.display') ||
    targetId.startsWith('projectSettings.field.referenceResolution') ||
    targetId.startsWith('projectSettings.field.worldRasterPolicy') ||
    targetId.startsWith('projectSettings.field.displayBarColor') ||
    targetId.startsWith('projectSettings.field.uiScale') ||
    targetId.startsWith('projectSettings.field.textScale')
  )
    return 'display';
  if (
    targetId.startsWith('projectSettings.audio') ||
    targetId.startsWith('projectSettings.field.audio')
  )
    return 'audio';
  if (
    targetId.startsWith('projectSettings.titleScreen') ||
    targetId.startsWith('projectSettings.field.titleImage') ||
    targetId.startsWith('projectSettings.field.startLabel')
  )
    return 'title-screen';
  if (
    targetId.startsWith('projectSettings.packageIdentity') ||
    (targetId.startsWith('projectSettings.field.') &&
      !targetId.startsWith('projectSettings.field.transition'))
  )
    return 'app-identity';
  if (targetId.startsWith('projectSettings.comfyuiWorkflows')) return 'integrations';
  if (
    targetId.startsWith('projectSettings.roomNavigationTransition') ||
    targetId.startsWith('projectSettings.field.transition')
  )
    return 'transitions';
  return 'status';
}

const PROJECT_SETTINGS_FIELD_ANCHORS: Record<string, string> = {
  '/entrypoint': 'projectSettings.field.entrypoint',
  '/bootstrapModule': 'projectSettings.field.bootstrapModule',
  '/project/name': 'projectSettings.field.projectName',
  '/project/version': 'projectSettings.field.projectVersion',
  '/settings/text/defaultFont': 'projectSettings.field.defaultFont',
  '/settings/display/referenceResolution/width': 'projectSettings.field.referenceResolutionWidth',
  '/settings/display/referenceResolution/height': 'projectSettings.field.referenceResolutionHeight',
  '/settings/display/worldRasterPolicy': 'projectSettings.field.worldRasterPolicy',
  '/settings/display/barColor': 'projectSettings.field.displayBarColor',
  '/settings/accessibility/uiScale/enabled': 'projectSettings.field.uiScaleEnabled',
  '/settings/accessibility/uiScale/minimum': 'projectSettings.field.uiScaleMinimum',
  '/settings/accessibility/uiScale/maximum': 'projectSettings.field.uiScaleMaximum',
  '/settings/accessibility/textScale/enabled': 'projectSettings.field.textScaleEnabled',
  '/settings/accessibility/textScale/minimum': 'projectSettings.field.textScaleMinimum',
  '/settings/accessibility/textScale/maximum': 'projectSettings.field.textScaleMaximum',
  '/settings/audio/purposes/music/volume': 'projectSettings.field.audioMusicVolume',
  '/settings/audio/purposes/music/muted': 'projectSettings.field.audioMusicMuted',
  '/settings/audio/purposes/ambience/volume': 'projectSettings.field.audioAmbienceVolume',
  '/settings/audio/purposes/ambience/muted': 'projectSettings.field.audioAmbienceMuted',
  '/settings/audio/purposes/voice/volume': 'projectSettings.field.audioVoiceVolume',
  '/settings/audio/purposes/voice/muted': 'projectSettings.field.audioVoiceMuted',
  '/settings/audio/purposes/sound-effect/volume': 'projectSettings.field.audioSoundEffectVolume',
  '/settings/audio/purposes/sound-effect/muted': 'projectSettings.field.audioSoundEffectMuted',
  '/settings/audio/purposes/ui-sound/volume': 'projectSettings.field.audioUiSoundVolume',
  '/settings/audio/purposes/ui-sound/muted': 'projectSettings.field.audioUiSoundMuted',
  '/settings/audio/voiceDucking/enabled': 'projectSettings.field.audioVoiceDuckingEnabled',
  '/settings/audio/voiceDucking/musicGain': 'projectSettings.field.audioVoiceDuckingMusicGain',
  '/settings/audio/voiceDucking/ambienceGain':
    'projectSettings.field.audioVoiceDuckingAmbienceGain',
  '/settings/titleScreen/titleImage': 'projectSettings.field.titleImage',
  '/settings/titleScreen/startLabel': 'projectSettings.field.startLabel',
  '/settings/app/displayName': 'projectSettings.field.appDisplayName',
  '/settings/app/shortName': 'projectSettings.field.appShortName',
  '/settings/app/publisher': 'projectSettings.field.publisher',
  '/settings/app/applicationId': 'projectSettings.field.applicationId',
  '/settings/app/saveNamespace': 'projectSettings.field.saveNamespace',
  '/settings/app/versionName': 'projectSettings.field.versionName',
  '/settings/app/buildNumber': 'projectSettings.field.buildNumber',
  '/settings/app/defaultLocale': 'projectSettings.field.defaultLocale',
  '/settings/app/icon': 'projectSettings.field.projectIcon',
  '/settings/app/launchImage': 'projectSettings.field.launchImage',
  '/settings/app/themeColor': 'projectSettings.field.themeColor',
  '/settings/app/accentColor': 'projectSettings.field.accentColor',
  '/settings/app/launchBackgroundColor': 'projectSettings.field.launchBackgroundColor',
  '/settings/app/android/applicationId': 'projectSettings.field.androidApplicationId',
  '/settings/app/desktop/appleBundleId': 'projectSettings.field.appleBundleId',
  '/settings/app/desktop/linuxDesktopId': 'projectSettings.field.linuxDesktopId',
  '/settings/app/desktop/windowsIdentity': 'projectSettings.field.windowsIdentity',
  '/settings/presentation/roomNavigationTransition/kind': 'projectSettings.field.transitionKind',
  '/settings/presentation/roomNavigationTransition/durationMs':
    'projectSettings.field.transitionDuration',
  '/settings/presentation/roomNavigationTransition/color': 'projectSettings.field.transitionColor',
};

function pathsOverlap(left: string, right: string) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function commandSucceeded(result: ReturnType<typeof runProjectCommand>) {
  return !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

interface PendingNumberInputProps {
  id: string;
  path: string;
  value: number | undefined;
  optional?: boolean;
  invalid: boolean;
  onCommit: (value: number | undefined) => boolean;
}

function PendingNumberInput({
  id,
  path,
  value,
  optional = false,
  invalid,
  onCommit,
}: PendingNumberInputProps) {
  const pending = usePendingInputStore(
    (state) => state.entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID]?.[path],
  );
  const setPendingInput = usePendingInputStore((state) => state.setPendingInput);
  const clearPendingInput = usePendingInputStore((state) => state.clearPendingInput);
  const rawValue = pending?.value ?? (value === undefined ? '' : String(value));

  return (
    <Input
      id={id}
      inputMode="numeric"
      value={rawValue}
      aria-invalid={invalid || Boolean(pending)}
      data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS[path]}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        if (optional && raw === '') {
          if (onCommit(undefined)) clearPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, path);
          return;
        }
        if (/^[+-]?\d+$/.test(raw)) {
          const parsed = Number(raw);
          if (Number.isSafeInteger(parsed) && onCommit(parsed)) {
            clearPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, path);
            return;
          }
        }
        setPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, path, {
          value: raw,
          diagnosticCode: 'editor.pending-input.number.invalid',
        });
      }}
    />
  );
}

interface PendingDecimalInputProps {
  id: string;
  path: string;
  value: number;
  invalid: boolean;
  onCommit: (value: number) => boolean;
}

function PendingDecimalInput({ id, path, value, invalid, onCommit }: PendingDecimalInputProps) {
  const pending = usePendingInputStore(
    (state) => state.entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID]?.[path],
  );
  const setPendingInput = usePendingInputStore((state) => state.setPendingInput);
  const clearPendingInput = usePendingInputStore((state) => state.clearPendingInput);
  const rawValue = pending?.value ?? String(value);

  return (
    <Input
      id={id}
      inputMode="decimal"
      value={rawValue}
      aria-invalid={invalid || Boolean(pending)}
      data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS[path]}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        if (/^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/.test(raw)) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && onCommit(parsed)) {
            clearPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, path);
            return;
          }
        }
        setPendingInput(PROJECT_SETTINGS_SAVE_UNIT_ID, path, {
          value: raw,
          diagnosticCode: 'editor.pending-input.number.invalid',
        });
      }}
    />
  );
}

interface ProjectSettingsEditorTabStatePayload {
  activeCategory: ProjectSettingsCategory;
  scroll?: ScrollViewState;
  sourceViewStates?: SourceEditorViewStates;
}

type ProjectSettingsEditorTabState = WorkbenchTabStatePayload & {
  schema: typeof PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA;
  payload?: ProjectSettingsEditorTabStatePayload;
};

function parseProjectSettingsEditorTabState(
  value: WorkbenchTabStatePayload,
): ProjectSettingsEditorTabStatePayload | null {
  if (
    value.schema !== PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  )
    return null;
  const payload = value.payload as Record<string, unknown>;
  if (!isProjectSettingsCategory(payload.activeCategory)) return null;
  return {
    activeCategory: payload.activeCategory,
    scroll: isScrollViewState(payload.scroll) ? payload.scroll : undefined,
    sourceViewStates: parseSourceEditorViewStates(payload.sourceViewStates),
  };
}

function valueOrNone(value: string | null | undefined) {
  return value ?? '__built_in__';
}

function systemLayoutSelectedId(role: SystemLayoutRole, layoutId: string | null | undefined) {
  return layoutId ? `record:layouts:${layoutId}` : `system-layout-built-in:${role}`;
}

function nullableValue(value: string) {
  return value === '__built_in__' || value === '__none__' ? null : value;
}

function nextInventoryInstanceId(project: AuthoringProject, definitionId: string) {
  if (!project.interactableInstances[definitionId]) return definitionId;
  let suffix = 2;
  while (project.interactableInstances[`${definitionId}-${suffix}`]) suffix += 1;
  return `${definitionId}-${suffix}`;
}

function runProjectCommand(type: string, payload: unknown, label: string) {
  return useCommandStore.getState().executeCommand({
    type,
    label,
    payload,
    originSaveUnitId: PROJECT_SETTINGS_SAVE_UNIT_ID,
    persistencePolicy: 'manual-save',
  });
}

function ProjectInventoryContentsEditor({ project }: { project: AuthoringProject }) {
  const definitions = Object.values(project.interactables)
    .map((record) => ({ record, data: parseInteractableData(record.data) }))
    .filter(
      (
        entry,
      ): entry is { record: (typeof entry)['record']; data: NonNullable<typeof entry.data> } =>
        Boolean(entry.data),
    )
    .sort((left, right) => left.record.label.localeCompare(right.record.label));
  const [definitionId, setDefinitionId] = useState(definitions[0]?.record.id ?? '');
  const selected = definitions.find((entry) => entry.record.id === definitionId) ?? definitions[0];
  const [quantityText, setQuantityText] = useState('1');
  const contents = Object.values(project.interactableInstances)
    .filter(
      (instance) =>
        instance.location.kind === 'inventory' &&
        instance.location.inventory.owner.kind === 'project' &&
        instance.location.inventory.inventoryId === PROJECT_INVENTORY_ID,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  useEffect(() => {
    if (!selected && definitions[0]) setDefinitionId(definitions[0].record.id);
  }, [definitions, selected]);

  const parsedQuantity = Number(quantityText);
  const quantity =
    selected?.data.stackable && Number.isSafeInteger(parsedQuantity) && parsedQuantity > 0
      ? Math.min(parsedQuantity, selected.data.stackLimit ?? Number.MAX_SAFE_INTEGER)
      : 1;

  function addStartingItem() {
    if (!selected) return;
    const instanceId = nextInventoryInstanceId(project, selected.record.id);
    const instance = defaultInteractableInstanceData(selected.record.id, selected.record.id, {
      kind: 'inventory',
      inventory: projectInventoryRef(),
    });
    instance.id = instanceId;
    instance.quantity = quantity;
    runProjectCommand(
      'project.addAtPath',
      { path: `/interactableInstances/${instanceId}`, value: instance },
      `Add ${selected.record.label} to Inventory`,
    );
  }

  return (
    <div className="space-y-2 md:col-span-2">
      <div>
        <Label>{PROJECT_INVENTORY_LABEL}</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Starting contents of the project&apos;s default player Inventory.
        </p>
      </div>
      {contents.length > 0 ? (
        <div className="space-y-2">
          {contents.map((instance) => {
            const definition = project.interactables[instance.definition.$ref.id];
            const data = definition ? parseInteractableData(definition.data) : null;
            return (
              <div
                key={instance.id}
                className="grid gap-2 rounded border p-2 md:grid-cols-[minmax(0,1fr)_7rem_auto] md:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {definition?.label ?? instance.definition.$ref.id}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{instance.id}</div>
                </div>
                {data?.stackable ? (
                  <Label className="gap-1">
                    Quantity
                    <Input
                      aria-label={`Quantity for ${instance.id}`}
                      type="number"
                      min={1}
                      max={data.stackLimit ?? undefined}
                      value={instance.quantity}
                      onChange={(event) => {
                        const next = Number(event.currentTarget.value);
                        if (!Number.isSafeInteger(next) || next <= 0) return;
                        const clamped = Math.min(next, data.stackLimit ?? Number.MAX_SAFE_INTEGER);
                        runProjectCommand(
                          'project.replaceAtPath',
                          {
                            path: `/interactableInstances/${instance.id}/quantity`,
                            value: clamped,
                          },
                          `Update ${definition?.label ?? instance.id} quantity`,
                        );
                      }}
                    />
                  </Label>
                ) : (
                  <span className="text-xs text-muted-foreground">Quantity 1</span>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    runProjectCommand(
                      'project.replaceAtPath',
                      {
                        path: `/interactableInstances/${instance.id}/location`,
                        value: { kind: 'unplaced' },
                      },
                      `Remove ${definition?.label ?? instance.id} from Inventory`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Inventory starts empty.</p>
      )}
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem_auto] md:items-end">
        <Label className="gap-1">
          Interactable
          <select
            aria-label="Inventory Interactable"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            value={selected?.record.id ?? ''}
            disabled={definitions.length === 0}
            onChange={(event) => setDefinitionId(event.currentTarget.value)}
          >
            {definitions.length === 0 ? <option value="">No Interactables</option> : null}
            {definitions.map(({ record }) => (
              <option key={record.id} value={record.id}>
                {record.label} ({record.id})
              </option>
            ))}
          </select>
        </Label>
        {selected?.data.stackable ? (
          <Label className="gap-1">
            Quantity
            <Input
              aria-label="New inventory quantity"
              type="number"
              min={1}
              max={selected.data.stackLimit ?? undefined}
              value={quantityText}
              onChange={(event) => setQuantityText(event.currentTarget.value)}
            />
          </Label>
        ) : (
          <div className="text-xs text-muted-foreground">Quantity 1</div>
        )}
        <Button type="button" size="sm" disabled={!selected} onClick={addStartingItem}>
          Add
        </Button>
      </div>
    </div>
  );
}

const ASSET_MEMORY_MIB = 1024 * 1024;

function formatAssetMemoryMiB(bytes: number) {
  return `${Math.round((bytes / ASSET_MEMORY_MIB) * 10) / 10} MiB`;
}

function uniqueAssetMemoryPolicyId(project: AuthoringProject, base = 'memory-policy') {
  const ids = new Set(project.export.assetMemoryPolicies.map((policy) => policy.id));
  if (!ids.has(base)) return base;
  let index = 2;
  while (ids.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function uniqueAssetMemoryPolicyLabel(project: AuthoringProject, base: string) {
  const labels = new Set(
    project.export.assetMemoryPolicies.map((policy) => policy.label.trim().toLowerCase()),
  );
  if (!labels.has(base.toLowerCase())) return base;
  let index = 2;
  while (labels.has(`${base} (${index})`.toLowerCase())) index += 1;
  return `${base} (${index})`;
}

function AssetMemoryPoliciesEditor({ project }: { project: AuthoringProject }) {
  const policies = project.export.assetMemoryPolicies;
  const [selectedPolicyId, setSelectedPolicyId] = useState(policies[0]?.id ?? '');
  const selectedPolicy = policies.find((policy) => policy.id === selectedPolicyId) ?? policies[0];

  useEffect(() => {
    if (!selectedPolicy && policies[0]) setSelectedPolicyId(policies[0].id);
    if (policies.length === 0 && selectedPolicyId) setSelectedPolicyId('');
  }, [policies, selectedPolicy, selectedPolicyId]);

  function replacePolicies(next: AssetMemoryPolicyDefinition[], label: string) {
    runProjectCommand(
      'project.replaceAtPath',
      { path: '/export/assetMemoryPolicies', value: next },
      label,
    );
  }

  function updatePolicy(
    policyId: string,
    update: (policy: AssetMemoryPolicyDefinition) => AssetMemoryPolicyDefinition,
    label: string,
  ) {
    replacePolicies(
      policies.map((policy) => (policy.id === policyId ? update(policy) : policy)),
      label,
    );
  }

  function addPolicy() {
    const policy: AssetMemoryPolicyDefinition = {
      id: uniqueAssetMemoryPolicyId(project),
      label: uniqueAssetMemoryPolicyLabel(project, 'New Policy'),
      basePreset: 'balanced',
      overrides: {},
    };
    replacePolicies([...policies, policy], 'Add asset memory policy');
    setSelectedPolicyId(policy.id);
  }

  function duplicatePolicy() {
    if (!selectedPolicy) return;
    const policy: AssetMemoryPolicyDefinition = {
      ...structuredClone(selectedPolicy),
      id: uniqueAssetMemoryPolicyId(project, selectedPolicy.id),
      label: uniqueAssetMemoryPolicyLabel(project, selectedPolicy.label),
    };
    replacePolicies([...policies, policy], `Duplicate ${selectedPolicy.label}`);
    setSelectedPolicyId(policy.id);
  }

  const references = selectedPolicy
    ? project.export.profiles.filter(
        (profile) =>
          profile.assetMemory.kind === 'policy' &&
          profile.assetMemory.policyId === selectedPolicy.id,
      )
    : [];

  function deletePolicy() {
    if (!selectedPolicy || references.length > 0) return;
    const next = policies.filter((policy) => policy.id !== selectedPolicy.id);
    replacePolicies(next, `Delete ${selectedPolicy.label}`);
    setSelectedPolicyId(next[0]?.id ?? '');
  }

  function baseResolved(preset: AssetMemoryBuiltinPreset) {
    return resolveAssetMemoryPolicy('linux', { kind: 'builtin', preset });
  }

  function setByteOverride(
    field: 'preparedCpuBytes' | 'gpuBytes' | 'audioBytes' | 'temporaryBytes',
    enabled: boolean,
  ) {
    if (!selectedPolicy) return;
    updatePolicy(
      selectedPolicy.id,
      (policy) => {
        const overrides = { ...policy.overrides };
        if (enabled) overrides[field] = baseResolved(policy.basePreset)[field];
        else delete overrides[field];
        return { ...policy, overrides };
      },
      `Update ${selectedPolicy.label} ${field}`,
    );
  }

  function setPercentOverride(enabled: boolean) {
    if (!selectedPolicy) return;
    updatePolicy(
      selectedPolicy.id,
      (policy) => {
        const overrides = { ...policy.overrides };
        if (enabled)
          overrides.prefetchAllowancePercent = baseResolved(
            policy.basePreset,
          ).prefetchAllowancePercent;
        else delete overrides.prefetchAllowancePercent;
        return { ...policy, overrides };
      },
      `Update ${selectedPolicy.label} prefetch allowance`,
    );
  }

  const resolutions = selectedPolicy
    ? [
        ['Desktop', 'linux'],
        ['Android', 'android'],
        ['Web', 'web'],
      ].map(([label, target]) => ({
        label,
        value: resolveAssetMemoryPolicy(
          target as 'linux' | 'android' | 'web',
          { kind: 'policy', policyId: selectedPolicy.id },
          policies,
        ),
      }))
    : [];

  const byteFields = [
    ['preparedCpuBytes', 'Prepared CPU'],
    ['gpuBytes', 'GPU'],
    ['audioBytes', 'Audio'],
    ['temporaryBytes', 'Temporary preparation'],
  ] as const;

  return (
    <Card data-workbench-anchor="projectSettings.assetMemoryPolicies">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Asset Memory Policies</CardTitle>
            <CardDescription>
              Define reusable policies based on Low, Balanced, or High. Unoverridden fields continue
              to follow each target&apos;s built-in values.
            </CardDescription>
          </div>
          <Button type="button" size="sm" onClick={addPolicy}>
            Add Policy
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No project policies yet. Export and Play can still use Low, Balanced, and High.
          </p>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
              <div className="space-y-2">
                {policies.map((policy) => (
                  <button
                    key={policy.id}
                    type="button"
                    className={`w-full rounded border px-3 py-2 text-left text-sm ${
                      selectedPolicy?.id === policy.id
                        ? 'bg-muted font-medium'
                        : 'hover:bg-muted/50'
                    }`}
                    onClick={() => setSelectedPolicyId(policy.id)}
                  >
                    <div>{policy.label}</div>
                    <div className="text-xs font-normal text-muted-foreground">{policy.id}</div>
                  </button>
                ))}
              </div>
              {selectedPolicy ? (
                <div className="space-y-4 rounded border p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Label className="gap-1">
                      Name
                      <Input
                        value={selectedPolicy.label}
                        onChange={(event) => {
                          const label = event.currentTarget.value;
                          const duplicate = policies.some(
                            (policy) =>
                              policy.id !== selectedPolicy.id &&
                              policy.label.trim().toLowerCase() === label.trim().toLowerCase(),
                          );
                          if (!label.trim() || duplicate) return;
                          updatePolicy(
                            selectedPolicy.id,
                            (policy) => ({ ...policy, label }),
                            `Rename ${selectedPolicy.label}`,
                          );
                        }}
                      />
                    </Label>
                    <Label className="gap-1">
                      Base preset
                      <select
                        className="h-9 rounded border bg-background px-2 text-sm"
                        value={selectedPolicy.basePreset}
                        onChange={(event) =>
                          updatePolicy(
                            selectedPolicy.id,
                            (policy) => ({
                              ...policy,
                              basePreset: event.currentTarget.value as AssetMemoryBuiltinPreset,
                            }),
                            `Change ${selectedPolicy.label} base preset`,
                          )
                        }
                      >
                        {assetMemoryBuiltinPresetValues.map((preset) => (
                          <option key={preset} value={preset}>
                            {preset[0]!.toUpperCase() + preset.slice(1)}
                          </option>
                        ))}
                      </select>
                    </Label>
                  </div>

                  <div className="space-y-3">
                    {byteFields.map(([field, label]) => {
                      const override = selectedPolicy.overrides[field];
                      return (
                        <div
                          key={field}
                          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_9rem] sm:items-center"
                        >
                          <div>
                            <div className="text-sm font-medium">{label}</div>
                            <div className="text-xs text-muted-foreground">
                              {override === undefined
                                ? 'Inherited from target preset'
                                : 'Absolute override'}
                            </div>
                          </div>
                          <label className="flex items-center gap-2 text-xs">
                            <Switch
                              checked={override !== undefined}
                              onCheckedChange={(checked) => setByteOverride(field, checked)}
                            />
                            Override
                          </label>
                          <Input
                            aria-label={`${label} MiB`}
                            type="number"
                            min={field === 'temporaryBytes' ? 1 : Number.MIN_VALUE}
                            step="1"
                            disabled={override === undefined}
                            value={override === undefined ? '' : override / ASSET_MEMORY_MIB}
                            onChange={(event) => {
                              const mibValue = Number(event.currentTarget.value);
                              if (!Number.isFinite(mibValue) || mibValue <= 0) return;
                              const bytes = mibValue * ASSET_MEMORY_MIB;
                              if (!Number.isSafeInteger(bytes)) return;
                              updatePolicy(
                                selectedPolicy.id,
                                (policy) => ({
                                  ...policy,
                                  overrides: { ...policy.overrides, [field]: bytes },
                                }),
                                `Update ${selectedPolicy.label} ${field}`,
                              );
                            }}
                          />
                        </div>
                      );
                    })}
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_9rem] sm:items-center">
                      <div>
                        <div className="text-sm font-medium">Warm prefetch allowance</div>
                        <div className="text-xs text-muted-foreground">
                          {selectedPolicy.overrides.prefetchAllowancePercent === undefined
                            ? 'Inherited from target preset'
                            : 'Absolute percentage override'}
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={selectedPolicy.overrides.prefetchAllowancePercent !== undefined}
                          onCheckedChange={setPercentOverride}
                        />
                        Override
                      </label>
                      <Input
                        aria-label="Warm prefetch allowance percent"
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        disabled={selectedPolicy.overrides.prefetchAllowancePercent === undefined}
                        value={selectedPolicy.overrides.prefetchAllowancePercent ?? ''}
                        onChange={(event) => {
                          const percent = Number(event.currentTarget.value);
                          if (!Number.isInteger(percent) || percent < 0 || percent > 100) return;
                          updatePolicy(
                            selectedPolicy.id,
                            (policy) => ({
                              ...policy,
                              overrides: { ...policy.overrides, prefetchAllowancePercent: percent },
                            }),
                            `Update ${selectedPolicy.label} prefetch allowance`,
                          );
                        }}
                      />
                    </div>
                  </div>

                  <div className="overflow-x-auto rounded border">
                    <table className="w-full min-w-[42rem] text-left text-xs">
                      <thead className="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th className="px-2 py-2 font-medium">Target</th>
                          <th className="px-2 py-2 font-medium">Prepared CPU</th>
                          <th className="px-2 py-2 font-medium">GPU</th>
                          <th className="px-2 py-2 font-medium">Audio</th>
                          <th className="px-2 py-2 font-medium">Temporary</th>
                          <th className="px-2 py-2 font-medium">Warm</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resolutions.map(({ label, value }) => (
                          <tr key={label} className="border-t">
                            <td className="px-2 py-2 font-medium">{label}</td>
                            <td className="px-2 py-2">
                              {formatAssetMemoryMiB(value.preparedCpuBytes)}
                            </td>
                            <td className="px-2 py-2">{formatAssetMemoryMiB(value.gpuBytes)}</td>
                            <td className="px-2 py-2">{formatAssetMemoryMiB(value.audioBytes)}</td>
                            <td className="px-2 py-2">
                              {formatAssetMemoryMiB(value.temporaryBytes)}
                            </td>
                            <td className="px-2 py-2">{value.prefetchAllowancePercent}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {references.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Used by export profile{references.length === 1 ? '' : 's'}:{' '}
                      {references.map((profile) => profile.label).join(', ')}. Change those
                      references before deleting this policy.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={duplicatePolicy}>
                      Duplicate
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={references.length > 0}
                      onClick={deletePolicy}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const systemLayoutRoleLabels: Record<SystemLayoutRole, string> = {
  title: 'Title screen',
  'game-hud': 'Game HUD',
  'pause-menu': 'Pause menu',
  'save-menu': 'Save menu',
  'load-menu': 'Load menu',
  'settings-menu': 'Settings menu',
  'text-log': 'Text log',
  modal: 'Modal dialog',
  'debug-overlay': 'Debug overlay',
  'command-builder': 'Command builder',
  'scene-text': 'Scene text',
  'scene-choice': 'Scene choice',
};

export function ProjectSettingsEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sourceEditors = useSourceEditorViewStateRefs<'startupInitScript'>();
  const projectDocument = useProjectStore((state) => state.document);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const decodedProject = useMemo(
    () =>
      projectDocument ? decodeAuthoringProject(stripEditorProjectState(projectDocument)) : null,
    [projectDocument],
  );
  const project: AuthoringProject | null = decodedProject?.project
    ? (projectDocument as AuthoringProject)
    : null;
  const settings = useMemo(() => (project ? projectSettingsForEditing(project) : null), [project]);
  const pendingInputEntries = usePendingInputStore(
    (state) => state.entriesBySaveUnitId[PROJECT_SETTINGS_SAVE_UNIT_ID],
  );
  const pendingInputDiagnostics = useMemo(
    () =>
      collectPendingInputDiagnostics({
        entriesBySaveUnitId: pendingInputEntries
          ? { [PROJECT_SETTINGS_SAVE_UNIT_ID]: pendingInputEntries }
          : {},
      }),
    [pendingInputEntries],
  );
  const projectSettingsDiagnostics = useMemo(
    () => (project ? validateProjectSettingsAuthoringState(project) : []),
    [project],
  );
  const selectorItems = useMemo(() => buildCommandPaletteItems(project, t), [project, t]);
  const entrypointItems = useMemo(
    () =>
      filterSelectorItems(selectorItems, {
        collections: ['rooms', 'scenes', 'dialogues'],
        includeActions: false,
      }),
    [selectorItems],
  );
  const layoutItems = useMemo(
    () => filterSelectorItems(selectorItems, { collections: ['layouts'], includeActions: false }),
    [selectorItems],
  );
  const scriptItems = useMemo(
    () => filterSelectorItems(selectorItems, { collections: ['scripts'], includeActions: false }),
    [selectorItems],
  );
  const [workflowSummary, setWorkflowSummary] = useState({
    activeCount: 0,
    projectCount: 0,
    invalidProjectCount: 0,
  });
  const [workflowSummaryMessage, setWorkflowSummaryMessage] = useState<string | null>(null);
  const [entrypointSelectorOpen, setEntrypointSelectorOpen] = useState(false);
  const [bootstrapModuleSelectorOpen, setBootstrapModuleSelectorOpen] = useState(false);
  const [systemLayoutSelectorRole, setSystemLayoutSelectorRole] = useState<SystemLayoutRole | null>(
    null,
  );
  const [resolutionDialogOpen, setResolutionDialogOpen] = useState(false);
  const [resolutionWidth, setResolutionWidth] = useState('');
  const [resolutionHeight, setResolutionHeight] = useState('');
  const [activeCategory, setActiveCategory] = useState<ProjectSettingsCategory>(() => {
    const savedState = useWorkbenchTabStateStore.getState().tabStatesById[tab.id];
    return savedState
      ? (parseProjectSettingsEditorTabState(savedState)?.activeCategory ?? 'general')
      : 'general';
  });

  useWorkbenchEditorTabState<ProjectSettingsEditorTabState>(
    tab.id,
    useMemo(
      () => ({
        schema: PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA,
        captureTabState: () => ({
          schema: PROJECT_SETTINGS_EDITOR_TAB_STATE_SCHEMA,
          payload: {
            activeCategory,
            scroll: captureScrollViewState(scrollRef.current),
            sourceViewStates: captureSourceEditorViewStates(sourceEditors.refs.current),
          },
        }),
        restoreTabState: (state: ProjectSettingsEditorTabState) => {
          const parsed = parseProjectSettingsEditorTabState(state);
          if (!parsed) return;
          setActiveCategory(parsed.activeCategory);
          window.requestAnimationFrame(() => {
            restoreScrollViewState(scrollRef.current, parsed.scroll);
            restoreSourceEditorViewStates(sourceEditors.refs.current, parsed.sourceViewStates);
          });
        },
      }),
      [activeCategory, sourceEditors.refs],
    ),
  );

  useEffect(
    () =>
      registerWorkbenchTargetHandler(tab.id, 'projectSettings', (target) => {
        setActiveCategory(projectSettingsCategoryForTarget(target.id));
        return false;
      }),
    [tab.id],
  );

  useEffect(() => {
    if (!projectFilePath) {
      setWorkflowSummary({ activeCount: 0, projectCount: 0, invalidProjectCount: 0 });
      return;
    }
    let canceled = false;
    void listComfyUiWorkflowLibrary({ projectFilePath, includeOverridden: true }).then(
      (response) => {
        if (!canceled) {
          const projectSource = response.summary.sources.find(
            (source) => source.source === 'project',
          );
          setWorkflowSummary({
            activeCount: response.summary.activeCount,
            projectCount: projectSource?.workflowCount ?? 0,
            invalidProjectCount: response.entries.filter(
              (entry) => entry.source === 'project' && entry.offlineStatus === 'invalid',
            ).length,
          });
          setWorkflowSummaryMessage(response.error ?? null);
        }
      },
    );
    return () => {
      canceled = true;
    };
  }, [projectFilePath]);

  if (!project || !settings)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Open a project to edit project settings.
      </div>
    );

  const roomEntries = Object.entries(project.rooms).map(([id, room]) => ({
    id,
    label: room.label || id,
  }));
  const imageAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'image')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const fontAssets = Object.entries(project.assets)
    .filter(([, asset]) => parseAssetData(asset.data)?.kind === 'font')
    .map(([id, asset]) => ({ id, label: asset.label || id }));
  const entrypointIsRoom = project.entrypoint?.kind === 'room' ? project.entrypoint.id : null;
  const entrypointCollection = project.entrypoint ? (`${project.entrypoint.kind}s` as const) : null;
  const entrypointRecord =
    project.entrypoint && entrypointCollection
      ? project[entrypointCollection][project.entrypoint.id]
      : null;
  const relevantDiagnostics = [...projectSettingsDiagnostics, ...pendingInputDiagnostics];
  const relevantDiagnosticItems = relevantDiagnostics.map((diagnostic) => ({
    ...diagnostic,
    target: resolveProjectDiagnosticTarget(project, diagnostic.path),
  }));
  const invalidPaths = relevantDiagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.path);
  const fieldInvalid = (path: string) =>
    invalidPaths.some((diagnosticPath) => pathsOverlap(path, diagnosticPath));
  const displayGeometry = deriveProjectDisplayGeometry(settings.display.referenceResolution);
  const parsedResolutionWidth = Number(resolutionWidth);
  const parsedResolutionHeight = Number(resolutionHeight);
  const resolutionDialogValid =
    /^\d+$/.test(resolutionWidth) &&
    /^\d+$/.test(resolutionHeight) &&
    Number.isSafeInteger(parsedResolutionWidth) &&
    Number.isSafeInteger(parsedResolutionHeight) &&
    parsedResolutionWidth > 0 &&
    parsedResolutionWidth <= MAX_REFERENCE_RESOLUTION_DIMENSION &&
    parsedResolutionHeight > 0 &&
    parsedResolutionHeight <= MAX_REFERENCE_RESOLUTION_DIMENSION;

  function updateMetadata(patch: {
    name?: string;
    version?: string;
    author?: string;
    description?: string;
  }) {
    return commandSucceeded(
      runProjectCommand('project.updateMetadata', patch, 'Update project metadata'),
    );
  }

  function setEntrypoint(target: { kind: 'room' | 'scene' | 'dialogue'; id: string } | null) {
    return commandSucceeded(
      runProjectCommand('project.setEntrypoint', { target }, 'Set project entrypoint'),
    );
  }

  function setSystemLayout(role: SystemLayoutRole, layoutId: string | null) {
    return commandSucceeded(
      runProjectCommand('project.setSystemLayout', { role, layoutId }, `Set ${role} layout`),
    );
  }

  function setDefaultFont(assetId: string | null) {
    return commandSucceeded(
      runProjectCommand('project.setDefaultFont', { assetId }, 'Set default font'),
    );
  }

  function setDefaultInventoryLayout(layoutId: string | null) {
    return commandSucceeded(
      runProjectCommand(
        'project.replaceAtPath',
        {
          path: '/settings/inventory/defaultLayout',
          value: layoutId ? { $ref: { collection: 'layouts', id: layoutId } } : null,
        },
        'Set default Inventory Layout',
      ),
    );
  }

  function setDefaultVerbMenuLayout(layoutId: string | null) {
    return commandSucceeded(
      runProjectCommand(
        'project.replaceAtPath',
        {
          path: '/settings/interaction/defaultVerbMenuLayout',
          value: layoutId ? { $ref: { collection: 'layouts', id: layoutId } } : null,
        },
        'Set default Verb Menu Layout',
      ),
    );
  }

  function setUndefinedInteractionProgram(program: InteractionProgram | null) {
    return commandSucceeded(
      runProjectCommand(
        'project.setUndefinedInteractionProgram',
        { program },
        'Set undefined Interaction behavior',
      ),
    );
  }

  function setTitleScreen(patch: {
    titleImageId?: string | null;
    showProjectTitle?: boolean;
    showAuthor?: boolean;
    subtitle?: string;
    startLabel?: string;
  }) {
    return commandSucceeded(
      runProjectCommand('project.setTitleScreen', patch, 'Update title screen'),
    );
  }

  function setProjectIcon(assetId: string | null) {
    return commandSucceeded(runProjectCommand('project.setIcon', { assetId }, 'Set project icon'));
  }

  function setAppIdentity(patch: Partial<ProjectAppSettings>) {
    if (!settings) return false;
    const app = JSON.parse(JSON.stringify({ ...settings.app, ...patch })) as ProjectAppSettings;
    return commandSucceeded(runProjectCommand('project.setApp', { app }, 'Update app identity'));
  }

  function setDisplay(display: ProjectDisplaySettings) {
    return commandSucceeded(
      runProjectCommand('project.setDisplay', display, 'Update display settings'),
    );
  }

  function setReferenceResolution(width: number, height: number) {
    return commandSucceeded(
      runProjectCommand(
        'project.setReferenceResolution',
        { width, height },
        'Change reference resolution',
      ),
    );
  }

  function setAccessibilityScale(
    scale: 'uiScale' | 'textScale',
    policy: ProjectAccessibilityScalePolicy,
  ) {
    return commandSucceeded(
      runProjectCommand(
        'project.setAccessibilityScale',
        { scale, policy },
        `Update ${scale === 'uiScale' ? 'UI' : 'text'} accessibility scale`,
      ),
    );
  }

  function setAudio(audio: ProjectAudioSettings) {
    return commandSucceeded(
      runProjectCommand('project.setAudio', { audio }, 'Update project audio settings'),
    );
  }

  function setAudioPurpose(
    purpose: AudioPurpose,
    patch: Partial<ProjectAudioSettings['purposes'][AudioPurpose]>,
  ) {
    if (!settings) return false;
    return setAudio({
      ...settings.audio,
      purposes: {
        ...settings.audio.purposes,
        [purpose]: { ...settings.audio.purposes[purpose], ...patch },
      },
    });
  }

  function setVoiceDucking(patch: Partial<ProjectAudioSettings['voiceDucking']>) {
    if (!settings) return false;
    return setAudio({
      ...settings.audio,
      voiceDucking: { ...settings.audio.voiceDucking, ...patch },
    });
  }

  function openResolutionDialog() {
    if (!settings) return;
    setResolutionWidth(String(settings.display.referenceResolution.width));
    setResolutionHeight(String(settings.display.referenceResolution.height));
    setResolutionDialogOpen(true);
  }

  function setRoomNavigationTransition(
    patch: Partial<{
      kind: 'cut' | 'fade' | 'dissolve';
      durationMs: number;
      color: string | null;
      skippable: boolean;
    }>,
  ) {
    if (!settings) return false;
    return commandSucceeded(
      runProjectCommand(
        'project.setRoomNavigationTransition',
        {
          transition: {
            ...settings.presentation.roomNavigationTransition,
            ...patch,
          },
        },
        'Update room navigation transition',
      ),
    );
  }

  function setRoomNavigationTransitionKind(kind: 'cut' | 'fade' | 'dissolve') {
    if (!settings) return false;
    const current = settings.presentation.roomNavigationTransition;
    return setRoomNavigationTransition({
      kind,
      ...(kind !== 'cut' && current.durationMs === 0 ? { durationMs: 500 } : {}),
    });
  }

  function openWorkflowManager() {
    navigateToWorkbenchTarget({ tab: buildComfyUiWorkflowsTab() });
  }

  return (
    <CategorizedEditorLayout
      categories={projectSettingsCategories}
      activeCategory={activeCategory}
      onCategoryChange={setActiveCategory}
      navigationLabel="Project settings categories"
      contentRef={scrollRef}
      showActiveDescription={false}
      header={
        <h2 className="truncate text-lg font-semibold">
          {projectSettingsCategories.find((category) => category.id === activeCategory)?.label ??
            'General'}
        </h2>
      }
    >
      {activeCategory === 'general' ? (
        <>
          <Card size="sm" data-workbench-anchor="projectSettings.metadata">
            <CardContent className="grid gap-1">
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <Label className="whitespace-nowrap" htmlFor="project-title">
                  Project title
                </Label>
                <Input
                  id="project-title"
                  aria-invalid={fieldInvalid('/project/name')}
                  data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/project/name']}
                  value={project.project.name}
                  onChange={(event) => updateMetadata({ name: event.currentTarget.value })}
                />
              </div>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <Label className="whitespace-nowrap" htmlFor="project-version">
                  Version
                </Label>
                <Input
                  id="project-version"
                  aria-invalid={fieldInvalid('/project/version')}
                  data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/project/version']}
                  value={project.project.version}
                  onChange={(event) => updateMetadata({ version: event.currentTarget.value })}
                />
              </div>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <Label className="whitespace-nowrap" htmlFor="project-author">
                  Author
                </Label>
                <Input
                  id="project-author"
                  value={project.project.author}
                  onChange={(event) => updateMetadata({ author: event.currentTarget.value })}
                />
              </div>
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                <Label className="whitespace-nowrap" htmlFor="project-description">
                  Description
                </Label>
                <Input
                  id="project-description"
                  value={project.project.description}
                  onChange={(event) => updateMetadata({ description: event.currentTarget.value })}
                />
              </div>
              {developerMode ? (
                <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2">
                  <span className="text-xs font-medium">Project ID</span>
                  <code className="truncate text-xs text-muted-foreground">
                    {project.project.id}
                  </code>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.startup">
            <CardHeader>
              <CardTitle>Startup</CardTitle>
              <CardDescription>{t('selectors.entrypoint.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Project entrypoint</Label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 min-w-64 justify-start px-2 text-left text-xs font-normal"
                    aria-invalid={fieldInvalid('/entrypoint')}
                    data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/entrypoint']}
                    onClick={() => setEntrypointSelectorOpen(true)}
                  >
                    <span className="truncate">
                      {project.entrypoint && entrypointRecord
                        ? `${entrypointRecord.label || project.entrypoint.id} (${project.entrypoint.kind}/${project.entrypoint.id})`
                        : t('selectors.none.entrypoint')}
                    </span>
                  </Button>
                  {project.entrypoint ? (
                    <Button size="sm" variant="outline" onClick={() => setEntrypoint(null)}>
                      {t('selectors.clear')}
                    </Button>
                  ) : null}
                </div>
                {roomEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Create a room before choosing a runtime-exportable entrypoint.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <Label>Bootstrap Module</Label>
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 min-w-64 justify-start px-2 text-left text-xs font-normal"
                  aria-invalid={fieldInvalid('/bootstrapModule')}
                  data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/bootstrapModule']}
                  onClick={() => setBootstrapModuleSelectorOpen(true)}
                >
                  <span className="truncate">
                    {project.scripts[project.bootstrapModule.$ref.id]?.label ??
                      project.bootstrapModule.$ref.id}
                  </span>
                </Button>
                <p className="text-xs text-muted-foreground">
                  Runs once in a fresh Project Lua VM before gameplay state is available.
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      {activeCategory === 'runtime' ? (
        <>
          <Card data-workbench-anchor="projectSettings.runtime">
            <CardHeader>
              <CardTitle>Runtime Defaults</CardTitle>
              <CardDescription>
                Built-in fallback resources are used when no project resource is selected.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <div>
                  <Label>System layouts</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Override individual engine UI roles. Leaving a role built-in keeps the
                    engine-provided layout for that role.
                  </p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {systemLayoutRoleValues.map((role) => {
                    const selected = getSystemLayoutSetting(project, role);
                    const selectedLayoutId = selected?.$ref.id ?? null;
                    const selectedLayout = selectedLayoutId
                      ? project.layouts[selectedLayoutId]
                      : null;
                    return (
                      <div key={role} className="space-y-1">
                        <Label>{systemLayoutRoleLabels[role]}</Label>
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 min-w-0 flex-1 justify-start px-2 text-left text-xs font-normal"
                            aria-invalid={fieldInvalid(`/settings/ui/systemLayouts/${role}`)}
                            data-workbench-anchor={`projectSettings.field.systemLayout.${role}`}
                            onClick={() => setSystemLayoutSelectorRole(role)}
                          >
                            <span className="truncate">
                              {selectedLayoutId
                                ? `${selectedLayout?.label || selectedLayoutId} (${selectedLayoutId})`
                                : `Built-in ${systemLayoutRoleLabels[role].toLowerCase()}`}
                            </span>
                          </Button>
                          {selectedLayoutId ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setSystemLayout(role, null)}
                            >
                              {t('selectors.clear')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="default-font">Default font</Label>
                <select
                  id="default-font"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  aria-invalid={fieldInvalid('/settings/text/defaultFont')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/text/defaultFont']
                  }
                  value={valueOrNone(settings.text.defaultFont?.$ref.id)}
                  onChange={(event) => setDefaultFont(nullableValue(event.currentTarget.value))}
                >
                  <option value="__built_in__">Built-in default font</option>
                  {fontAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.label} ({asset.id})
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="default-inventory-layout">Default Inventory Layout</Label>
                <select
                  id="default-inventory-layout"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={settings.inventory.defaultLayout?.$ref.id ?? '__built_in__'}
                  onChange={(event) =>
                    setDefaultInventoryLayout(
                      event.currentTarget.value === '__built_in__'
                        ? null
                        : event.currentTarget.value,
                    )
                  }
                >
                  <option value="__built_in__">Built-in compact Inventory Layout</option>
                  {Object.values(project.layouts).map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.label} ({layout.id})
                    </option>
                  ))}
                </select>
              </div>
              <ProjectInventoryContentsEditor project={project} />
              <div className="space-y-1">
                <Label htmlFor="default-verb-menu-layout">Default Verb Menu Layout</Label>
                <select
                  id="default-verb-menu-layout"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={settings.interaction.defaultVerbMenuLayout?.$ref.id ?? '__built_in__'}
                  onChange={(event) =>
                    setDefaultVerbMenuLayout(
                      event.currentTarget.value === '__built_in__'
                        ? null
                        : event.currentTarget.value,
                    )
                  }
                >
                  <option value="__built_in__">Built-in anchored Verb Menu Layout</option>
                  {Object.values(project.layouts).map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.label} ({layout.id})
                    </option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>
          <Card data-workbench-anchor="projectSettings.undefinedInteraction">
            <CardHeader>
              <CardTitle>Undefined Interaction Behavior</CardTitle>
              <CardDescription>
                Optional project-wide fallback after a Verb default declines a complete command. If
                omitted, the engine emits its localized undefined-interaction response.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={project.undefinedInteractionProgram !== null}
                  onChange={(event) =>
                    setUndefinedInteractionProgram(
                      event.currentTarget.checked ? defaultInteractionProgram() : null,
                    )
                  }
                />
                Use project fallback behavior
              </label>
              {project.undefinedInteractionProgram ? (
                <InteractionProgramEditor
                  value={project.undefinedInteractionProgram}
                  project={project}
                  onChange={setUndefinedInteractionProgram}
                />
              ) : null}
            </CardContent>
          </Card>
        </>
      ) : null}

      {activeCategory === 'asset-memory' ? <AssetMemoryPoliciesEditor project={project} /> : null}

      {activeCategory === 'display' ? (
        <Card data-workbench-anchor="projectSettings.display">
          <CardHeader>
            <CardTitle>Display & Accessibility</CardTitle>
            <CardDescription>
              Define the authored world canvas, raster policy, presentation bars, and player scaling
              ranges.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-md border p-3 md:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Label>Reference resolution</Label>
                    <div className="mt-1 font-mono text-sm">
                      <span
                        aria-invalid={fieldInvalid('/settings/display/referenceResolution/width')}
                        data-workbench-anchor={
                          PROJECT_SETTINGS_FIELD_ANCHORS[
                            '/settings/display/referenceResolution/width'
                          ]
                        }
                      >
                        {settings.display.referenceResolution.width}
                      </span>
                      {' × '}
                      <span
                        aria-invalid={fieldInvalid('/settings/display/referenceResolution/height')}
                        data-workbench-anchor={
                          PROJECT_SETTINGS_FIELD_ANCHORS[
                            '/settings/display/referenceResolution/height'
                          ]
                        }
                      >
                        {settings.display.referenceResolution.height}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {displayGeometry
                        ? `Derived ${displayGeometry.aspectRatio.width}:${displayGeometry.aspectRatio.height} aspect ratio · ${displayGeometry.orientation}`
                        : 'Aspect ratio and orientation are unavailable until both dimensions are valid.'}
                    </p>
                  </div>
                  <Button type="button" size="sm" variant="outline" onClick={openResolutionDialog}>
                    Change Reference Resolution...
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="world-raster-policy">World raster policy</Label>
                <select
                  id="world-raster-policy"
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  aria-invalid={fieldInvalid('/settings/display/worldRasterPolicy')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/display/worldRasterPolicy']
                  }
                  value={settings.display.worldRasterPolicy}
                  onChange={(event) =>
                    setDisplay({
                      ...settings.display,
                      worldRasterPolicy: event.currentTarget
                        .value as ProjectDisplaySettings['worldRasterPolicy'],
                    })
                  }
                >
                  {!['capped', 'native'].includes(settings.display.worldRasterPolicy) ? (
                    <option value={settings.display.worldRasterPolicy}>
                      Invalid: {settings.display.worldRasterPolicy}
                    </option>
                  ) : null}
                  <option value="capped">Capped</option>
                  <option value="native">Native</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Capped limits world raster density; native follows output density.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="display-bar-color">Presentation bar color</Label>
                <Input
                  id="display-bar-color"
                  aria-invalid={fieldInvalid('/settings/display/barColor')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/display/barColor']
                  }
                  value={settings.display.barColor}
                  onChange={(event) =>
                    setDisplay({ ...settings.display, barColor: event.currentTarget.value })
                  }
                />
              </div>
            </div>

            {(['uiScale', 'textScale'] as const).map((scale) => {
              const policy = settings.accessibility[scale];
              const label = scale === 'uiScale' ? 'UI scale' : 'Text scale';
              const basePath = `/settings/accessibility/${scale}`;
              return (
                <div key={scale} className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <Label>{label}</Label>
                      <p className="text-xs text-muted-foreground">
                        {policy.enabled
                          ? 'Players may choose a value inside this range.'
                          : 'Disabled policies use 1.0 while retaining the authored range.'}
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        checked={policy.enabled}
                        aria-invalid={fieldInvalid(`${basePath}/enabled`)}
                        data-workbench-anchor={
                          PROJECT_SETTINGS_FIELD_ANCHORS[`${basePath}/enabled`]
                        }
                        onCheckedChange={(enabled) =>
                          setAccessibilityScale(scale, { ...policy, enabled })
                        }
                      />
                      Enabled
                    </label>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor={`${scale}-minimum`}>{label} minimum</Label>
                      <PendingDecimalInput
                        id={`${scale}-minimum`}
                        path={`${basePath}/minimum`}
                        value={policy.minimum}
                        invalid={fieldInvalid(`${basePath}/minimum`)}
                        onCommit={(minimum) => setAccessibilityScale(scale, { ...policy, minimum })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`${scale}-maximum`}>{label} maximum</Label>
                      <PendingDecimalInput
                        id={`${scale}-maximum`}
                        path={`${basePath}/maximum`}
                        value={policy.maximum}
                        invalid={fieldInvalid(`${basePath}/maximum`)}
                        onCommit={(maximum) => setAccessibilityScale(scale, { ...policy, maximum })}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'audio' ? (
        <Card data-workbench-anchor="projectSettings.audio">
          <CardHeader>
            <CardTitle>Audio Mix</CardTitle>
            <CardDescription>
              Configure the authored default mix by semantic Purpose. Runtime previews consume these
              settings through the same compiled-project audio contract as exported games.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-2">
              {audioPurposeValues.map((purpose) => {
                const mix = settings.audio.purposes[purpose];
                const basePath = `/settings/audio/purposes/${purpose}`;
                return (
                  <div
                    key={purpose}
                    className="grid gap-3 rounded-md border p-3 md:grid-cols-[minmax(8rem,1fr)_minmax(10rem,1fr)_auto] md:items-center"
                  >
                    <div>
                      <Label>{AUDIO_PURPOSE_LABELS[purpose]}</Label>
                      <p className="text-xs text-muted-foreground">
                        {purpose === 'ui-sound'
                          ? 'Disposable shell/UI feedback; never a gameplay blocker.'
                          : purpose === 'voice'
                            ? 'Dialogue and other spoken playback.'
                            : purpose === 'sound-effect'
                              ? 'Gameplay sound effects and synchronized cues.'
                              : 'Reconstructible desired loops and transient playback.'}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`audio-${purpose}-volume`}>
                        {AUDIO_PURPOSE_LABELS[purpose]} volume
                      </Label>
                      <PendingDecimalInput
                        id={`audio-${purpose}-volume`}
                        path={`${basePath}/volume`}
                        value={mix.volume}
                        invalid={fieldInvalid(`${basePath}/volume`)}
                        onCommit={(volume) => setAudioPurpose(purpose, { volume })}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-xs">
                      <Switch
                        checked={mix.muted}
                        aria-invalid={fieldInvalid(`${basePath}/muted`)}
                        data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS[`${basePath}/muted`]}
                        onCheckedChange={(muted) => setAudioPurpose(purpose, { muted })}
                      />
                      {AUDIO_PURPOSE_LABELS[purpose]} muted
                    </label>
                  </div>
                );
              })}
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Label>Voice ducking</Label>
                  <p className="text-xs text-muted-foreground">
                    Optionally reduce Music and Ambience while Voice playback is active.
                  </p>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={settings.audio.voiceDucking.enabled}
                    aria-invalid={fieldInvalid('/settings/audio/voiceDucking/enabled')}
                    data-workbench-anchor={
                      PROJECT_SETTINGS_FIELD_ANCHORS['/settings/audio/voiceDucking/enabled']
                    }
                    onCheckedChange={(enabled) => setVoiceDucking({ enabled })}
                  />
                  Enabled
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="audio-duck-music">Music gain while Voice is active</Label>
                  <PendingDecimalInput
                    id="audio-duck-music"
                    path="/settings/audio/voiceDucking/musicGain"
                    value={settings.audio.voiceDucking.musicGain}
                    invalid={fieldInvalid('/settings/audio/voiceDucking/musicGain')}
                    onCommit={(musicGain) => setVoiceDucking({ musicGain })}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="audio-duck-ambience">Ambience gain while Voice is active</Label>
                  <PendingDecimalInput
                    id="audio-duck-ambience"
                    path="/settings/audio/voiceDucking/ambienceGain"
                    value={settings.audio.voiceDucking.ambienceGain}
                    invalid={fieldInvalid('/settings/audio/voiceDucking/ambienceGain')}
                    onCommit={(ambienceGain) => setVoiceDucking({ ambienceGain })}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'title-screen' ? (
        <Card data-workbench-anchor="projectSettings.titleScreen">
          <CardHeader>
            <CardTitle>Title Screen</CardTitle>
            <CardDescription>Values consumed by the built-in title/menu layout.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="title-image">Title image</Label>
              <select
                id="title-image"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                aria-invalid={fieldInvalid('/settings/titleScreen/titleImage')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS['/settings/titleScreen/titleImage']
                }
                value={settings.titleScreen.titleImage?.$ref.id ?? '__none__'}
                onChange={(event) =>
                  setTitleScreen({ titleImageId: nullableValue(event.currentTarget.value) })
                }
              >
                <option value="__none__">No title image</option>
                {imageAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.label} ({asset.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="start-label">Start label</Label>
              <Input
                id="start-label"
                aria-invalid={fieldInvalid('/settings/titleScreen/startLabel')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS['/settings/titleScreen/startLabel']
                }
                value={settings.titleScreen.startLabel}
                onChange={(event) => setTitleScreen({ startLabel: event.currentTarget.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={settings.titleScreen.showProjectTitle}
                onCheckedChange={(checked) =>
                  setTitleScreen({ showProjectTitle: Boolean(checked) })
                }
              />
              Show project title
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch
                checked={settings.titleScreen.showAuthor}
                onCheckedChange={(checked) => setTitleScreen({ showAuthor: Boolean(checked) })}
              />
              Show author name
            </label>
            <div className="space-y-1 md:col-span-2">
              <Label>Subtitle</Label>
              <Input
                value={settings.titleScreen.subtitle}
                onChange={(event) => setTitleScreen({ subtitle: event.currentTarget.value })}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'app-identity' ? (
        <Card data-workbench-anchor="projectSettings.packageIdentity">
          <CardHeader>
            <CardTitle>App Identity</CardTitle>
            <CardDescription>
              Stable identity and branding used by platform exports. Changing IDs after release can
              disconnect installed apps and saves.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="app-display-name">Display name</Label>
              <Input
                id="app-display-name"
                aria-invalid={fieldInvalid('/settings/app/displayName')}
                data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/displayName']}
                value={settings.app.displayName}
                onChange={(event) => setAppIdentity({ displayName: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="app-short-name">Short name</Label>
              <Input
                id="app-short-name"
                aria-invalid={fieldInvalid('/settings/app/shortName')}
                data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/shortName']}
                value={settings.app.shortName ?? ''}
                onChange={(event) => setAppIdentity({ shortName: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="app-id">Application ID</Label>
              <Input
                id="app-id"
                aria-invalid={fieldInvalid('/settings/app/applicationId')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/applicationId']
                }
                className="font-mono text-[11px]"
                value={settings.app.applicationId}
                onChange={(event) => setAppIdentity({ applicationId: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="save-namespace">Save namespace</Label>
              <Input
                id="save-namespace"
                aria-invalid={fieldInvalid('/settings/app/saveNamespace')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/saveNamespace']
                }
                className="font-mono text-[11px]"
                value={settings.app.saveNamespace}
                onChange={(event) => setAppIdentity({ saveNamespace: event.currentTarget.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor="app-version">Version name</Label>
                <Input
                  id="app-version"
                  aria-invalid={fieldInvalid('/settings/app/versionName')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/versionName']
                  }
                  value={settings.app.versionName}
                  onChange={(event) => setAppIdentity({ versionName: event.currentTarget.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="app-build">Build number</Label>
                <PendingNumberInput
                  id="app-build"
                  path="/settings/app/buildNumber"
                  value={settings.app.buildNumber}
                  optional
                  invalid={fieldInvalid('/settings/app/buildNumber')}
                  onCommit={(buildNumber) => setAppIdentity({ buildNumber })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="app-locale">Default locale</Label>
              <Input
                id="app-locale"
                placeholder="en-US"
                aria-invalid={fieldInvalid('/settings/app/defaultLocale')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/defaultLocale']
                }
                value={settings.app.defaultLocale ?? ''}
                onChange={(event) => setAppIdentity({ defaultLocale: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="app-publisher">Publisher</Label>
              <Input
                id="app-publisher"
                aria-invalid={fieldInvalid('/settings/app/publisher')}
                data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/publisher']}
                value={settings.app.publisher ?? ''}
                onChange={(event) => setAppIdentity({ publisher: event.currentTarget.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="project-icon">Project icon</Label>
              <select
                id="project-icon"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                aria-invalid={fieldInvalid('/settings/app/icon')}
                data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/icon']}
                value={settings.app.icon?.$ref.id ?? '__none__'}
                onChange={(event) => setProjectIcon(nullableValue(event.currentTarget.value))}
              >
                <option value="__none__">No project icon</option>
                {imageAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.label} ({asset.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="launch-image">Launch image</Label>
              <select
                id="launch-image"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                aria-invalid={fieldInvalid('/settings/app/launchImage')}
                data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/launchImage']}
                value={settings.app.launchImage?.$ref.id ?? '__none__'}
                onChange={(event) =>
                  setAppIdentity({
                    launchImage: nullableValue(event.currentTarget.value)
                      ? { $ref: { collection: 'assets', id: event.currentTarget.value } }
                      : null,
                  })
                }
              >
                <option value="__none__">No launch image</option>
                {imageAssets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.label} ({asset.id})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['Theme', 'themeColor'],
                  ['Accent', 'accentColor'],
                  ['Launch', 'launchBackgroundColor'],
                ] as const
              ).map(([label, key]) => (
                <div key={key} className="space-y-1">
                  <Label>{label} color</Label>
                  <Input
                    aria-label={`${label} color`}
                    aria-invalid={fieldInvalid(`/settings/app/${key}`)}
                    data-workbench-anchor={PROJECT_SETTINGS_FIELD_ANCHORS[`/settings/app/${key}`]}
                    value={settings.app[key] ?? ''}
                    onChange={(event) => setAppIdentity({ [key]: event.currentTarget.value })}
                  />
                </div>
              ))}
            </div>
            <details className="space-y-2 text-xs">
              <summary className="cursor-pointer font-medium">
                Platform identifier overrides
              </summary>
              <div className="grid gap-2 pt-2">
                <Label htmlFor="android-app-id">Android application ID</Label>
                <Input
                  id="android-app-id"
                  className="font-mono text-[11px]"
                  aria-invalid={fieldInvalid('/settings/app/android/applicationId')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/android/applicationId']
                  }
                  value={settings.app.android.applicationId ?? ''}
                  onChange={(event) =>
                    setAppIdentity({
                      android: {
                        ...settings.app.android,
                        applicationId: event.currentTarget.value,
                      },
                    })
                  }
                />
                <Label htmlFor="apple-bundle-id">Apple bundle ID</Label>
                <Input
                  id="apple-bundle-id"
                  className="font-mono text-[11px]"
                  aria-invalid={fieldInvalid('/settings/app/desktop/appleBundleId')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/desktop/appleBundleId']
                  }
                  value={settings.app.desktop.appleBundleId ?? ''}
                  onChange={(event) =>
                    setAppIdentity({
                      desktop: {
                        ...settings.app.desktop,
                        appleBundleId: event.currentTarget.value,
                      },
                    })
                  }
                />
                <Label htmlFor="linux-desktop-id">Linux desktop ID</Label>
                <Input
                  id="linux-desktop-id"
                  className="font-mono text-[11px]"
                  aria-invalid={fieldInvalid('/settings/app/desktop/linuxDesktopId')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/desktop/linuxDesktopId']
                  }
                  value={settings.app.desktop.linuxDesktopId ?? ''}
                  onChange={(event) =>
                    setAppIdentity({
                      desktop: {
                        ...settings.app.desktop,
                        linuxDesktopId: event.currentTarget.value,
                      },
                    })
                  }
                />
                <Label htmlFor="windows-identity">Windows identity</Label>
                <Input
                  id="windows-identity"
                  aria-invalid={fieldInvalid('/settings/app/desktop/windowsIdentity')}
                  data-workbench-anchor={
                    PROJECT_SETTINGS_FIELD_ANCHORS['/settings/app/desktop/windowsIdentity']
                  }
                  value={settings.app.desktop.windowsIdentity ?? ''}
                  onChange={(event) =>
                    setAppIdentity({
                      desktop: {
                        ...settings.app.desktop,
                        windowsIdentity: event.currentTarget.value,
                      },
                    })
                  }
                />
              </div>
            </details>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'integrations' ? (
        <Card
          id="project-settings-comfyui"
          data-workbench-anchor="projectSettings.comfyuiWorkflows"
        >
          <CardHeader>
            <CardTitle>{t('comfyuiWorkflows.title')}</CardTitle>
            <CardDescription>{t('comfyuiWorkflows.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-xs">
              <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                <span className="text-muted-foreground">
                  {t('comfyuiWorkflows.summary.active')}
                </span>
                <Badge variant="secondary">{workflowSummary.activeCount}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                <span className="text-muted-foreground">
                  {t('comfyuiWorkflows.summary.project')}
                </span>
                <Badge variant="outline">{workflowSummary.projectCount}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 rounded border px-3 py-2">
                <span className="text-muted-foreground">
                  {t('comfyuiWorkflows.summary.invalidProject')}
                </span>
                <Badge
                  variant={workflowSummary.invalidProjectCount > 0 ? 'destructive' : 'outline'}
                >
                  {workflowSummary.invalidProjectCount}
                </Badge>
              </div>
              {workflowSummaryMessage ? (
                <div className="rounded border p-2 text-muted-foreground">
                  {workflowSummaryMessage}
                </div>
              ) : null}
              <Button size="sm" variant="outline" onClick={openWorkflowManager}>
                {t('comfyuiWorkflows.actions.manage')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'transitions' ? (
        <Card data-workbench-anchor="projectSettings.roomNavigationTransition">
          <CardHeader>
            <CardTitle>Room navigation transition</CardTitle>
            <CardDescription>
              Project fallback used when neither a request nor the selected exit supplies a
              transition.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="transition-kind">Kind</Label>
              <select
                id="transition-kind"
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                aria-invalid={fieldInvalid('/settings/presentation/roomNavigationTransition/kind')}
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS[
                    '/settings/presentation/roomNavigationTransition/kind'
                  ]
                }
                value={settings.presentation.roomNavigationTransition.kind}
                onChange={(event) =>
                  setRoomNavigationTransitionKind(
                    event.currentTarget
                      .value as typeof settings.presentation.roomNavigationTransition.kind,
                  )
                }
              >
                <option value="cut">cut</option>
                <option value="fade">fade</option>
                <option value="dissolve">dissolve</option>
              </select>
            </div>
            {settings.presentation.roomNavigationTransition.kind !== 'cut' ? (
              <div className="space-y-1">
                <Label htmlFor="transition-duration">Duration (ms)</Label>
                <PendingNumberInput
                  id="transition-duration"
                  path="/settings/presentation/roomNavigationTransition/durationMs"
                  value={settings.presentation.roomNavigationTransition.durationMs}
                  invalid={fieldInvalid(
                    '/settings/presentation/roomNavigationTransition/durationMs',
                  )}
                  onCommit={(durationMs) =>
                    durationMs !== undefined && setRoomNavigationTransition({ durationMs })
                  }
                />
              </div>
            ) : null}
            {settings.presentation.roomNavigationTransition.kind === 'fade' ? (
              <div
                className="space-y-1"
                data-workbench-anchor={
                  PROJECT_SETTINGS_FIELD_ANCHORS[
                    '/settings/presentation/roomNavigationTransition/color'
                  ]
                }
              >
                <Label>Fade color</Label>
                <ColorField
                  ariaLabel="Fade color"
                  value={settings.presentation.roomNavigationTransition.color}
                  onValueChange={(color) => setRoomNavigationTransition({ color })}
                />
              </div>
            ) : null}
            <label className="flex items-center gap-2">
              <Switch
                checked={settings.presentation.roomNavigationTransition.skippable}
                onCheckedChange={(checked) => setRoomNavigationTransition({ skippable: checked })}
              />
              Skippable
            </label>
          </CardContent>
        </Card>
      ) : null}

      {activeCategory === 'status' ? (
        <>
          <Card data-workbench-anchor="projectSettings.exportReadiness">
            <CardHeader>
              <CardTitle>Export Readiness</CardTitle>
              <CardDescription>
                Package export currently requires a room entrypoint.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <Badge variant={entrypointIsRoom ? 'default' : 'destructive'}>
                  {entrypointIsRoom ? 'ready' : 'missing'}
                </Badge>
                <span>
                  {entrypointIsRoom
                    ? `Entrypoint room: ${entrypointIsRoom}`
                    : 'Choose an entrypoint room before exporting.'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary">built-in fallback</Badge>
                <span>System layouts and font can use built-in resources.</span>
              </div>
            </CardContent>
          </Card>

          <Card data-workbench-anchor="projectSettings.diagnostics">
            <CardHeader>
              <CardTitle>Diagnostics</CardTitle>
              <CardDescription>
                Project-level validation relevant to settings and export.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <DiagnosticList
                items={relevantDiagnosticItems}
                emptyMessage="No project settings diagnostics."
              />
            </CardContent>
          </Card>
        </>
      ) : null}
      <SearchSelectorDialog
        open={entrypointSelectorOpen}
        title={t('selectors.entrypoint.title')}
        placeholder={t('selectors.entrypoint.placeholder')}
        emptyMessage={t('selectors.entrypoint.empty')}
        items={entrypointItems}
        selectedId={
          project.entrypoint ? `record:${project.entrypoint.kind}s:${project.entrypoint.id}` : null
        }
        onSelect={(item) => {
          if (!item.collection || !item.entityId) return;
          if (
            item.collection === 'rooms' ||
            item.collection === 'scenes' ||
            item.collection === 'dialogues'
          ) {
            setEntrypoint({
              kind: item.collection.slice(0, -1) as 'room' | 'scene' | 'dialogue',
              id: item.entityId,
            });
          }
        }}
        onOpenChange={setEntrypointSelectorOpen}
      />
      <SearchSelectorDialog
        open={bootstrapModuleSelectorOpen}
        title="Choose Bootstrap Module"
        placeholder="Search Script Modules..."
        emptyMessage="No Script Modules found."
        items={scriptItems}
        selectedId={`record:scripts:${project.bootstrapModule.$ref.id}`}
        onSelect={(item) => {
          if (item.collection !== 'scripts' || !item.entityId) return;
          runProjectCommand(
            'project.setBootstrapModule',
            { scriptId: item.entityId },
            'Set Bootstrap Module',
          );
        }}
        onOpenChange={setBootstrapModuleSelectorOpen}
      />
      <SearchSelectorDialog
        open={!!systemLayoutSelectorRole}
        title={
          systemLayoutSelectorRole
            ? `Choose ${systemLayoutRoleLabels[systemLayoutSelectorRole]}`
            : 'Choose system layout'
        }
        placeholder="Search layouts..."
        emptyMessage="No layouts found."
        items={layoutItems}
        selectedId={
          systemLayoutSelectorRole
            ? systemLayoutSelectedId(
                systemLayoutSelectorRole,
                getSystemLayoutSetting(project, systemLayoutSelectorRole)?.$ref.id,
              )
            : null
        }
        onSelect={(item) => {
          if (!systemLayoutSelectorRole || !item.entityId) return;
          setSystemLayout(systemLayoutSelectorRole, item.entityId);
        }}
        onOpenChange={(open) => setSystemLayoutSelectorRole(open ? systemLayoutSelectorRole : null)}
      />
      <Dialog open={resolutionDialogOpen} onOpenChange={setResolutionDialogOpen}>
        <DialogPopup>
          <DialogTitle>Change Reference Resolution</DialogTitle>
          <DialogDescription>
            This changes the project-wide authored world canvas. Existing source assets are not
            rewritten. Confirm both integer dimensions from 1 through{' '}
            {MAX_REFERENCE_RESOLUTION_DIMENSION.toLocaleString()} to apply one undoable settings
            command.
          </DialogDescription>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="reference-resolution-width">Width</Label>
              <Input
                id="reference-resolution-width"
                autoFocus
                inputMode="numeric"
                value={resolutionWidth}
                aria-invalid={resolutionWidth.length > 0 && !/^\d+$/.test(resolutionWidth)}
                onChange={(event) => setResolutionWidth(event.currentTarget.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reference-resolution-height">Height</Label>
              <Input
                id="reference-resolution-height"
                inputMode="numeric"
                value={resolutionHeight}
                aria-invalid={resolutionHeight.length > 0 && !/^\d+$/.test(resolutionHeight)}
                onChange={(event) => setResolutionHeight(event.currentTarget.value)}
              />
            </div>
          </div>
          {!resolutionDialogValid ? (
            <p className="text-xs text-destructive">
              Width and height must both be integers from 1 through{' '}
              {MAX_REFERENCE_RESOLUTION_DIMENSION.toLocaleString()}.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResolutionDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!resolutionDialogValid}
              onClick={() => {
                if (
                  resolutionDialogValid &&
                  setReferenceResolution(parsedResolutionWidth, parsedResolutionHeight)
                )
                  setResolutionDialogOpen(false);
              }}
            >
              Confirm Resolution Change
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </CategorizedEditorLayout>
  );
}
