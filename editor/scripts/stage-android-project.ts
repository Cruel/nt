import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateAppIcons } from '../src/main/services/icon-generation-service';
import {
  compileShaders,
  exportPackage,
  openProject,
} from '../src/main/services/editor-tool-service';
import { parseAssetData } from '../src/shared/project-schema/authoring-assets';
import { runtimeExportProfileForPlatform } from '../src/shared/project-schema/authoring-export';
import { parseAuthoringProject } from '../src/shared/project-schema/authoring-project';
import {
  deriveProjectDisplayGeometry,
  projectSettingsFromProject,
} from '../src/shared/project-schema/authoring-project-settings';
import { parseShaderData } from '../src/shared/project-schema/authoring-shaders';
import { validateAuthoringProject } from '../src/shared/project-schema/authoring-validation';
import {
  buildCompiledRuntimeExport,
  hasAuthoringShadersOrMaterials,
} from '../src/shared/project-schema/compiled-runtime-export';
import { stripEditorProjectState } from '../src/shared/project-schema/editor-project-state';
import { buildShaderMaterialProject } from '../src/shared/project-schema/shader-material-project';
import { capabilityMetadata } from '../src/shared/project-schema/platform-deployment';
import { parseProjectPlatformExportSettings } from '../src/shared/project-schema/platform-export-contracts';
import type { OpenProjectResponse, PackageExportResponse } from '../src/shared/editor-tooling';

interface ShaderCompileResponse {
  success?: boolean;
  diagnostics?: Array<{ severity: 'info' | 'warning' | 'error'; message: string }>;
  outputs?: Array<{ shader: string; stage: string; variant: string; runtimePath: string }>;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const projectPath = option(args, '--project');
  const profileId = option(args, '--profile');
  const outputRoot = option(args, '--output');
  const shaderc = option(args, '--shaderc');
  const bgfxShaderIncludeDir = option(args, '--bgfx-shader-include');
  if (!projectPath || !profileId || !outputRoot) {
    throw new Error(
      'Usage: stage-android-project --project <project.json> --profile <id> --output <directory> [--shaderc <path> --bgfx-shader-include <path>]',
    );
  }

  const loaded = (await openProject(path.resolve(projectPath))) as unknown as OpenProjectResponse;
  if (!loaded.success || !loaded.contentProject || !loaded.projectPath) {
    throw new Error(
      loaded.diagnostics?.map((item) => item.message).join('; ') || 'Project load failed.',
    );
  }
  const project = parseAuthoringProject({
    ...(stripEditorProjectState(loaded.contentProject) as Record<string, unknown>),
    ...(loaded.editorState ? { editor: loaded.editorState } : {}),
  });
  const validationErrors = validateAuthoringProject(project).filter(
    (item) => item.severity === 'error',
  );
  if (validationErrors.length)
    throw new Error(validationErrors.map((item) => item.message).join('; '));

  const platformProfile = parseProjectPlatformExportSettings(
    (project.settings as Record<string, unknown>).platformExport,
  ).profiles.find((item) => item.id === profileId);
  if (!platformProfile || platformProfile.target !== 'android') {
    throw new Error(`Android export profile '${profileId}' was not found.`);
  }
  const runtimeProfile = runtimeExportProfileForPlatform(project, 'android');
  let exportProject = project;
  if (runtimeProfile.compileShadersBeforeExport && hasAuthoringShadersOrMaterials(project)) {
    if (!shaderc || !bgfxShaderIncludeDir) {
      throw new Error('Shader compilation requires --shaderc and --bgfx-shader-include.');
    }
    const shaderProject = buildShaderMaterialProject(project);
    const response = (await compileShaders(shaderProject.project, {
      shaderc,
      bgfxShaderIncludeDir,
      projectRoot: loaded.projectPath,
      outputRoot: path.join(loaded.projectPath, '.noveltea', 'build'),
      cacheRoot: path.join(loaded.projectPath, '.noveltea', 'cache'),
      shaderVariants: runtimeProfile.shaderVariants,
    })) as ShaderCompileResponse;
    if (!response.success || response.diagnostics?.some((item) => item.severity === 'error')) {
      throw new Error(
        response.diagnostics?.map((item) => item.message).join('; ') ||
          'Shader compilation failed.',
      );
    }
    exportProject = structuredClone(project);
    for (const output of response.outputs ?? []) {
      const record = exportProject.shaders[output.shader];
      const shader = parseShaderData(record?.data);
      const stage = shader?.stages.find((item) => item.stage === output.stage);
      if (!record || !shader || !stage) continue;
      stage.compiled = { ...stage.compiled, [output.variant]: output.runtimePath };
      record.data = shader;
    }
  }

  const built = buildCompiledRuntimeExport(exportProject, {
    projectRoot: loaded.projectPath,
    profile: runtimeProfile,
  });
  if (!built.ok || !built.compiledProject) {
    throw new Error(built.diagnostics.map((item) => item.message).join('; '));
  }

  const generatedRoot = path.resolve(outputRoot);
  await rm(generatedRoot, { recursive: true, force: true });
  const bootstrapRoot = path.join(generatedRoot, 'assets', 'noveltea', 'bootstrap');
  const resRoot = path.join(generatedRoot, 'res');
  await mkdir(bootstrapRoot, { recursive: true });
  await mkdir(path.join(resRoot, 'values'), { recursive: true });
  await mkdir(path.join(resRoot, 'values-v31'), { recursive: true });
  await mkdir(path.join(resRoot, 'xml'), { recursive: true });

  const packagePath = path.join(bootstrapRoot, 'game.ntpkg');
  const packaged = (await exportPackage(built.compiledProject, packagePath, {
    ...built.packageOptions,
    shaderAssetRoot:
      (built.packageOptions.shaderVariants?.length ?? 0) > 0
        ? path.join(loaded.projectPath, '.noveltea', 'build')
        : built.packageOptions.shaderAssetRoot,
  })) as PackageExportResponse;
  if (!packaged.success) {
    throw new Error(
      packaged.diagnostics?.map((item) => item.message).join('; ') || 'Package export failed.',
    );
  }

  const settings = projectSettingsFromProject(project);
  const runtimeDisplay = built.packageOptions.display;
  const runtimeAccessibility = built.packageOptions.accessibility;
  const displayGeometry = runtimeDisplay
    ? deriveProjectDisplayGeometry(runtimeDisplay.reference_resolution)
    : null;
  if (!runtimeDisplay || !runtimeAccessibility || !displayGeometry) {
    throw new Error('Compiled runtime settings are missing display or accessibility metadata.');
  }
  const iconRef = settings.app.icon;
  const iconData = iconRef ? parseAssetData(project.assets[iconRef.$ref.id]?.data) : undefined;
  if (!iconData) throw new Error('A valid project icon is required.');
  const iconResult = await generateAppIcons({
    sourcePath: path.join(loaded.projectPath, iconData.source.path),
    stagingRoot: path.join(generatedRoot, '.icons'),
    backgroundColor: settings.app.launchBackgroundColor ?? '#000000',
    platforms: ['android'],
  });
  if (!iconResult.ok)
    throw new Error(iconResult.diagnostics.map((item) => item.message).join('; '));
  await cp(path.join(generatedRoot, '.icons', 'android', 'res'), resRoot, { recursive: true });
  await rm(path.join(generatedRoot, '.icons'), { recursive: true, force: true });

  const capabilities = platformProfile.capabilityOverrides;
  const metadata = capabilityMetadata(capabilities);
  const permissionXml = metadata.androidPermissions
    .map((name) => `    <uses-permission android:name="${xml(name)}" />`)
    .join('\n');
  const featureXml = metadata.androidFeatures
    .map((name) => `    <uses-feature android:name="${xml(name)}" android:required="false" />`)
    .join('\n');
  const orientation =
    displayGeometry.orientation === 'portrait' ? 'sensorPortrait' : 'sensorLandscape';
  const allowBackup = settings.app.android.allowBackup ?? false;
  const appCategory = (settings.app.android.isGame ?? true) ? ' android:appCategory="game"' : '';
  await writeFile(
    path.join(generatedRoot, 'AndroidManifest.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n${permissionXml ? `${permissionXml}\n` : ''}    <uses-feature android:glEsVersion="0x00030000" android:required="true" />\n${featureXml ? `${featureXml}\n` : ''}    <application android:allowBackup="${allowBackup}" android:dataExtractionRules="@xml/data_extraction_rules" android:fullBackupContent="@xml/backup_rules" android:hasCode="true" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" android:label="@string/noveltea_app_name" android:theme="@style/NovelTeaGeneratedTheme"${appCategory}>\n        <activity android:name="org.noveltea.player.MainActivity" android:configChanges="orientation|screenSize|screenLayout|keyboardHidden" android:exported="true" android:screenOrientation="${orientation}" android:theme="@style/NovelTeaGeneratedTheme">\n            <meta-data android:name="android.app.lib_name" android:value="noveltea-player" />\n            <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>\n        </activity>\n    </application>\n</manifest>\n`,
  );
  const background = settings.app.launchBackgroundColor ?? '#000000';
  await writeFile(
    path.join(resRoot, 'values', 'strings.xml'),
    `<resources><string name="noveltea_app_name">${xml(settings.app.displayName)}</string></resources>\n`,
  );
  await writeFile(
    path.join(resRoot, 'values', 'colors.xml'),
    `<resources><color name="noveltea_launch_background">${xml(background)}</color></resources>\n`,
  );
  await writeFile(
    path.join(resRoot, 'values', 'styles.xml'),
    '<resources><style name="NovelTeaGeneratedTheme" parent="android:Theme.NoTitleBar.Fullscreen"><item name="android:windowFullscreen">true</item><item name="android:windowBackground">@color/noveltea_launch_background</item></style></resources>\n',
  );
  await writeFile(
    path.join(resRoot, 'values-v31', 'styles.xml'),
    '<resources><style name="NovelTeaGeneratedTheme" parent="android:Theme.NoTitleBar.Fullscreen"><item name="android:windowSplashScreenBackground">@color/noveltea_launch_background</item><item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item><item name="android:windowFullscreen">true</item></style></resources>\n',
  );
  await writeFile(
    path.join(resRoot, 'xml', 'backup_rules.xml'),
    allowBackup
      ? '<full-backup-content />\n'
      : '<full-backup-content><exclude domain="root" path="." /></full-backup-content>\n',
  );
  await writeFile(
    path.join(resRoot, 'xml', 'data_extraction_rules.xml'),
    allowBackup
      ? '<data-extraction-rules><cloud-backup /><device-transfer /></data-extraction-rules>\n'
      : '<data-extraction-rules><cloud-backup><exclude domain="root" path="." /></cloud-backup><device-transfer><exclude domain="root" path="." /></device-transfer></data-extraction-rules>\n',
  );

  const packageHash = createHash('sha256')
    .update(await readFile(packagePath))
    .digest('hex');
  await writeFile(
    path.join(bootstrapRoot, 'player.json'),
    `${JSON.stringify(
      {
        format: 'noveltea.player-config',
        formatVersion: 2,
        displayName: settings.app.displayName,
        applicationId: settings.app.android.applicationId ?? settings.app.applicationId,
        saveNamespace: settings.app.saveNamespace,
        versionName: settings.app.versionName,
        ...(settings.app.defaultLocale ? { defaultLocale: settings.app.defaultLocale } : {}),
        package: { path: 'game.ntpkg', sha256: packageHash, runtimePackageApi: 2 },
        capabilities,
        display: {
          referenceResolution: { ...runtimeDisplay.reference_resolution },
          worldRasterPolicy: runtimeDisplay.world_raster_policy,
          barColor: runtimeDisplay.bar_color,
        },
        accessibility: {
          uiScale: { ...runtimeAccessibility.ui_scale },
          textScale: { ...runtimeAccessibility.text_scale },
        },
      },
      null,
      2,
    )}\n`,
  );

  const propertiesPath = path.join(generatedRoot, 'noveltea.properties');
  await writeFile(
    propertiesPath,
    [
      `novelteaApplicationId=${settings.app.android.applicationId ?? settings.app.applicationId}`,
      `novelteaVersionCode=${settings.app.android.versionCode ?? settings.app.buildNumber ?? 1}`,
      `novelteaVersionName=${settings.app.versionName}`,
      `novelteaAbi=${platformProfile.android.abi}`,
      `novelteaOrientation=${displayGeometry.orientation}`,
    ].join('\n') + '\n',
  );
  process.stdout.write(
    `${JSON.stringify({ generatedRoot, propertiesPath, applicationId: settings.app.android.applicationId ?? settings.app.applicationId })}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
