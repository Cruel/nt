import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { useCommandStore } from '@/commands/command-store';
import { MUTATION_SURFACE_ATTRIBUTIONS } from '@/project/save-unit-registry';
import { usePreferencesStore } from '@/stores/preferences-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { buildProjectSettingsTab, buildSettingsTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsForEditing } from '../../shared/project-schema/authoring-project-settings';
import {
  defaultPackageOutputFileName,
  runtimeExportProfileForPlatform,
  selectedExportProfile,
  type ExportProfileData,
} from '../../shared/project-schema/authoring-export';
import {
  prepareRuntimeArtifact,
  hasAuthoringShadersOrMaterials,
  type RuntimeArtifactAssessment,
} from '../../shared/runtime-artifact-preparation';
import { editorProjectStateFromProject } from '@/workbench/project-editor-state';
import {
  classifyProjectValidationDiagnostics,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import { derivedPlatformCapabilities } from '../../shared/project-schema/platform-deployment';
import {
  defaultPlatformExportProfile,
  resolveAssetMemoryPolicy,
  PLAYER_RUNTIME_API_VERSION,
  parsePlatformExportProfile,
  parseProjectPlatformExportSettings,
  userSigningProfileToExportSigningState,
  type ExportPlatform,
  type AssetMemoryProfile,
  type PlatformExportProfile,
  type ProjectPlatformExportSettings,
  type UserExportConfig,
} from '../../shared/project-schema/platform-export-contracts';
import { COMPILED_PROJECT_FORMAT_VERSION } from '../../shared/project-schema/compiled-project';
import { runPackageExportWorkflow } from './package-export-workflow';
import { usePackageExportStore } from './package-export-store';
import {
  cancelPlatformStageWorkflow,
  runProjectPlatformExportWorkflow,
} from './platform-export-workflow';
import { resolvePlatformExportDiagnosticTarget } from './platform-export-navigation';
import { evaluatePlatformExportReadiness } from './platform-export-readiness';
import { rendererRuntimeArtifactPaths } from './runtime-artifact-adapters';
import { useTemplateRegistryStore } from './template-registry-store';
import { hostPathDirname, joinHostPath } from '../host-filesystem-path';

interface PackageExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: AuthoringProject | null;
  projectRoot: string | null;
  projectFilePath: string | null;
  embedded?: boolean;
  initialMode?: ExportMode;
  profileManagementOnly?: boolean;
}

type ExportMode = 'runtime' | 'platform';
type ProfileEditMode = 'none' | 'creating-identity' | 'creating-config' | 'editing';

const webBasePathPattern = /^\/$|^\/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*\/$/;

function ExportSurface({
  embedded,
  open,
  onOpenChange,
  children,
}: {
  embedded: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  if (embedded) return <div className="h-full min-h-0 bg-background">{children}</div>;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-h-[90vh] max-w-5xl overflow-hidden">{children}</DialogPopup>
    </Dialog>
  );
}

function defaultRuntimeOutput(
  project: AuthoringProject,
  projectRoot: string | null,
  projectFilePath: string | null,
) {
  const root = projectRoot ?? hostPathDirname(projectFilePath) ?? '';
  const relative = joinHostPath('dist', defaultPackageOutputFileName(project));
  return root ? joinHostPath(root, relative) : relative;
}

function profileOutputSlug(label: string) {
  return (
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'export'
  );
}

function defaultPlatformOutput(projectRoot: string | null, profile: PlatformExportProfile) {
  const relative = joinHostPath('dist', profileOutputSlug(profile.label));
  return projectRoot ? joinHostPath(projectRoot, relative) : relative;
}

function platformDisplayName(target: ExportPlatform) {
  if (target === 'windows') return 'Windows';
  if (target === 'linux') return 'Linux';
  if (target === 'macos') return 'macOS';
  if (target === 'web') return 'Web';
  return 'Android';
}

function platformMarker(target: ExportPlatform) {
  if (target === 'windows') return 'W';
  if (target === 'linux') return 'L';
  if (target === 'macos') return 'M';
  if (target === 'web') return 'Web';
  return 'A';
}

function profileArtifact(profile: PlatformExportProfile) {
  if (profile.target === 'web') return profile.web.artifact;
  if (profile.target === 'android') return profile.android.artifact;
  return profile.desktop.artifact;
}

function profileSummary(
  profile: PlatformExportProfile,
  labels: Readonly<{ debug: string; release: string }>,
) {
  const parts = [platformDisplayName(profile.target)];
  parts.push(profile.buildFlavor === 'debug' ? labels.debug : labels.release);
  parts.push(profileArtifact(profile));
  return parts.join(' · ');
}

function severityVariant(severity: ToolDiagnostic['severity']) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

function isProjectValidationDiagnostic(
  diagnostic: ToolDiagnostic,
): diagnostic is ProjectValidationDiagnostic {
  return (
    typeof (diagnostic as Partial<ProjectValidationDiagnostic>).code === 'string' &&
    Array.isArray((diagnostic as Partial<ProjectValidationDiagnostic>).boundaries) &&
    Array.isArray((diagnostic as Partial<ProjectValidationDiagnostic>).ownerPaths)
  );
}

function DiagnosticPreview({
  title,
  diagnostics,
  project,
  actions,
}: {
  title: string;
  diagnostics: ToolDiagnostic[];
  project?: AuthoringProject;
  actions?: React.ReactNode;
}) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="rounded border p-3 text-xs">
      <div className="mb-2 font-medium">{title}</div>
      <div className="space-y-2">
        {diagnostics.slice(0, 6).map((diagnostic, index) => {
          const target =
            project && isProjectValidationDiagnostic(diagnostic)
              ? resolvePlatformExportDiagnosticTarget(project, diagnostic)
              : null;
          const content = (
            <>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge variant={severityVariant(diagnostic.severity)}>{diagnostic.severity}</Badge>
                <span>{diagnostic.message}</span>
              </div>
            </>
          );
          return target ? (
            <button
              key={`${diagnostic.path}-${diagnostic.message}-${index}`}
              type="button"
              className="block w-full rounded bg-muted/40 p-2 text-left hover:bg-muted"
              onClick={() => navigateToWorkbenchTarget(target)}
            >
              {content}
            </button>
          ) : (
            <div
              key={`${diagnostic.path}-${diagnostic.message}-${index}`}
              className="rounded bg-muted/40 p-2"
            >
              {content}
            </div>
          );
        })}
      </div>
      {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

function profileSettings(project: AuthoringProject): ProjectPlatformExportSettings {
  return parseProjectPlatformExportSettings({
    profiles: project.export.profiles,
    assetMemoryPolicies: project.export.assetMemoryPolicies,
  });
}

function assetMemorySelectionValue(selection: AssetMemoryProfile): string {
  return selection.kind === 'builtin'
    ? `builtin:${selection.preset}`
    : `policy:${selection.policyId}`;
}

function assetMemorySelectionFromValue(value: string): AssetMemoryProfile {
  if (value.startsWith('policy:'))
    return { kind: 'policy', policyId: value.slice('policy:'.length) };
  const preset = value.slice('builtin:'.length);
  return {
    kind: 'builtin',
    preset: preset === 'low' || preset === 'high' ? preset : 'balanced',
  };
}

function formatMemoryMiB(bytes: number) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

function persistRuntimeProfile(_project: AuthoringProject, profile: ExportProfileData) {
  return useCommandStore.getState().executeCommand({
    type: 'project.replaceAtPath',
    label: 'Update runtime export settings',
    payload: { path: '/export/runtime', value: profile },
    ...MUTATION_SURFACE_ATTRIBUTIONS.exportProfileEditing,
  });
}

function persistPlatformSettings(
  _project: AuthoringProject,
  settings: ProjectPlatformExportSettings,
) {
  return useCommandStore.getState().executeCommand({
    type: 'project.replaceAtPath',
    label: 'Update platform export profiles',
    payload: { path: '/export/profiles', value: settings.profiles },
    ...MUTATION_SURFACE_ATTRIBUTIONS.exportProfileEditing,
  });
}

function iconSourcePath(project: AuthoringProject, projectRoot: string | null) {
  const icon = projectSettingsForEditing(project).app.icon;
  if (!icon || !projectRoot) return undefined;
  const data = parseAssetData(project.assets[icon.$ref.id]?.data);
  return data ? joinHostPath(projectRoot, data.source.path) : undefined;
}

function labelsEqual(left: string, right: string) {
  return left.trim().localeCompare(right.trim(), undefined, { sensitivity: 'base' }) === 0;
}

export function PackageExportDialog({
  open,
  onOpenChange,
  project,
  projectRoot,
  projectFilePath,
  embedded = false,
  initialMode = 'runtime',
}: PackageExportDialogProps) {
  const { t } = useTranslation(['workspace', 'settings']);
  const running = usePackageExportStore((state) => state.running);
  const stage = usePackageExportStore((state) => state.stage);
  const lastResult = usePackageExportStore((state) => state.lastResult);
  const developerMode = usePreferencesStore((state) => state.developerMode);
  const localState = usePreferencesStore((state) => state.exportPreferences);
  const setExportPreferences = usePreferencesStore((state) => state.setExportPreferences);

  const [mode, setMode] = useState<ExportMode>(initialMode);
  const [runtimeProfile, setRuntimeProfile] = useState<ExportProfileData | null>(null);
  const [platformSettings, setPlatformSettings] = useState<ProjectPlatformExportSettings | null>(
    null,
  );
  const [selectedPlatformProfileId, setSelectedPlatformProfileId] = useState<string | null>(null);
  const [runtimeOutput, setRuntimeOutput] = useState('');
  const [platformOutput, setPlatformOutput] = useState('');
  const templates = useTemplateRegistryStore((state) => state.templates);
  const templatesLoaded = useTemplateRegistryStore((state) => state.loaded);
  const templateRegistryError = useTemplateRegistryStore((state) => state.error);
  const refreshTemplates = useTemplateRegistryStore((state) => state.refresh);
  const [selectedTemplateToken, setSelectedTemplateToken] = useState('');
  const [templateDiagnostics, setTemplateDiagnostics] = useState<ProjectValidationDiagnostic[]>([]);
  const [templateDownloadPending, setTemplateDownloadPending] = useState(false);
  const [userExportConfig, setUserExportConfig] = useState<UserExportConfig | null>(null);
  const [selectedSigningProfileId, setSelectedSigningProfileId] = useState('');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [identityConfirmationOpen, setIdentityConfirmationOpen] = useState(false);

  const [profileEditMode, setProfileEditMode] = useState<ProfileEditMode>('none');
  const [newProfileName, setNewProfileName] = useState('Windows');
  const [newProfileTarget, setNewProfileTarget] = useState<ExportPlatform>('windows');
  const [profileDraft, setProfileDraft] = useState<PlatformExportProfile | null>(null);

  function projectLocalKey() {
    return projectFilePath ?? projectRoot ?? 'unsaved';
  }

  function localProfileKey(profileId: string) {
    return `${projectLocalKey()}::${profileId}`;
  }

  function rememberSelectedProfile(profileId: string) {
    const current = usePreferencesStore.getState().exportPreferences.selectedProfileIds;
    setExportPreferences({
      selectedProfileIds: { ...current, [projectLocalKey()]: profileId },
    });
  }

  function outputForProfile(profile: PlatformExportProfile) {
    return (
      localState.profileOutputDirectories[localProfileKey(profile.id)] ||
      defaultPlatformOutput(projectRoot, profile)
    );
  }

  function rememberOutput(profileId: string, value: string) {
    const key = localProfileKey(profileId);
    const current = usePreferencesStore.getState().exportPreferences.profileOutputDirectories;
    setExportPreferences({
      profileOutputDirectories: { ...current, [key]: value },
    });
  }

  useEffect(() => {
    if (!open || !project) return;
    const nextRuntime = selectedExportProfile(project);
    const settings = profileSettings(project);
    const rememberedProfileId = localState.selectedProfileIds[projectLocalKey()];
    const rememberedProfile = settings.profiles.find((item) => item.id === rememberedProfileId);
    const selected =
      rememberedProfile ??
      [...settings.profiles].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true }),
      )[0] ??
      null;
    setMode(
      rememberedProfileId === 'runtime-package'
        ? 'runtime'
        : rememberedProfile
          ? 'platform'
          : initialMode,
    );
    setRuntimeProfile(nextRuntime);
    setRuntimeOutput(
      localState.profileOutputDirectories[localProfileKey('runtime-package')] ||
        defaultRuntimeOutput(project, projectRoot, projectFilePath),
    );
    setPlatformSettings(settings);
    setSelectedPlatformProfileId(selected?.id ?? null);
    setPlatformOutput(selected ? outputForProfile(selected) : '');
    setSelectedTemplateToken(
      selected ? (localState.profileTemplateTokens[localProfileKey(selected.id)] ?? '') : '',
    );
    setSelectedSigningProfileId(
      selected ? (localState.profileSigningProfileIds[localProfileKey(selected.id)] ?? '') : '',
    );
    setProfileEditMode('none');
    setProfileDraft(null);
    void window.noveltea.loadUserExportConfig().then(setUserExportConfig);
  }, [open, project, projectRoot]); // oxlint-disable-line react-hooks/exhaustive-deps

  const selectedPlatformProfile = useMemo(() => {
    if (!platformSettings) return null;
    return platformSettings.profiles.find((item) => item.id === selectedPlatformProfileId) ?? null;
  }, [platformSettings, selectedPlatformProfileId]);

  const activeRuntimeProfile = runtimeProfile ?? (project ? selectedExportProfile(project) : null);
  const platformRuntimeProfile = useMemo(() => {
    if (!project || !selectedPlatformProfile) return null;
    return {
      ...runtimeExportProfileForPlatform(project, selectedPlatformProfile.target),
      excludeUnusedAssets: selectedPlatformProfile.excludeUnusedAssets,
      includeShaderSources: selectedPlatformProfile.includeShaderSources,
      stripShaderSources: !selectedPlatformProfile.includeShaderSources,
    };
  }, [project, selectedPlatformProfile]);
  const previewProfile =
    mode === 'platform' && platformRuntimeProfile ? platformRuntimeProfile : activeRuntimeProfile;
  const [preview, setPreview] = useState<RuntimeArtifactAssessment | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  useEffect(() => {
    let current = true;
    if (!project || !previewProfile) {
      setPreview(null);
      setPreviewPending(false);
      return () => {
        current = false;
      };
    }
    setPreviewPending(true);
    void prepareRuntimeArtifact({
      project,
      projectRoot,
      profile: previewProfile,
      intent: mode === 'platform' ? 'platform-preflight' : 'runtime-package-preflight',
      paths: rendererRuntimeArtifactPaths,
    }).then((result) => {
      if (!current) return;
      if (result.status !== 'cancelled') setPreview(result.assessment);
      setPreviewPending(false);
    });
    return () => {
      current = false;
    };
  }, [mode, project, projectRoot, previewProfile]);

  if (!project || !activeRuntimeProfile || !platformSettings) return null;

  const currentProject = project;
  const currentRuntimeProfile = activeRuntimeProfile;
  const currentPlatformSettings = platformSettings;
  const currentProjectSettings = projectSettingsForEditing(currentProject);
  const outputPath =
    runtimeOutput || defaultRuntimeOutput(currentProject, projectRoot, projectFilePath);
  const usesProjectShaders = hasAuthoringShadersOrMaterials(currentProject);
  const runtimeDiagnostics = preview?.runtimeDiagnostics ?? [];
  const blockingDiagnostics = preview?.runtimeBlockers ?? [];
  const failedResultDiagnostics =
    lastResult && !lastResult.success
      ? lastResult.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      : [];

  const templateChoices = selectedPlatformProfile
    ? templates.map((item) => ({
        item,
        compatibility: evaluateTemplateCompatibility(item.descriptor, {
          profile: selectedPlatformProfile,
          compiledProjectFormatVersion: COMPILED_PROJECT_FORMAT_VERSION,
          playerRuntimeApiVersion: PLAYER_RUNTIME_API_VERSION,
          shaderVariants: platformRuntimeProfile?.shaderVariants ?? [],
          graphicsBackends: [],
          capabilities: derivedPlatformCapabilities(selectedPlatformProfile.target),
          requiredFeatures: [],
        }),
      }))
    : [];
  const compatibleTemplateChoices = templateChoices.filter(
    ({ item, compatibility }) => item.status !== 'corrupted' && compatibility.compatible,
  );
  const template =
    compatibleTemplateChoices.find(
      ({ item }) =>
        `${item.descriptor.templateId}/${item.descriptor.buildId}` === selectedTemplateToken,
    )?.item ?? (compatibleTemplateChoices.length === 1 ? compatibleTemplateChoices[0]!.item : null);
  const templateRegistryDiagnostics = templateRegistryError
    ? classifyProjectValidationDiagnostics(
        [
          {
            code: 'template-registry-load-failed',
            severity: 'error' as const,
            category: 'template:template-registry-load-failed',
            path: '/template',
            message: templateRegistryError,
          },
        ],
        { producer: 'template' },
      )
    : [];
  const effectiveTemplateDiagnostics = [...templateRegistryDiagnostics, ...templateDiagnostics];

  const signingProfiles = selectedPlatformProfile
    ? (userExportConfig?.signingProfiles.filter(
        (item) => item.target === selectedPlatformProfile.target,
      ) ?? [])
    : [];
  const selectedSigningProfile = signingProfiles.find(
    (item) => item.id === selectedSigningProfileId,
  );
  const signingEnabled = selectedSigningProfile !== undefined;
  const toolchains = userExportConfig?.toolchains ?? {};
  const effectiveTemplateToken =
    selectedTemplateToken ||
    (template ? `${template.descriptor.templateId}/${template.descriptor.buildId}` : '');

  const readiness =
    preview && selectedPlatformProfile && templatesLoaded
      ? evaluatePlatformExportReadiness({
          runtimeExport: preview,
          commonIdentity: {
            displayName: currentProjectSettings.app.displayName,
            applicationId:
              selectedPlatformProfile.target === 'android'
                ? (currentProjectSettings.app.android.applicationId ??
                  currentProjectSettings.app.applicationId)
                : currentProjectSettings.app.applicationId,
            saveNamespace: currentProjectSettings.app.saveNamespace,
            versionName: currentProjectSettings.app.versionName,
            iconSourcePath: iconSourcePath(currentProject, projectRoot),
          },
          profile: selectedPlatformProfile,
          templateState: {
            templateToken: effectiveTemplateToken,
            diagnostics: effectiveTemplateDiagnostics,
          },
          toolchainState: toolchains,
          signingState: {
            windows: selectedSigningProfile?.target === 'windows' ? true : undefined,
            macos: selectedSigningProfile?.target === 'macos' ? true : undefined,
            android: selectedSigningProfile?.target === 'android' ? true : undefined,
          },
          signingRequested: signingEnabled,
          outputDirectory: platformOutput,
          lastSuccessfulIdentity:
            editorProjectStateFromProject(currentProject).lastSuccessfulPlatformExportIdentity,
        })
      : null;

  const platformBlockers = readiness?.blockers ?? [];
  const canExport =
    profileEditMode === 'none' &&
    !running &&
    !previewPending &&
    (mode === 'runtime'
      ? preview !== null && blockingDiagnostics.length === 0 && outputPath.trim().length > 0
      : templatesLoaded && !!selectedPlatformProfile && readiness?.ok === true && !!template);
  const activeBlockers = mode === 'runtime' ? blockingDiagnostics : platformBlockers;
  const hasProjectSettingsBlocker = activeBlockers.some(
    (diagnostic) =>
      diagnostic.path === '/entrypoint' ||
      diagnostic.path.startsWith('/settings/') ||
      diagnostic.path.startsWith('/project/'),
  );

  const platformReadinessGroups = selectedPlatformProfile
    ? [
        {
          key: 'runtime',
          title: t('settings:exportUi.runtimeReadiness'),
          diagnostics: readiness?.groups.runtimePackage ?? [],
        },
        {
          key: 'identity',
          title: t('settings:exportUi.commonIdentityReadiness'),
          diagnostics: readiness?.groups.commonIdentity ?? [],
        },
        {
          key: 'target',
          title: t('settings:exportUi.targetReadiness', {
            platform: platformDisplayName(selectedPlatformProfile.target),
          }),
          diagnostics: readiness?.groups.targetMetadata ?? [],
        },
        {
          key: 'environment',
          title: t('settings:exportUi.environmentReadiness'),
          diagnostics: readiness?.groups.environment ?? [],
        },
      ]
    : [];

  function commitPlatformSettings(next: ProjectPlatformExportSettings) {
    const result = persistPlatformSettings(currentProject, next);
    if (result.ok) setPlatformSettings(next);
  }

  function updateRuntimePackaging(patch: Partial<ExportProfileData>) {
    const next = {
      ...currentRuntimeProfile,
      ...patch,
      ...(patch.includeShaderSources !== undefined
        ? { stripShaderSources: !patch.includeShaderSources }
        : {}),
    };
    const result = persistRuntimeProfile(currentProject, next);
    if (result.ok) setRuntimeProfile(next);
  }

  function updatePlatformPackaging(patch: Partial<PlatformExportProfile>) {
    if (!selectedPlatformProfile) return;
    const next = { ...selectedPlatformProfile, ...patch } as PlatformExportProfile;
    commitPlatformSettings({
      ...currentPlatformSettings,
      profiles: currentPlatformSettings.profiles.map((item) =>
        item.id === selectedPlatformProfile.id ? next : item,
      ),
    });
  }

  function uniqueProfileLabel(base: string, excludeId?: string) {
    const existing = currentPlatformSettings.profiles.filter((item) => item.id !== excludeId);
    if (!existing.some((item) => labelsEqual(item.label, base))) return base;
    let index = 2;
    while (existing.some((item) => labelsEqual(item.label, `${base} (${index})`))) index++;
    return `${base} (${index})`;
  }

  function uniqueProfileId(target: ExportPlatform) {
    if (!currentPlatformSettings.profiles.some((item) => item.id === target)) return target;
    let index = 2;
    while (currentPlatformSettings.profiles.some((item) => item.id === `${target}-${index}`))
      index++;
    return `${target}-${index}`;
  }

  function selectRuntimeProfile() {
    if (profileEditMode !== 'none') return;
    setMode('runtime');
    rememberSelectedProfile('runtime-package');
  }

  function selectPlatformProfile(id: string) {
    if (profileEditMode !== 'none') return;
    const selected = currentPlatformSettings.profiles.find((item) => item.id === id);
    if (!selected) return;
    setMode('platform');
    rememberSelectedProfile(id);
    setSelectedPlatformProfileId(id);
    setPlatformOutput(outputForProfile(selected));
    const key = localProfileKey(id);
    setSelectedTemplateToken(localState.profileTemplateTokens[key] ?? '');
    setSelectedSigningProfileId(localState.profileSigningProfileIds[key] ?? '');
  }

  function beginCreateProfile() {
    if (profileEditMode !== 'none') return;
    setNewProfileTarget('windows');
    setNewProfileName(uniqueProfileLabel('Windows'));
    setProfileDraft(null);
    setProfileEditMode('creating-identity');
  }

  function continueCreateProfile() {
    const label = newProfileName.trim();
    if (!label || currentPlatformSettings.profiles.some((item) => labelsEqual(item.label, label)))
      return;
    setProfileDraft(
      parsePlatformExportProfile({
        ...defaultPlatformExportProfile(newProfileTarget),
        id: uniqueProfileId(newProfileTarget),
        label,
      }),
    );
    setProfileEditMode('creating-config');
  }

  function beginEditProfile() {
    if (!selectedPlatformProfile || profileEditMode !== 'none') return;
    setProfileDraft(structuredClone(selectedPlatformProfile));
    setProfileEditMode('editing');
  }

  function profileDraftNameIsValid() {
    if (!profileDraft?.label.trim()) return false;
    return !currentPlatformSettings.profiles.some(
      (item) => item.id !== profileDraft.id && labelsEqual(item.label, profileDraft.label),
    );
  }

  function finishProfileEditing() {
    if (!profileDraft || !profileDraftNameIsValid()) return;
    if (profileEditMode === 'creating-config') {
      const next = {
        ...currentPlatformSettings,
        profiles: [...currentPlatformSettings.profiles, profileDraft],
      };
      commitPlatformSettings(next);
      setSelectedPlatformProfileId(profileDraft.id);
      setMode('platform');
      rememberSelectedProfile(profileDraft.id);
      setPlatformOutput(defaultPlatformOutput(projectRoot, profileDraft));
      setSelectedTemplateToken('');
      setSelectedSigningProfileId('');
    } else if (profileEditMode === 'editing') {
      commitPlatformSettings({
        ...currentPlatformSettings,
        profiles: currentPlatformSettings.profiles.map((item) =>
          item.id === profileDraft.id ? profileDraft : item,
        ),
      });
      setPlatformOutput(outputForProfile(profileDraft));
    }
    setProfileDraft(null);
    setProfileEditMode('none');
  }

  function cancelProfileEditing() {
    setProfileDraft(null);
    setProfileEditMode('none');
  }

  function duplicateProfile() {
    if (!selectedPlatformProfile || profileEditMode !== 'none') return;
    const base = selectedPlatformProfile.label.replace(/ \(\d+\)$/u, '');
    const next = parsePlatformExportProfile({
      ...structuredClone(selectedPlatformProfile),
      id: uniqueProfileId(selectedPlatformProfile.target),
      label: uniqueProfileLabel(base),
    });
    commitPlatformSettings({
      ...currentPlatformSettings,
      profiles: [...currentPlatformSettings.profiles, next],
    });
    setSelectedPlatformProfileId(next.id);
    setMode('platform');
    rememberSelectedProfile(next.id);
    setPlatformOutput(defaultPlatformOutput(projectRoot, next));
    setSelectedTemplateToken('');
    setSelectedSigningProfileId('');
  }

  function deleteProfile() {
    if (!selectedPlatformProfile || profileEditMode !== 'none') return;
    const key = localProfileKey(selectedPlatformProfile.id);
    const outputDirectories = { ...localState.profileOutputDirectories };
    const templateTokens = { ...localState.profileTemplateTokens };
    const signingIds = { ...localState.profileSigningProfileIds };
    delete outputDirectories[key];
    delete templateTokens[key];
    delete signingIds[key];
    setExportPreferences({
      profileOutputDirectories: outputDirectories,
      profileTemplateTokens: templateTokens,
      profileSigningProfileIds: signingIds,
    });

    const profiles = currentPlatformSettings.profiles.filter(
      (item) => item.id !== selectedPlatformProfile.id,
    );
    if (profiles.length === 0) {
      const nextSettings = { ...currentPlatformSettings, profiles: [] };
      const result = persistPlatformSettings(currentProject, nextSettings);
      if (!result.ok) return;
      setPlatformSettings(nextSettings);
      setSelectedPlatformProfileId(null);
      setMode('runtime');
      rememberSelectedProfile('runtime-package');
      setPlatformOutput('');
    } else {
      const selected = [...profiles].sort((a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true }),
      )[0]!;
      commitPlatformSettings({ ...currentPlatformSettings, profiles });
      setSelectedPlatformProfileId(selected.id);
      rememberSelectedProfile(selected.id);
      setPlatformOutput(outputForProfile(selected));
    }
    setTemplateDiagnostics([]);
    setSelectedTemplateToken('');
    setSelectedSigningProfileId('');
  }

  async function chooseOutput() {
    if (mode === 'runtime') {
      const selected = await window.noveltea.selectPackageOutputPath(outputPath);
      if (selected) {
        setRuntimeOutput(selected);
        rememberOutput('runtime-package', selected);
      }
      return;
    }
    const selected = await window.noveltea.selectDirectory({
      title: t('settings:exportUi.selectPlatformDirectory'),
      defaultPath: platformOutput,
    });
    if (selected && selectedPlatformProfile) {
      setPlatformOutput(selected);
      rememberOutput(selectedPlatformProfile.id, selected);
    }
  }

  async function installTemplate() {
    if (!selectedPlatformProfile) return;
    const archivePath = await window.noveltea.selectTemplateArchivePath();
    if (!archivePath) return;
    let installed = await window.noveltea.installPlayerTemplate({
      archivePath,
      origin: archivePath,
    });
    if (
      !installed.success &&
      installed.diagnostics.some((item) => item.message.includes('already installed')) &&
      window.confirm(t('platformExport.confirmations.replaceTemplate'))
    ) {
      installed = await window.noveltea.installPlayerTemplate({
        archivePath,
        origin: archivePath,
        force: true,
      });
    }
    if (!installed.success) {
      setTemplateDiagnostics(
        classifyProjectValidationDiagnostics(
          installed.diagnostics.map((item) => ({
            code: item.code,
            severity: 'error' as const,
            category: `template:${item.code}`,
            path: item.path,
            message: item.message,
          })),
          { producer: 'template' },
        ),
      );
      return;
    }
    setTemplateDiagnostics([]);
    await refreshTemplates();
  }

  async function downloadTemplate() {
    if (!selectedPlatformProfile) return;
    setTemplateDownloadPending(true);
    try {
      const result = await window.noveltea.downloadPlayerTemplate({
        platform: selectedPlatformProfile.target,
        architecture: selectedPlatformProfile.architecture,
        buildFlavor: selectedPlatformProfile.buildFlavor,
      });
      if (!result.success) {
        setTemplateDiagnostics(
          classifyProjectValidationDiagnostics(
            result.diagnostics.map((item) => ({
              code: item.code,
              severity: 'error' as const,
              category: `template:${item.code}`,
              path: item.path,
              message: item.message,
            })),
            { producer: 'template' },
          ),
        );
        return;
      }
      setTemplateDiagnostics([]);
      await refreshTemplates();
    } finally {
      setTemplateDownloadPending(false);
    }
  }

  async function runExport() {
    if (!canExport) return;
    if (mode === 'runtime') {
      await runPackageExportWorkflow({
        project: currentProject,
        projectRoot,
        outputPath,
        profile: { ...currentRuntimeProfile, outputPath },
      });
      return;
    }
    if (readiness?.requiresIdentityConfirmation) {
      setIdentityConfirmationOpen(true);
      return;
    }
    await runPlayablePlatformExport();
  }

  async function runPlayablePlatformExport() {
    if (!selectedPlatformProfile || !template) return;
    const selectedTemplate =
      templates.find(
        (candidate) =>
          `${candidate.descriptor.templateId}/${candidate.descriptor.buildId}` ===
          selectedTemplateToken,
      ) ?? template;
    const allowUntrustedTemplate = selectedTemplate.entry.trust !== 'official';
    if (
      allowUntrustedTemplate &&
      !window.confirm(
        t('platformExport.confirmations.useUntrustedTemplate', {
          templateId: selectedTemplate.descriptor.templateId,
          buildId: selectedTemplate.descriptor.buildId,
        }),
      )
    )
      return;

    const nextOperationId = `editor-${Date.now()}`;
    setOperationId(nextOperationId);
    const signing = selectedSigningProfile
      ? userSigningProfileToExportSigningState(selectedSigningProfile)
      : {};
    const exportRequest = {
      operationId: nextOperationId,
      project: currentProject,
      projectRoot: projectRoot ?? undefined,
      profileId: selectedPlatformProfile.id,
      templateToken: `${selectedTemplate.descriptor.templateId}/${selectedTemplate.descriptor.buildId}`,
      outputDirectory: platformOutput,
      sign: signingEnabled,
      allowUntrustedTemplate,
      localState: {
        ...toolchains,
        ...(Object.keys(signing).length > 0 ? { signing } : {}),
      },
    };
    let result = await runProjectPlatformExportWorkflow(exportRequest, selectedPlatformProfile);
    if (
      !result.success &&
      result.diagnostics.some((item) => item.code === 'platform-output-exists') &&
      window.confirm(t('platformExport.confirmations.replaceArtifacts'))
    ) {
      result = await runProjectPlatformExportWorkflow(
        { ...exportRequest, operationId: `${nextOperationId}-force`, force: true },
        selectedPlatformProfile,
      );
    }
    setOperationId(null);
    void result;
  }

  async function cancelExport() {
    if (!operationId) return;
    await cancelPlatformStageWorkflow(operationId);
  }

  const sortedProfiles = [...currentPlatformSettings.profiles].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
  const editingProfile = profileEditMode === 'creating-config' || profileEditMode === 'editing';
  const sidebarDisabled = profileEditMode !== 'none';
  const draftAssetMemoryPolicyId =
    profileDraft?.assetMemory.kind === 'policy' ? profileDraft.assetMemory.policyId : null;
  const draftNamedAssetMemoryPolicy = draftAssetMemoryPolicyId
    ? currentPlatformSettings.assetMemoryPolicies.find(
        (policy) => policy.id === draftAssetMemoryPolicyId,
      )
    : null;
  const draftResolvedAssetMemory = profileDraft
    ? resolveAssetMemoryPolicy(
        profileDraft.target,
        profileDraft.assetMemory,
        currentPlatformSettings.assetMemoryPolicies,
      )
    : null;

  const profileEditor = editingProfile && profileDraft && (
    <div className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">
          {profileEditMode === 'creating-config'
            ? t('settings:exportUi.createProfile')
            : t('settings:exportUi.profileEdit')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('settings:exportUi.platformValue', {
            platform: platformDisplayName(profileDraft.target),
          })}
        </p>
      </div>
      <div className="grid gap-4 rounded border p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="profile-name">{t('settings:exportUi.name')}</Label>
          <Input
            id="profile-name"
            value={profileDraft.label}
            onChange={(event) =>
              setProfileDraft({ ...profileDraft, label: event.currentTarget.value })
            }
          />
          {!profileDraftNameIsValid() ? (
            <span className="text-xs text-destructive">{t('settings:exportUi.nameInvalid')}</span>
          ) : null}
        </div>

        {developerMode ? (
          <div className="grid gap-1.5">
            <Label>{t('settings:exportUi.buildFlavor')}</Label>
            <select
              className="h-9 rounded border bg-background px-2 text-sm"
              value={profileDraft.buildFlavor}
              onChange={(event) =>
                setProfileDraft({
                  ...profileDraft,
                  buildFlavor: event.currentTarget.value as 'debug' | 'release',
                })
              }
            >
              <option value="release">{t('settings:exportUi.release')}</option>
              <option value="debug">{t('settings:exportUi.debug')}</option>
            </select>
          </div>
        ) : null}

        {profileDraft.target === 'linux' ? (
          <div className="grid gap-1.5">
            <Label>{t('settings:exportUi.artifact')}</Label>
            <select
              className="h-9 rounded border bg-background px-2 text-sm"
              value={profileDraft.desktop.artifact}
              onChange={(event) =>
                setProfileDraft({
                  ...profileDraft,
                  desktop: {
                    ...profileDraft.desktop,
                    artifact: event.currentTarget.value as 'tar' | 'zip' | 'appimage',
                  },
                })
              }
            >
              <option value="tar">tar.gz</option>
              <option value="zip">ZIP</option>
              <option value="appimage">AppImage</option>
            </select>
          </div>
        ) : null}

        {profileDraft.target === 'web' ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={profileDraft.web.threaded}
                onChange={(event) =>
                  setProfileDraft({
                    ...profileDraft,
                    web: { ...profileDraft.web, threaded: event.currentTarget.checked },
                  })
                }
              />
              {t('settings:exportUi.webThreading')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={profileDraft.web.pwa}
                onChange={(event) => {
                  const pwa = event.currentTarget.checked;
                  setProfileDraft({
                    ...profileDraft,
                    web: {
                      ...profileDraft.web,
                      pwa,
                      serviceWorker: pwa ? 'offline' : 'disabled',
                    },
                  });
                }}
              />
              {t('settings:exportUi.progressiveWebApp')}
            </label>
            <div className="grid gap-1.5">
              <Label htmlFor="profile-web-base-path">{t('settings:exportUi.basePath')}</Label>
              <Input
                id="profile-web-base-path"
                value={profileDraft.web.basePath}
                onChange={(event) =>
                  setProfileDraft({
                    ...profileDraft,
                    web: { ...profileDraft.web, basePath: event.currentTarget.value },
                  })
                }
              />
              {!webBasePathPattern.test(profileDraft.web.basePath) ? (
                <span className="text-xs text-destructive">
                  {t('settings:exportUi.basePathInvalid')}
                </span>
              ) : null}
            </div>
            {profileDraft.web.pwa ? (
              <div className="grid gap-1.5">
                <Label>{t('settings:exportUi.displayMode')}</Label>
                <select
                  className="h-9 rounded border bg-background px-2 text-sm"
                  value={profileDraft.web.display}
                  onChange={(event) =>
                    setProfileDraft({
                      ...profileDraft,
                      web: {
                        ...profileDraft.web,
                        display: event.currentTarget.value as typeof profileDraft.web.display,
                      },
                    })
                  }
                >
                  <option value="standalone">{t('settings:exportUi.displayStandalone')}</option>
                  <option value="fullscreen">{t('settings:exportUi.displayFullscreen')}</option>
                  <option value="minimal-ui">{t('settings:exportUi.displayMinimalUi')}</option>
                  <option value="browser">{t('settings:exportUi.displayBrowser')}</option>
                </select>
              </div>
            ) : null}
          </>
        ) : null}

        {profileDraft.target === 'android' ? (
          <div className="grid gap-1.5">
            <Label>{t('settings:exportUi.artifact')}</Label>
            <select
              className="h-9 rounded border bg-background px-2 text-sm"
              value={profileDraft.android.artifact}
              onChange={(event) =>
                setProfileDraft({
                  ...profileDraft,
                  android: {
                    ...profileDraft.android,
                    artifact: event.currentTarget.value as 'apk' | 'aab' | 'both',
                  },
                })
              }
            >
              <option value="apk">APK</option>
              <option value="aab">AAB</option>
              <option value="both">{t('settings:exportUi.apkAndAab')}</option>
            </select>
          </div>
        ) : null}

        <div className="grid gap-3 rounded border p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label htmlFor="profile-asset-memory">Asset memory</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Select the target-relative memory policy used by this player export.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                navigateToWorkbenchTarget({
                  tab: buildProjectSettingsTab(),
                  target: { id: 'projectSettings.assetMemoryPolicies' },
                })
              }
            >
              Manage policies…
            </Button>
          </div>
          <select
            id="profile-asset-memory"
            className="h-9 rounded border bg-background px-2 text-sm"
            value={assetMemorySelectionValue(profileDraft.assetMemory)}
            onChange={(event) =>
              setProfileDraft({
                ...profileDraft,
                assetMemory: assetMemorySelectionFromValue(event.currentTarget.value),
              })
            }
          >
            <option value="builtin:low">Low</option>
            <option value="builtin:balanced">Balanced</option>
            <option value="builtin:high">High</option>
            {currentPlatformSettings.assetMemoryPolicies.length > 0 ? (
              <optgroup label="Project policies">
                {currentPlatformSettings.assetMemoryPolicies.map((policy) => (
                  <option key={policy.id} value={`policy:${policy.id}`}>
                    {policy.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {draftNamedAssetMemoryPolicy ? (
            <p className="text-xs text-muted-foreground">
              Based on {draftNamedAssetMemoryPolicy.basePreset[0]!.toUpperCase()}
              {draftNamedAssetMemoryPolicy.basePreset.slice(1)}.
            </p>
          ) : null}
          {draftResolvedAssetMemory ? (
            <div className="grid gap-2 text-xs sm:grid-cols-5">
              <div>
                <div className="text-muted-foreground">Prepared CPU</div>
                <div className="font-medium">
                  {formatMemoryMiB(draftResolvedAssetMemory.preparedCpuBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">GPU</div>
                <div className="font-medium">
                  {formatMemoryMiB(draftResolvedAssetMemory.gpuBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Audio</div>
                <div className="font-medium">
                  {formatMemoryMiB(draftResolvedAssetMemory.audioBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Temporary</div>
                <div className="font-medium">
                  {formatMemoryMiB(draftResolvedAssetMemory.temporaryBytes)}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Warm allowance</div>
                <div className="font-medium">
                  {draftResolvedAssetMemory.prefetchAllowancePercent}%
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {developerMode ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={profileDraft.includeDebugSymbols}
              onChange={(event) =>
                setProfileDraft({
                  ...profileDraft,
                  includeDebugSymbols: event.currentTarget.checked,
                })
              }
            />
            {t('settings:exportUi.debugSymbols')}
          </label>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={cancelProfileEditing}>
          {t('settings:exportUi.cancel')}
        </Button>
        <Button
          onClick={finishProfileEditing}
          disabled={
            !profileDraftNameIsValid() ||
            (profileDraft.target === 'web' && !webBasePathPattern.test(profileDraft.web.basePath))
          }
        >
          {profileEditMode === 'creating-config'
            ? t('settings:exportUi.createProfile')
            : t('settings:exportUi.done')}
        </Button>
      </div>
    </div>
  );

  const createIdentity = profileEditMode === 'creating-identity' && (
    <div className="grid gap-5">
      <div>
        <h2 className="text-lg font-semibold">{t('settings:exportUi.newProfile')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings:exportUi.createDescription')}</p>
      </div>
      <div className="grid gap-4 rounded border p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="new-profile-name">{t('settings:exportUi.name')}</Label>
          <Input
            id="new-profile-name"
            value={newProfileName}
            onChange={(event) => setNewProfileName(event.currentTarget.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-profile-platform">{t('settings:exportUi.platform')}</Label>
          <select
            id="new-profile-platform"
            className="h-9 rounded border bg-background px-2 text-sm"
            value={newProfileTarget}
            onChange={(event) => {
              const target = event.currentTarget.value as ExportPlatform;
              setNewProfileTarget(target);
              setNewProfileName(uniqueProfileLabel(platformDisplayName(target)));
            }}
          >
            {(['windows', 'linux', 'macos', 'web', 'android'] as ExportPlatform[]).map((target) => (
              <option key={target} value={target}>
                {platformDisplayName(target)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={cancelProfileEditing}>
          {t('settings:exportUi.cancel')}
        </Button>
        <Button
          onClick={continueCreateProfile}
          disabled={
            !newProfileName.trim() ||
            platformSettings.profiles.some((item) => labelsEqual(item.label, newProfileName))
          }
        >
          {t('settings:exportUi.next')}
        </Button>
      </div>
    </div>
  );

  const developerOptions = developerMode ? (
    <div className="grid gap-2 rounded border border-dashed p-3 text-xs">
      <div className="font-medium">{t('settings:exportUi.developer')}</div>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={
            mode === 'runtime'
              ? activeRuntimeProfile.excludeUnusedAssets
              : (selectedPlatformProfile?.excludeUnusedAssets ?? true)
          }
          onChange={(event) => {
            if (mode === 'runtime')
              updateRuntimePackaging({ excludeUnusedAssets: event.currentTarget.checked });
            else updatePlatformPackaging({ excludeUnusedAssets: event.currentTarget.checked });
          }}
        />
        {t('settings:exportUi.excludeUnusedAssets')}
      </label>
      {usesProjectShaders ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={
              mode === 'runtime'
                ? activeRuntimeProfile.includeShaderSources
                : (selectedPlatformProfile?.includeShaderSources ?? false)
            }
            onChange={(event) => {
              if (mode === 'runtime')
                updateRuntimePackaging({ includeShaderSources: event.currentTarget.checked });
              else updatePlatformPackaging({ includeShaderSources: event.currentTarget.checked });
            }}
          />
          {t('settings:exportUi.includeShaderSources')}
        </label>
      ) : null}
    </div>
  ) : null;

  const missingTemplateActions =
    mode === 'platform' && templatesLoaded && compatibleTemplateChoices.length === 0 ? (
      <>
        <Button
          size="sm"
          variant="outline"
          disabled={templateDownloadPending}
          onClick={downloadTemplate}
        >
          {templateDownloadPending
            ? t('settings:exportUi.downloading')
            : t('settings:exportUi.download')}
        </Button>
        <Button size="sm" variant="outline" onClick={installTemplate}>
          {t('settings:exportUi.install')}
        </Button>
      </>
    ) : null;

  const normalExportPane = (
    <div className="grid gap-4">
      {mode === 'runtime' ? (
        <div>
          <h2 className="text-lg font-semibold">{t('settings:exportUi.runtimePackage')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('settings:exportUi.runtimeDescription')}
          </p>
        </div>
      ) : selectedPlatformProfile ? (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">{selectedPlatformProfile.label}</h2>
            <p className="text-sm text-muted-foreground">
              {profileSummary(selectedPlatformProfile, {
                debug: t('settings:exportUi.debug'),
                release: t('settings:exportUi.release'),
              })}
            </p>
          </div>
          <Button variant="outline" onClick={beginEditProfile}>
            {t('settings:exportUi.editProfile')}
          </Button>
        </div>
      ) : (
        <div className="grid place-items-center gap-3 rounded border border-dashed p-10 text-center">
          <div className="font-medium">{t('settings:exportUi.noProfiles')}</div>
          <p className="max-w-md text-sm text-muted-foreground">
            {t('settings:exportUi.noProfilesDescription')}
          </p>
          <Button onClick={beginCreateProfile}>{t('settings:exportUi.addProfile')}</Button>
        </div>
      )}

      {mode === 'runtime' || selectedPlatformProfile ? (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="export-output-path">
              {mode === 'runtime'
                ? t('settings:exportUi.outputFile')
                : t('settings:exportUi.outputDirectory')}
            </Label>
            <div className="flex gap-2">
              <Input
                id="export-output-path"
                className="font-mono text-[11px]"
                value={mode === 'runtime' ? outputPath : platformOutput}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  if (mode === 'runtime') {
                    setRuntimeOutput(value);
                    rememberOutput('runtime-package', value);
                  } else if (selectedPlatformProfile) {
                    setPlatformOutput(value);
                    rememberOutput(selectedPlatformProfile.id, value);
                  }
                }}
              />
              <Button variant="outline" onClick={chooseOutput}>
                {t('settings:exportUi.browse')}
              </Button>
            </div>
          </div>

          {mode === 'platform' && selectedPlatformProfile ? (
            <>
              {compatibleTemplateChoices.length > 1 ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="export-player-template">
                    {t('settings:exportUi.playerTemplate')}
                  </Label>
                  <select
                    id="export-player-template"
                    className="h-9 w-full rounded border bg-background px-2 text-sm"
                    value={selectedTemplateToken}
                    onChange={(event) => {
                      const token = event.currentTarget.value;
                      const choice = compatibleTemplateChoices.find(
                        ({ item }) =>
                          `${item.descriptor.templateId}/${item.descriptor.buildId}` === token,
                      );
                      if (!choice) return;
                      setSelectedTemplateToken(token);
                      setTemplateDiagnostics([]);
                      const key = localProfileKey(selectedPlatformProfile.id);
                      setExportPreferences({
                        profileTemplateTokens: {
                          ...localState.profileTemplateTokens,
                          [key]: token,
                        },
                      });
                    }}
                  >
                    {compatibleTemplateChoices.map(({ item }) => {
                      const token = `${item.descriptor.templateId}/${item.descriptor.buildId}`;
                      return (
                        <option key={token} value={token}>
                          {item.descriptor.templateId}@{item.descriptor.buildId}
                          {item.entry.trust === 'official'
                            ? ''
                            : t('settings:exportUi.localSuffix')}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : null}

              {selectedPlatformProfile.target === 'windows' ||
              selectedPlatformProfile.target === 'macos' ||
              selectedPlatformProfile.target === 'android' ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="export-signing-identity">
                    {t('settings:exportUi.signingIdentity')}
                  </Label>
                  <select
                    id="export-signing-identity"
                    className="h-9 rounded border bg-background px-2 text-sm"
                    value={selectedSigningProfile ? selectedSigningProfile.id : ''}
                    onChange={(event) => {
                      const id = event.currentTarget.value;
                      setSelectedSigningProfileId(id);
                      const key = localProfileKey(selectedPlatformProfile.id);
                      setExportPreferences({
                        profileSigningProfileIds: {
                          ...localState.profileSigningProfileIds,
                          [key]: id,
                        },
                      });
                    }}
                  >
                    <option value="">{t('settings:exportUi.unsigned')}</option>
                    {signingProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </select>
                  {selectedSigningProfileId && !selectedSigningProfile ? (
                    <span className="text-xs text-amber-600">
                      {t('settings:exportUi.missingSigning')}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start p-0 text-xs"
                    onClick={() => navigateToWorkbenchTarget({ tab: buildSettingsTab() })}
                  >
                    {t('settings:exportUi.manageSigning')}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}

          {developerOptions}

          <div className="rounded border p-3 text-xs">
            <div className="mb-2 font-medium">{t('settings:exportUi.summary')}</div>
            <div className="grid grid-cols-2 gap-2 text-muted-foreground">
              <div>
                {t('settings:exportUi.project')}{' '}
                <span className="text-foreground">
                  {preview?.manifestPreview.projectName ?? currentProject.project.name}
                </span>
              </div>
              <div>
                {t('settings:exportUi.version')}{' '}
                <span className="text-foreground">
                  {preview?.manifestPreview.projectVersion ?? currentProject.project.version}
                </span>
              </div>
              <div>
                {t('settings:exportUi.packageEntries')}{' '}
                <span className="text-foreground">{preview?.manifestPreview.entryCount ?? 0}</span>
              </div>
              <div>
                {t('settings:exportUi.assetsIncluded')}{' '}
                <span className="text-foreground">{preview?.fileEntries.length ?? 0}</span>
              </div>
              {preview?.excludedUnusedAssetCount ? (
                <div className="col-span-2">
                  {t('settings:exportUi.unusedAssetsExcluded')}{' '}
                  <span className="text-foreground">{preview.excludedUnusedAssetCount}</span>
                </div>
              ) : null}
              {mode === 'platform' ? (
                <div className="col-span-2">
                  {t('settings:exportUi.template')}{' '}
                  <span className="font-mono text-foreground">
                    {template
                      ? `${template.descriptor.templateId}@${template.descriptor.buildId}`
                      : t('settings:exportUi.none')}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {mode === 'runtime' && runtimeDiagnostics.length > 0 ? (
            <DiagnosticPreview
              title={
                blockingDiagnostics.length === 0
                  ? t('settings:exportUi.runtimeNotices')
                  : t('settings:exportUi.exportBlocked')
              }
              diagnostics={runtimeDiagnostics}
              project={currentProject}
            />
          ) : null}
          {mode === 'platform'
            ? platformReadinessGroups.map((group) =>
                group.diagnostics.length > 0 ? (
                  <DiagnosticPreview
                    key={group.title}
                    title={group.title}
                    diagnostics={group.diagnostics}
                    project={currentProject}
                    actions={group.key === 'environment' ? missingTemplateActions : null}
                  />
                ) : null,
              )
            : null}
          {failedResultDiagnostics.length > 0 ? (
            <DiagnosticPreview
              title={t('settings:exportUi.lastExportFailed')}
              diagnostics={failedResultDiagnostics}
              project={currentProject}
            />
          ) : null}
          {lastResult?.success ? (
            <div className="flex items-center justify-between gap-3 rounded border p-3 text-sm">
              <div>
                <div className="font-medium">{t('settings:exportUi.exportCompleted')}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {lastResult.outputPath ?? platformOutput}
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  void window.noveltea.showItemInFolder(lastResult.outputPath ?? platformOutput)
                }
              >
                {t('settings:exportUi.openFolder')}
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            {hasProjectSettingsBlocker ? (
              <Button
                variant="secondary"
                onClick={() => dispatchWorkspaceToolbarCommand('project-settings')}
                disabled={running}
              >
                {t('settings:exportUi.openProjectSettings')}
              </Button>
            ) : null}
            {running && operationId ? (
              <Button variant="destructive" onClick={cancelExport}>
                {t('settings:exportUi.cancelExport')}
              </Button>
            ) : null}
            <Button onClick={runExport} disabled={!canExport}>
              {running
                ? t('settings:exportUi.exporting', { stage })
                : t('settings:exportUi.export')}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );

  const content = createIdentity || profileEditor || normalExportPane;

  return (
    <>
      <ExportSurface embedded={embedded} open={open} onOpenChange={onOpenChange}>
        {!embedded ? (
          <>
            <DialogTitle className="sr-only">{t('settings:exportUi.export')}</DialogTitle>
            <DialogDescription className="sr-only">
              {t('settings:exportUi.dialogDescription')}
            </DialogDescription>
          </>
        ) : null}
        <div className="flex h-full min-h-0 flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)]">
            <aside className="min-h-0 border-r p-3">
              <fieldset disabled={sidebarDisabled} className="grid gap-3 disabled:opacity-60">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">{t('settings:exportUi.profiles')}</div>
                  <div className="flex items-center gap-0.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('settings:exportUi.addProfileAction')}
                      title={t('settings:exportUi.addProfileAction')}
                      onClick={beginCreateProfile}
                    >
                      <Plus className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('settings:exportUi.duplicateProfileAction')}
                      title={t('settings:exportUi.duplicateProfileAction')}
                      disabled={mode === 'runtime' || !selectedPlatformProfile}
                      onClick={duplicateProfile}
                    >
                      <Copy className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={t('settings:exportUi.deleteProfileAction')}
                      title={t('settings:exportUi.deleteProfileAction')}
                      disabled={mode === 'runtime' || !selectedPlatformProfile}
                      onClick={deleteProfile}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${
                    mode === 'runtime' ? 'bg-accent font-medium' : 'hover:bg-accent/60'
                  }`}
                  onClick={selectRuntimeProfile}
                >
                  <span className="grid size-7 place-items-center rounded border text-[10px] font-semibold">
                    NT
                  </span>
                  {t('settings:exportUi.runtimePackage')}
                </button>
                <div className="border-t" />
                <div className="grid gap-1">
                  {sortedProfiles.map((profile) => (
                    <button
                      key={profile.id}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${
                        mode === 'platform' && selectedPlatformProfile?.id === profile.id
                          ? 'bg-accent font-medium'
                          : 'hover:bg-accent/60'
                      }`}
                      onClick={() => selectPlatformProfile(profile.id)}
                    >
                      <span className="grid size-7 shrink-0 place-items-center rounded border text-[10px] font-semibold">
                        {platformMarker(profile.target)}
                      </span>
                      <span className="min-w-0 truncate">{profile.label}</span>
                    </button>
                  ))}
                </div>
              </fieldset>
            </aside>
            <main className="min-h-0 overflow-auto p-6">
              <div className="mx-auto w-full max-w-3xl">{content}</div>
            </main>
          </div>
        </div>
      </ExportSurface>

      <Dialog open={identityConfirmationOpen} onOpenChange={setIdentityConfirmationOpen}>
        <DialogPopup className="max-w-lg">
          <DialogTitle>{t('settings:exportUi.identityTitle')}</DialogTitle>
          <DialogDescription>{t('settings:exportUi.identityDescription')}</DialogDescription>
          <div className="grid gap-2 py-3">
            {(readiness?.identityChangeDiagnostics ?? []).map((item) => (
              <div key={item.code} className="rounded border p-3 text-sm">
                {item.message}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIdentityConfirmationOpen(false)}>
              {t('settings:exportUi.cancel')}
            </Button>
            <Button
              onClick={() => {
                setIdentityConfirmationOpen(false);
                void runPlayablePlatformExport();
              }}
            >
              {t('settings:exportUi.continueExport')}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
