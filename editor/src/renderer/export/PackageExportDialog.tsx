import { useEffect, useMemo, useState } from 'react';
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
import { useCommandStore } from '@/commands/command-store';
import { useProjectStore } from '@/project/project-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import { dispatchWorkspaceToolbarCommand } from '@/workspace/workspace-toolbar-events';
import { buildPlatformExportProfilesTab, buildSettingsTab } from '@/workbench/editor-registry';
import { navigateToWorkbenchTarget } from '@/workbench/workbench-navigation';
import type { ToolDiagnostic } from '../../shared/editor-tooling';
import { parseAssetData } from '../../shared/project-schema/authoring-assets';
import type { AuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import {
  defaultPackageOutputFileName,
  exportShaderVariantValues,
  selectedExportProfile,
  type ExportProfileData,
  type ExportShaderVariant,
} from '../../shared/project-schema/authoring-export';
import {
  buildCompiledRuntimeExport,
  hasAuthoringShadersOrMaterials,
} from '../../shared/project-schema/compiled-runtime-export';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';
import {
  classifyProjectValidationDiagnostics,
  collectProjectValidationDiagnostics,
  createProjectValidationDiagnostic,
  type ProjectValidationDiagnostic,
} from '../../shared/project-schema/project-validation';
import { evaluateTemplateCompatibility } from '../../shared/project-schema/template-compatibility';
import {
  defaultPlatformExportProfile,
  parsePlatformExportProfile,
  parseProjectPlatformExportSettings,
  type ExportPlatform,
  type ExportCapability,
  type InstalledTemplate,
  type PlatformExportProfile,
  type ProjectPlatformExportSettings,
} from '../../shared/project-schema/platform-export-contracts';
import { runPackageExportWorkflow } from './package-export-workflow';
import { usePackageExportStore } from './package-export-store';
import {
  cancelPlatformStageWorkflow,
  runProjectPlatformExportWorkflow,
} from './platform-export-workflow';

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
  if (embedded) {
    return (
      <div className="h-full min-h-0 overflow-auto bg-background">
        <div className="mx-auto grid w-full max-w-5xl gap-4 p-6">{children}</div>
      </div>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-h-[90vh] max-w-3xl overflow-auto">{children}</DialogPopup>
    </Dialog>
  );
}

const capabilityOptions: ExportCapability[] = [
  'network.client',
  'external-url',
  'clipboard.read',
  'clipboard.write',
  'gamepad',
  'vibration',
  'microphone',
  'notifications',
  'custom-url-scheme',
  'billing',
];

function dirname(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : null;
}

function defaultOutputPath(
  project: AuthoringProject,
  projectRoot: string | null,
  projectFilePath: string | null,
) {
  const root = projectRoot ?? dirname(projectFilePath) ?? '';
  const file = defaultPackageOutputFileName(project);
  return root ? `${root.replace(/[\\/]+$/, '')}/${file}` : file;
}

function defaultPlatformOutput(projectRoot: string | null, profile: PlatformExportProfile) {
  const root = projectRoot?.replace(/[\\/]+$/, '') ?? '';
  return `${root ? `${root}/` : ''}dist/${profile.id}`;
}

function toggleVariant(
  profile: ExportProfileData,
  variant: ExportShaderVariant,
): ExportProfileData {
  const next = profile.shaderVariants.includes(variant)
    ? profile.shaderVariants.filter((item) => item !== variant)
    : [...profile.shaderVariants, variant];
  return { ...profile, shaderVariants: next.length > 0 ? next : [variant] };
}

function severityVariant(severity: ToolDiagnostic['severity']) {
  return severity === 'error' ? 'destructive' : severity === 'warning' ? 'secondary' : 'outline';
}

function DiagnosticPreview({
  title,
  diagnostics,
}: {
  title: string;
  diagnostics: ToolDiagnostic[];
}) {
  if (diagnostics.length === 0) return null;
  return (
    <div className="rounded border p-3 text-xs">
      <div className="mb-2 font-medium">{title}</div>
      <div className="space-y-2">
        {diagnostics.slice(0, 6).map((diagnostic, index) => (
          <div
            key={`${diagnostic.path}-${diagnostic.message}-${index}`}
            className="rounded bg-muted/40 p-2"
          >
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <Badge variant={severityVariant(diagnostic.severity)}>{diagnostic.severity}</Badge>
              <Badge variant="outline">{diagnostic.category ?? 'export'}</Badge>
              <span className="font-mono text-[10px] text-muted-foreground">
                {diagnostic.path || '/'}
              </span>
            </div>
            <div>{diagnostic.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function profileSettings(project: AuthoringProject): ProjectPlatformExportSettings {
  return parseProjectPlatformExportSettings(
    (project.settings as Record<string, unknown>).platformExport,
  );
}

function updateProfileTarget(
  profile: PlatformExportProfile,
  target: ExportPlatform,
): PlatformExportProfile {
  const next = defaultPlatformExportProfile(target);
  return {
    ...next,
    id: profile.id,
    label: profile.label,
    buildFlavor: profile.buildFlavor,
    includeDebugSymbols: profile.includeDebugSymbols,
  };
}

function profileArtifact(profile: PlatformExportProfile) {
  if (profile.target === 'web') return profile.web.artifact;
  if (profile.target === 'android') return profile.android.artifact;
  return profile.desktop.artifact;
}

function iconSourcePath(project: AuthoringProject, projectRoot: string | null) {
  const icon = projectSettingsFromProject(project).app.icon;
  if (!icon || !projectRoot) return undefined;
  const data = parseAssetData(project.assets[icon.$ref.id]?.data);
  return data ? `${projectRoot.replace(/[\\/]+$/, '')}/${data.source.path}` : undefined;
}

function persistPlatformSettings(
  project: AuthoringProject,
  settings: ProjectPlatformExportSettings,
) {
  const liveProject = useProjectStore.getState().document as AuthoringProject | null;
  const exists = Object.prototype.hasOwnProperty.call(
    liveProject?.settings ?? project.settings,
    'platformExport',
  );
  return useCommandStore.getState().executeCommand({
    type: exists ? 'project.replaceAtPath' : 'project.addAtPath',
    label: 'Update platform export profiles',
    payload: { path: '/settings/platformExport', value: settings },
  });
}

export function PackageExportDialog({
  open,
  onOpenChange,
  project,
  projectRoot,
  projectFilePath,
  embedded = false,
  initialMode = 'runtime',
  profileManagementOnly = false,
}: PackageExportDialogProps) {
  const running = usePackageExportStore((state) => state.running);
  const stage = usePackageExportStore((state) => state.stage);
  const lastResult = usePackageExportStore((state) => state.lastResult);
  const [mode, setMode] = useState<ExportMode>(initialMode);
  const [runtimeProfile, setRuntimeProfile] = useState<ExportProfileData | null>(null);
  const [platformSettings, setPlatformSettings] = useState<ProjectPlatformExportSettings | null>(
    null,
  );
  const [platformOutput, setPlatformOutput] = useState('');
  const [template, setTemplate] = useState<InstalledTemplate | null>(null);
  const [templates, setTemplates] = useState<InstalledTemplate[]>([]);
  const [selectedTemplateToken, setSelectedTemplateToken] = useState('');
  const [templateDiagnostics, setTemplateDiagnostics] = useState<ProjectValidationDiagnostic[]>([]);
  const [operationId, setOperationId] = useState<string | null>(null);
  const localState = usePreferencesStore((state) => state.exportPreferences);
  const setExportPreferences = usePreferencesStore((state) => state.setExportPreferences);

  function localProfileKey(profileId: string) {
    return `${projectFilePath ?? projectRoot ?? 'unsaved'}::${profileId}`;
  }

  function outputForProfile(profile: PlatformExportProfile) {
    return (
      localState.profileOutputDirectories[localProfileKey(profile.id)] ||
      defaultPlatformOutput(localState.defaultOutputDirectory || projectRoot, profile)
    );
  }

  useEffect(() => {
    if (!open || !project) return;
    setRuntimeProfile(selectedExportProfile(project));
    const settings = profileSettings(project);
    setPlatformSettings(settings);
    const selected =
      settings.profiles.find((item) => item.id === settings.selectedProfileId) ??
      settings.profiles[0]!;
    setPlatformOutput(outputForProfile(selected));
    setTemplate(null);
    setTemplates([]);
    setSelectedTemplateToken(localState.profileTemplateTokens[localProfileKey(selected.id)] ?? '');
    setTemplateDiagnostics([]);
  }, [open, project, projectRoot]); // oxlint-disable-line react-hooks/exhaustive-deps

  const activeRuntimeProfile = runtimeProfile ?? (project ? selectedExportProfile(project) : null);
  const activePlatformProfile =
    platformSettings?.profiles.find((item) => item.id === platformSettings.selectedProfileId) ??
    platformSettings?.profiles[0] ??
    null;
  const validationDiagnostics = useMemo(
    () => (project ? validateAuthoringProject(project) : []),
    [project],
  );
  const preview = useMemo(
    () =>
      project && activeRuntimeProfile
        ? buildCompiledRuntimeExport(project, { projectRoot, profile: activeRuntimeProfile })
        : null,
    [project, projectRoot, activeRuntimeProfile],
  );

  useEffect(() => {
    if (!activePlatformProfile || !platformOutput) return;
    const key = localProfileKey(activePlatformProfile.id);
    if (localState.profileOutputDirectories[key] === platformOutput) return;
    setExportPreferences({
      profileOutputDirectories: { ...localState.profileOutputDirectories, [key]: platformOutput },
    });
  }, [activePlatformProfile?.id, platformOutput, projectFilePath, projectRoot]); // oxlint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || mode !== 'platform' || !activePlatformProfile || !activeRuntimeProfile) return;
    let cancelled = false;
    setTemplate(null);
    const rememberedTemplate =
      localState.profileTemplateTokens[localProfileKey(activePlatformProfile.id)] ?? '';
    setSelectedTemplateToken(rememberedTemplate);
    void window.noveltea
      .listPlayerTemplates({
        platform: activePlatformProfile.target,
        architecture: activePlatformProfile.architecture,
        buildFlavor: activePlatformProfile.buildFlavor,
      })
      .then((items) => {
        if (!cancelled) setTemplates(items);
      });
    void window.noveltea
      .resolvePlayerTemplate({
        requirements: {
          profile: activePlatformProfile,
          runtimePackageApi: 1,
          playerConfigApi: 1,
          shaderVariants: activeRuntimeProfile.shaderVariants,
          graphicsBackends: [],
          capabilities: activePlatformProfile.capabilityOverrides,
          requiredFeatures: [],
        },
      })
      .then((result) => {
        if (cancelled) return;
        setTemplate(result.template ?? null);
        const token = rememberedTemplate || result.token || '';
        setSelectedTemplateToken(token);
        setTemplateDiagnostics(
          classifyProjectValidationDiagnostics(
            result.diagnostics.map((item) => ({
              code: item.code,
              severity: result.success ? ('warning' as const) : ('error' as const),
              category: `template:${item.code}`,
              path: item.path,
              message: item.message,
            })),
            { producer: 'template' },
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, activePlatformProfile, activeRuntimeProfile]); // oxlint-disable-line react-hooks/exhaustive-deps

  if (!project || !activeRuntimeProfile || !platformSettings || !activePlatformProfile) return null;
  const currentProject: AuthoringProject = project;
  const currentRuntimeProfile: ExportProfileData = activeRuntimeProfile;
  const currentPlatformSettings: ProjectPlatformExportSettings = platformSettings;
  const currentPlatformProfile: PlatformExportProfile = activePlatformProfile;
  const templateChoices = templates.map((item) => ({
    item,
    compatibility: evaluateTemplateCompatibility(item.descriptor, {
      profile: currentPlatformProfile,
      runtimePackageApi: 1,
      playerConfigApi: 1,
      shaderVariants: currentRuntimeProfile.shaderVariants,
      graphicsBackends: [],
      capabilities: currentPlatformProfile.capabilityOverrides,
      requiredFeatures: [],
    }),
  }));
  const outputPath =
    currentRuntimeProfile.outputPath ||
    defaultOutputPath(currentProject, projectRoot, projectFilePath);
  const usesProjectShaders = hasAuthoringShadersOrMaterials(currentProject);
  const preflightDiagnostics = collectProjectValidationDiagnostics(
    validationDiagnostics,
    preview?.diagnostics ?? [],
  );
  const blockingDiagnostics = preflightDiagnostics.filter(
    (diagnostic) => diagnostic.severity === 'error',
  );
  const failedResultDiagnostics =
    lastResult && !lastResult.success
      ? lastResult.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
      : [];
  const iconDiagnostic: ProjectValidationDiagnostic[] = iconSourcePath(currentProject, projectRoot)
    ? []
    : [
        createProjectValidationDiagnostic({
          code: 'platform-export.identity.icon.missing',
          severity: 'error',
          category: 'identity',
          path: '/settings/app/icon',
          message: 'A valid project icon is required for playable platform export.',
          boundaries: ['platform-export'],
          ownerPaths: ['/settings/app/icon'],
        }),
      ];
  const platformBlockers = collectProjectValidationDiagnostics(
    blockingDiagnostics,
    iconDiagnostic,
    templateDiagnostics.filter((item) => item.severity === 'error'),
  );
  const canExport =
    !running &&
    (mode === 'runtime'
      ? blockingDiagnostics.length === 0 && outputPath.trim().length > 0
      : platformBlockers.length === 0 && platformOutput.trim().length > 0 && !!template);
  const hasProjectSettingsBlocker = blockingDiagnostics.some(
    (diagnostic) =>
      diagnostic.path === '/entrypoint' ||
      diagnostic.path.startsWith('/settings/') ||
      diagnostic.path.startsWith('/project/'),
  );

  function commitPlatformSettings(next: ProjectPlatformExportSettings) {
    const result = persistPlatformSettings(currentProject, next);
    if (result.ok) setPlatformSettings(next);
  }

  function replaceActiveProfile(next: PlatformExportProfile) {
    commitPlatformSettings({
      ...currentPlatformSettings,
      profiles: currentPlatformSettings.profiles.map((profile) =>
        profile.id === currentPlatformProfile.id ? next : profile,
      ),
    });
  }

  function toggleCapability(capability: ExportCapability) {
    const current = currentPlatformProfile.capabilityOverrides;
    replaceActiveProfile({
      ...currentPlatformProfile,
      capabilityOverrides: current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability].sort(),
    });
  }

  function createProfile() {
    const base = defaultPlatformExportProfile('linux');
    let index = currentPlatformSettings.profiles.length + 1;
    while (currentPlatformSettings.profiles.some((item) => item.id === `platform-${index}`))
      index++;
    const next = parsePlatformExportProfile({
      ...base,
      id: `platform-${index}`,
      label: `Platform Export ${index}`,
    });
    commitPlatformSettings({
      selectedProfileId: next.id,
      profiles: [...currentPlatformSettings.profiles, next],
    });
    setPlatformOutput(defaultPlatformOutput(projectRoot, next));
  }

  function duplicateProfile() {
    let index = 2;
    let id = `${currentPlatformProfile.id}-copy`;
    while (currentPlatformSettings.profiles.some((item) => item.id === id))
      id = `${currentPlatformProfile.id}-copy-${index++}`;
    const next = parsePlatformExportProfile({
      ...currentPlatformProfile,
      id,
      label: `${currentPlatformProfile.label} Copy`,
    });
    commitPlatformSettings({
      selectedProfileId: id,
      profiles: [...currentPlatformSettings.profiles, next],
    });
  }

  function deleteProfile() {
    if (currentPlatformSettings.profiles.length === 1) return;
    const profiles = currentPlatformSettings.profiles.filter(
      (item) => item.id !== currentPlatformProfile.id,
    );
    commitPlatformSettings({ selectedProfileId: profiles[0]!.id, profiles });
  }

  async function chooseOutput() {
    if (mode === 'runtime') {
      const selected = await window.noveltea.selectPackageOutputPath(outputPath);
      if (selected) setRuntimeProfile({ ...currentRuntimeProfile, outputPath: selected });
    } else {
      const selected = await window.noveltea.selectDirectory({
        title: 'Select platform export directory',
        defaultPath: platformOutput,
      });
      if (selected) setPlatformOutput(selected);
    }
  }

  async function installTemplate() {
    const archivePath = await window.noveltea.selectTemplateArchivePath();
    if (!archivePath) return;
    const installed = await window.noveltea.installPlayerTemplate({
      archivePath,
      origin: archivePath,
    });
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
    const resolved = await window.noveltea.resolvePlayerTemplate({
      requirements: {
        profile: currentPlatformProfile,
        runtimePackageApi: 1,
        playerConfigApi: 1,
        shaderVariants: currentRuntimeProfile.shaderVariants,
        graphicsBackends: [],
        capabilities: currentPlatformProfile.capabilityOverrides,
        requiredFeatures: [],
      },
    });
    setTemplate(resolved.template ?? null);
    setSelectedTemplateToken(resolved.token ?? '');
    setTemplateDiagnostics(
      classifyProjectValidationDiagnostics(
        resolved.diagnostics.map((item) => ({
          code: item.code,
          severity: resolved.success ? ('warning' as const) : ('error' as const),
          category: `template:${item.code}`,
          path: item.path,
          message: item.message,
        })),
        { producer: 'template' },
      ),
    );
  }

  async function runExport() {
    if (!canExport) return;
    if (mode === 'runtime') {
      const result = await runPackageExportWorkflow({
        project: currentProject,
        projectRoot,
        outputPath,
        profile: { ...currentRuntimeProfile, outputPath },
      });
      if (result.success) onOpenChange(false);
      return;
    }
    const nextOperationId = `editor-${Date.now()}`;
    setOperationId(nextOperationId);
    const parseArguments = (value: string, label: string) => {
      try {
        const parsed = JSON.parse(value || '[]') as unknown;
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
          throw new Error();
        return parsed as string[];
      } catch {
        throw new Error(`${label} must be a JSON array of strings.`);
      }
    };
    const signingEnabled = Boolean(currentPlatformProfile.signingProfileId);
    const signing = {
      ...(signingEnabled && localState.windowsSigningCommand && localState.windowsVerifyCommand
        ? {
            windows: {
              command: localState.windowsSigningCommand,
              args: parseArguments(localState.windowsSigningArgs, 'Windows signing arguments'),
              verifyCommand: localState.windowsVerifyCommand,
              verifyArgs: parseArguments(
                localState.windowsVerifyArgs,
                'Windows verification arguments',
              ),
            },
          }
        : {}),
      ...(signingEnabled && localState.macosSigningIdentity
        ? {
            macos: {
              identity: localState.macosSigningIdentity,
              ...(localState.macosEntitlementsPath
                ? { entitlementsPath: localState.macosEntitlementsPath }
                : {}),
              ...(localState.macosNotarizationCommand
                ? {
                    notarizationCommand: localState.macosNotarizationCommand,
                    notarizationArgs: parseArguments(
                      localState.macosNotarizationArgs,
                      'macOS notarization arguments',
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(signingEnabled &&
      localState.androidKeystorePath &&
      localState.androidKeyAlias &&
      localState.androidStorePasswordReference &&
      localState.androidKeyPasswordReference
        ? {
            android: {
              keystorePath: localState.androidKeystorePath,
              keyAlias: localState.androidKeyAlias,
              storePasswordReference: localState.androidStorePasswordReference,
              keyPasswordReference: localState.androidKeyPasswordReference,
            },
          }
        : {}),
    };
    const result = await runProjectPlatformExportWorkflow(
      {
        operationId: nextOperationId,
        project: currentProject,
        projectRoot: projectRoot ?? undefined,
        profileId: currentPlatformProfile.id,
        templateToken:
          selectedTemplateToken ||
          `${template!.descriptor.templateId}/${template!.descriptor.buildId}`,
        outputDirectory: platformOutput,
        localState: {
          androidSdk: localState.androidSdk || undefined,
          androidNdk: localState.androidNdk || undefined,
          javaHome: localState.javaHome || undefined,
          cmake: localState.cmake || undefined,
          ...(Object.keys(signing).length ? { signing } : {}),
        },
      },
      currentPlatformProfile,
    );
    setOperationId(null);
    if (result.success) onOpenChange(false);
  }

  async function cancelExport() {
    if (!operationId) return;
    await cancelPlatformStageWorkflow(operationId);
  }

  const title = embedded ? (
    <>
      <h1 className="text-lg font-semibold">
        {profileManagementOnly ? 'Export Profiles' : 'Export Project'}
      </h1>
      <p className="text-sm text-muted-foreground">
        {profileManagementOnly
          ? 'Manage reproducible platform build profiles committed with this project.'
          : 'Export a runtime package or playable platform artifact.'}
      </p>
    </>
  ) : (
    <>
      <DialogTitle>Export Project</DialogTitle>
      <DialogDescription className="sr-only">
        Export a runtime package or playable platform artifact.
      </DialogDescription>
    </>
  );
  const footerContent = (
    <>
      {hasProjectSettingsBlocker ? (
        <Button
          variant="secondary"
          onClick={() => {
            dispatchWorkspaceToolbarCommand('project-settings');
            onOpenChange(false);
          }}
          disabled={running}
        >
          Open Project Settings
        </Button>
      ) : null}
      {running && operationId ? (
        <Button variant="destructive" onClick={cancelExport}>
          Cancel Export
        </Button>
      ) : (
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
          Cancel
        </Button>
      )}
      <Button onClick={runExport} disabled={!canExport}>
        {running
          ? `Exporting: ${stage}`
          : canExport
            ? 'Export Project'
            : 'Fix Errors Before Export'}
      </Button>
    </>
  );

  return (
    <ExportSurface embedded={embedded} open={open} onOpenChange={onOpenChange}>
      {title}
      <div className="grid gap-4">
        {!profileManagementOnly ? (
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === 'runtime' ? 'default' : 'outline'}
              onClick={() => setMode('runtime')}
            >
              Runtime Package (.ntpkg)
            </Button>
            <Button
              type="button"
              variant={mode === 'platform' ? 'default' : 'outline'}
              onClick={() => setMode('platform')}
            >
              Playable Platform Export
            </Button>
          </div>
        ) : null}
        {mode === 'runtime' ? (
          <>
            <div className="grid gap-2">
              <Label htmlFor="package-export-output">Output file</Label>
              <div className="flex gap-2">
                <Input
                  id="package-export-output"
                  className="font-mono text-[11px]"
                  value={outputPath}
                  onChange={(event) =>
                    setRuntimeProfile({
                      ...activeRuntimeProfile,
                      outputPath: event.currentTarget.value,
                    })
                  }
                />
                <Button type="button" variant="outline" onClick={chooseOutput}>
                  Browse…
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 rounded border p-3">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={activeRuntimeProfile.includeChecksums}
                  onChange={(event) =>
                    setRuntimeProfile({
                      ...activeRuntimeProfile,
                      includeChecksums: event.currentTarget.checked,
                    })
                  }
                />
                Include checksums
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={activeRuntimeProfile.includeAllProjectAssets}
                  onChange={(event) =>
                    setRuntimeProfile({
                      ...activeRuntimeProfile,
                      includeAllProjectAssets: event.currentTarget.checked,
                      includeOnlyReferencedAssets: !event.currentTarget.checked,
                    })
                  }
                />
                Include all project assets
              </label>
              {usesProjectShaders ? (
                <>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={activeRuntimeProfile.stripShaderSources}
                      onChange={(event) =>
                        setRuntimeProfile({
                          ...activeRuntimeProfile,
                          stripShaderSources: event.currentTarget.checked,
                        })
                      }
                    />
                    Strip shader sources
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={activeRuntimeProfile.compileShadersBeforeExport}
                      onChange={(event) =>
                        setRuntimeProfile({
                          ...activeRuntimeProfile,
                          compileShadersBeforeExport: event.currentTarget.checked,
                        })
                      }
                    />
                    Compile shaders before export
                  </label>
                </>
              ) : null}
            </div>
            {usesProjectShaders ? (
              <div className="grid gap-2 rounded border p-3">
                <div className="font-medium">Shader variants</div>
                <div className="flex flex-wrap gap-3">
                  {exportShaderVariantValues.map((variant) => (
                    <label key={variant} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={activeRuntimeProfile.shaderVariants.includes(variant)}
                        onChange={() =>
                          setRuntimeProfile(toggleVariant(activeRuntimeProfile, variant))
                        }
                      />
                      {variant}
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <div
              className={
                profileManagementOnly
                  ? 'grid grid-cols-[1fr_auto_auto_auto] gap-2'
                  : 'grid grid-cols-[1fr_auto] gap-2'
              }
            >
              <select
                aria-label="Platform export profile"
                className="h-9 rounded border bg-background px-2 text-sm"
                value={activePlatformProfile.id}
                onChange={(event) => {
                  const id = event.currentTarget.value;
                  const next = { ...platformSettings, selectedProfileId: id };
                  commitPlatformSettings(next);
                  const selected = next.profiles.find((item) => item.id === id)!;
                  setPlatformOutput(outputForProfile(selected));
                }}
              >
                {platformSettings.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
              {profileManagementOnly ? (
                <>
                  <Button type="button" variant="outline" onClick={createProfile}>
                    New
                  </Button>
                  <Button type="button" variant="outline" onClick={duplicateProfile}>
                    Duplicate
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={platformSettings.profiles.length === 1}
                    onClick={deleteProfile}
                  >
                    Delete
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    navigateToWorkbenchTarget({ tab: buildPlatformExportProfilesTab() })
                  }
                >
                  Manage Profiles
                </Button>
              )}
            </div>
            {profileManagementOnly ? (
              <>
                <div className="grid grid-cols-2 gap-3 rounded border p-3">
                  <div className="grid gap-1">
                    <Label>Profile name</Label>
                    <Input
                      value={activePlatformProfile.label}
                      onChange={(event) =>
                        replaceActiveProfile({
                          ...activePlatformProfile,
                          label: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="grid gap-1">
                    <Label>Target</Label>
                    <select
                      aria-label="Target platform"
                      className="h-9 rounded border bg-background px-2 text-sm"
                      value={activePlatformProfile.target}
                      onChange={(event) =>
                        replaceActiveProfile(
                          updateProfileTarget(
                            activePlatformProfile,
                            event.currentTarget.value as ExportPlatform,
                          ),
                        )
                      }
                    >
                      {(['windows', 'linux', 'macos', 'web', 'android'] as ExportPlatform[]).map(
                        (target) => (
                          <option key={target} value={target}>
                            {target}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label>Build flavor</Label>
                    <select
                      aria-label="Build flavor"
                      className="h-9 rounded border bg-background px-2 text-sm"
                      value={activePlatformProfile.buildFlavor}
                      onChange={(event) =>
                        replaceActiveProfile({
                          ...activePlatformProfile,
                          buildFlavor: event.currentTarget.value as 'debug' | 'release',
                        })
                      }
                    >
                      <option value="release">release</option>
                      <option value="debug">debug</option>
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label>Compression</Label>
                    <select
                      aria-label="Compression"
                      className="h-9 rounded border bg-background px-2 text-sm"
                      value={activePlatformProfile.compression}
                      onChange={(event) =>
                        replaceActiveProfile({
                          ...activePlatformProfile,
                          compression: event.currentTarget
                            .value as PlatformExportProfile['compression'],
                        })
                      }
                    >
                      <option value="default">default</option>
                      <option value="store">store</option>
                      <option value="maximum">maximum</option>
                    </select>
                  </div>
                  <div className="grid gap-1">
                    <Label>Architecture</Label>
                    <select
                      aria-label="Architecture"
                      className="h-9 rounded border bg-background px-2 text-sm"
                      value={activePlatformProfile.architecture}
                      onChange={(event) => {
                        const architecture = event.currentTarget.value;
                        if (activePlatformProfile.target === 'web') return;
                        if (activePlatformProfile.target === 'android')
                          replaceActiveProfile({
                            ...activePlatformProfile,
                            architecture: architecture as 'arm64' | 'x86_64',
                            android: {
                              ...activePlatformProfile.android,
                              abi: architecture === 'x86_64' ? 'x86_64' : 'arm64-v8a',
                            },
                          });
                        else
                          replaceActiveProfile({
                            ...activePlatformProfile,
                            architecture: architecture as 'x64' | 'arm64',
                          });
                      }}
                    >
                      {activePlatformProfile.target === 'web' ? (
                        <option value="wasm32">wasm32</option>
                      ) : activePlatformProfile.target === 'android' ? (
                        <>
                          <option value="arm64">arm64</option>
                          <option value="x86_64">x86_64</option>
                        </>
                      ) : (
                        <>
                          <option value="x64">x64</option>
                          <option value="arm64">arm64</option>
                        </>
                      )}
                    </select>
                  </div>
                  {activePlatformProfile.target === 'web' ? (
                    <>
                      <div className="grid gap-1">
                        <Label>Display mode</Label>
                        <select
                          aria-label="Web display mode"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.web.display}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              web: {
                                ...activePlatformProfile.web,
                                display: event.currentTarget
                                  .value as typeof activePlatformProfile.web.display,
                              },
                            })
                          }
                        >
                          <option value="standalone">standalone</option>
                          <option value="fullscreen">fullscreen</option>
                          <option value="minimal-ui">minimal-ui</option>
                          <option value="browser">browser</option>
                        </select>
                      </div>
                      <div className="grid gap-1">
                        <Label>Base path</Label>
                        <Input
                          value={activePlatformProfile.web.basePath}
                          onChange={(event) =>
                            replaceActiveProfile(
                              parsePlatformExportProfile({
                                ...activePlatformProfile,
                                web: {
                                  ...activePlatformProfile.web,
                                  basePath: event.currentTarget.value,
                                },
                              }),
                            )
                          }
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label>Service worker</Label>
                        <select
                          aria-label="Service worker"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.web.serviceWorker}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              web: {
                                ...activePlatformProfile.web,
                                serviceWorker: event.currentTarget.value as 'disabled' | 'offline',
                              },
                            })
                          }
                        >
                          <option value="disabled">disabled</option>
                          <option value="offline">offline</option>
                        </select>
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={activePlatformProfile.web.pwa}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              web: {
                                ...activePlatformProfile.web,
                                pwa: event.currentTarget.checked,
                              },
                            })
                          }
                        />
                        Generate PWA metadata
                      </label>
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={activePlatformProfile.web.threaded}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              web: {
                                ...activePlatformProfile.web,
                                threaded: event.currentTarget.checked,
                              },
                            })
                          }
                        />
                        Threaded Web build
                      </label>
                    </>
                  ) : activePlatformProfile.target === 'android' ? (
                    <>
                      <div className="grid gap-1">
                        <Label>Artifact</Label>
                        <select
                          aria-label="Android artifact"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.android.artifact}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              android: {
                                ...activePlatformProfile.android,
                                artifact: event.currentTarget.value as 'apk' | 'aab' | 'both',
                              },
                            })
                          }
                        >
                          <option value="apk">APK</option>
                          <option value="aab">AAB</option>
                          <option value="both">APK and AAB</option>
                        </select>
                      </div>
                      <div className="grid gap-1">
                        <Label>Package access</Label>
                        <select
                          aria-label="Android package access"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.packageAccess}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              packageAccess: event.currentTarget.value as
                                | 'android-asset'
                                | 'android-private-copy',
                            })
                          }
                        >
                          <option value="android-asset">APK asset</option>
                          <option value="android-private-copy">Private storage copy</option>
                        </select>
                      </div>
                      <div className="grid gap-1">
                        <Label>Minimum SDK</Label>
                        <Input
                          type="number"
                          min={24}
                          value={activePlatformProfile.android.minSdk}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              android: {
                                ...activePlatformProfile.android,
                                minSdk: Math.max(24, Number(event.currentTarget.value) || 24),
                              },
                            })
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid gap-1">
                        <Label>Artifact</Label>
                        <select
                          aria-label="Desktop artifact"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.desktop.artifact}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              desktop: {
                                ...activePlatformProfile.desktop,
                                artifact: event.currentTarget
                                  .value as typeof activePlatformProfile.desktop.artifact,
                              },
                            })
                          }
                        >
                          {activePlatformProfile.target === 'windows' ? (
                            <option value="zip">ZIP</option>
                          ) : activePlatformProfile.target === 'macos' ? (
                            <option value="app-bundle">App bundle</option>
                          ) : (
                            <>
                              <option value="tar">tar</option>
                              <option value="appimage">AppImage</option>
                              <option value="zip">ZIP</option>
                            </>
                          )}
                        </select>
                      </div>
                      <div className="grid gap-1">
                        <Label>Executable name</Label>
                        <Input
                          value={activePlatformProfile.desktop.executableName}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              desktop: {
                                ...activePlatformProfile.desktop,
                                executableName: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      </div>
                      <div className="grid gap-1">
                        <Label>Package access</Label>
                        <select
                          aria-label="Desktop package access"
                          className="h-9 rounded border bg-background px-2 text-sm"
                          value={activePlatformProfile.packageAccess}
                          onChange={(event) =>
                            replaceActiveProfile({
                              ...activePlatformProfile,
                              packageAccess: event.currentTarget.value as
                                | 'sidecar'
                                | 'bundle-resource',
                            })
                          }
                        >
                          <option value="sidecar">sidecar</option>
                          <option value="bundle-resource">bundle resource</option>
                        </select>
                      </div>
                    </>
                  )}
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={activePlatformProfile.includeDebugSymbols}
                      onChange={(event) =>
                        replaceActiveProfile({
                          ...activePlatformProfile,
                          includeDebugSymbols: event.currentTarget.checked,
                        })
                      }
                    />
                    Include separate debug symbols
                  </label>
                  {activePlatformProfile.target !== 'web' &&
                  activePlatformProfile.target !== 'linux' ? (
                    <div className="grid gap-1">
                      <Label>Signing profile</Label>
                      <select
                        aria-label="Signing profile"
                        className="h-9 rounded border bg-background px-2 text-sm"
                        value={activePlatformProfile.signingProfileId ?? ''}
                        onChange={(event) =>
                          replaceActiveProfile({
                            ...activePlatformProfile,
                            signingProfileId: event.currentTarget.value || null,
                          })
                        }
                      >
                        <option value="">Unsigned</option>
                        <option value={`${activePlatformProfile.target}-default`}>
                          Editor default
                        </option>
                      </select>
                    </div>
                  ) : null}
                </div>
                <div className="rounded border p-3 text-xs">
                  <div className="mb-2 font-medium">Capabilities</div>
                  <div className="grid grid-cols-2 gap-2">
                    {capabilityOptions.map((capability) => (
                      <label key={capability} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={activePlatformProfile.capabilityOverrides.includes(capability)}
                          onChange={() => toggleCapability(capability)}
                        />
                        {capability}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
            {!profileManagementOnly ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="platform-export-output">Output directory</Label>
                  <div className="flex gap-2">
                    <Input
                      id="platform-export-output"
                      className="font-mono text-[11px]"
                      value={platformOutput}
                      onChange={(event) => setPlatformOutput(event.currentTarget.value)}
                    />
                    <Button type="button" variant="outline" onClick={chooseOutput}>
                      Browse…
                    </Button>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 rounded border p-3 text-xs">
                  <div>
                    <div className="font-medium">Editor-wide export settings</div>
                    <div className="text-muted-foreground">
                      Toolchains, signing references, and the default output location are configured
                      once for this editor installation.
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => navigateToWorkbenchTarget({ tab: buildSettingsTab() })}
                  >
                    Open Export Settings
                  </Button>
                </div>
                <div className="rounded border p-3 text-xs">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-medium">Preflight</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto h-7"
                      onClick={installTemplate}
                    >
                      Install Template…
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      Target:{' '}
                      <span className="font-mono">
                        {activePlatformProfile.target}/{activePlatformProfile.architecture}
                      </span>
                    </div>
                    <div>
                      Artifact:{' '}
                      <span className="font-mono">{profileArtifact(activePlatformProfile)}</span>
                    </div>
                    <div className="grid gap-1">
                      <span>Template</span>
                      <select
                        aria-label="Player template"
                        className="h-8 rounded border bg-background px-2"
                        value={selectedTemplateToken}
                        onChange={(event) => {
                          const token = event.currentTarget.value;
                          setSelectedTemplateToken(token);
                          const key = localProfileKey(activePlatformProfile.id);
                          setExportPreferences({
                            profileTemplateTokens: {
                              ...localState.profileTemplateTokens,
                              [key]: token,
                            },
                          });
                          const choice = templateChoices.find(
                            ({ item }) =>
                              `${item.descriptor.templateId}/${item.descriptor.buildId}` === token,
                          );
                          setTemplate(
                            choice?.compatibility.compatible && choice.item.status !== 'corrupted'
                              ? choice.item
                              : null,
                          );
                        }}
                      >
                        <option value="">Automatically resolved</option>
                        {templateChoices.map(({ item, compatibility }) => {
                          const token = `${item.descriptor.templateId}/${item.descriptor.buildId}`;
                          const status =
                            item.status === 'corrupted'
                              ? 'corrupted'
                              : compatibility.compatible
                                ? item.entry.trust
                                : 'incompatible';
                          return (
                            <option
                              key={token}
                              value={token}
                              disabled={item.status === 'corrupted' || !compatibility.compatible}
                            >
                              {item.descriptor.templateId}@{item.descriptor.buildId} ({status})
                            </option>
                          );
                        })}
                      </select>
                      {template ? (
                        <span className="font-mono">
                          {template.descriptor.templateId}@{template.descriptor.buildId}
                        </span>
                      ) : null}
                    </div>
                    <div>
                      Identity:{' '}
                      <span className="font-mono">
                        {projectSettingsFromProject(project).app.applicationId}
                      </span>
                    </div>
                    <div>
                      Package mode:{' '}
                      <span className="font-mono">{activePlatformProfile.packageAccess}</span>
                    </div>
                    <div>
                      Host tools:{' '}
                      <span className="font-mono">
                        {[
                          localState.androidSdk && 'SDK',
                          localState.androidNdk && 'NDK',
                          localState.javaHome && 'Java',
                          localState.cmake && 'CMake',
                        ]
                          .filter(Boolean)
                          .join(', ') || 'none configured'}
                      </span>
                    </div>
                  </div>
                </div>
                {templateDiagnostics.length > 0 ? (
                  <DiagnosticPreview
                    title={template ? 'Template warnings' : 'Platform export is blocked'}
                    diagnostics={templateDiagnostics}
                  />
                ) : null}
              </>
            ) : null}
          </>
        )}
        {!profileManagementOnly ? (
          <>
            <div className="rounded border p-3 text-xs">
              <div className="mb-2 font-medium">Manifest preview</div>
              <div className="grid grid-cols-2 gap-2 text-muted-foreground">
                <div>
                  Project: <span className="text-foreground">{project.project.name}</span>
                </div>
                <div>
                  Version: <span className="text-foreground">{project.project.version}</span>
                </div>
                <div>
                  Package entries:{' '}
                  <span className="text-foreground">
                    {preview?.manifestPreview.entryCount ?? 0}
                  </span>
                </div>
                <div>
                  Assets:{' '}
                  <span className="text-foreground">{preview?.fileEntries.length ?? 0}</span>
                </div>
              </div>
            </div>
            {(mode === 'runtime' ? blockingDiagnostics : platformBlockers).length > 0 ? (
              <DiagnosticPreview
                title="Export is blocked"
                diagnostics={mode === 'runtime' ? blockingDiagnostics : platformBlockers}
              />
            ) : null}
            {failedResultDiagnostics.length > 0 ? (
              <DiagnosticPreview title="Last export failed" diagnostics={failedResultDiagnostics} />
            ) : null}
          </>
        ) : null}
      </div>
      {!profileManagementOnly ? (
        embedded ? (
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">{footerContent}</div>
        ) : (
          <DialogFooter>{footerContent}</DialogFooter>
        )
      ) : null}
    </ExportSurface>
  );
}
